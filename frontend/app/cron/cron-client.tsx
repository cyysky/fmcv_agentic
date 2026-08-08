"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./cron.module.css";
import { apiFetch, apiError, errText } from "../../lib/api";
import { formatTime } from "../../lib/time";

/* ------------------------------- types ---------------------------------- */

interface CronJobRow {
  id: string;
  name: string;
  schedulerGroup: string;
  schedule: string;
  taskType: string;
  prompt: string;
  model: string | null;
  connectionId: string | null;
  maxSteps: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunModel: string | null;
  lastRunMs: number | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CronDraft {
  name: string;
  schedule: string;
  prompt: string;
  model: string;
  maxSteps: string;
  enabled: boolean;
}

interface SchedulerStatus {
  enabled: boolean;
  leaseHeld: boolean;
  leaseGroup: string;
  leaseExpireAt: string | null;
  tickIntervalMs: number;
  failoverMs: number;
  lastTickAt: string | null;
  jobCount: number;
  enabledCount: number;
}

interface CronOverviewLease {
  group: string;
  owner: string;
  expireAt: string | null;
  held: boolean;
  updatedAt: string | null;
}

interface CronOverviewEvent {
  id: string;
  group: string;
  event: "acquired" | "lost";
  owner: string;
  previousOwner: string | null;
  createdAt: string;
}

/** One page of the overview's paginated transition events (Round 78): the
 *  "load all for this group" pass walks `offset` pages of 100 until the
 *  group's `total` is exhausted or the safety cap is hit. */
interface CronOverviewEventPage {
  group: string | null;
  events: CronOverviewEvent[];
  total: number;
  offset: number;
  limit: number;
}

/** The in-memory result of a load-all pass (Round 78): every fetched event,
 *  the group total at fetch time, whether the whole history was loaded
 *  (false when the page cap cut the pass short), and the filter/depth the
 *  snapshot was captured under so a later filter/window change can ignore it
 *  during render instead of resetting state inside an effect. */
interface CronOverviewEventLoadAll {
  events: CronOverviewEvent[];
  total: number;
  complete: boolean;
  group: string | null;
  depth: number;
}

interface CronOverview {
  now: string;
  leases: CronOverviewLease[];
  events: CronOverviewEvent[];
  eventGroups: string[];
  eventStats: Array<{ group: string; total: number }>;
  jobGroups: Array<{
    group: string;
    jobs: number;
    enabled: number;
    running: number;
    due: number;
  }>;
  runs: {
    total: number;
    lastHour: number;
    byStatus: Array<{ status: string; count: number; avgMs: number | null }>;
    perJob: Array<{
      cronJobId: string;
      name: string | null;
      runCount: number;
      avgMs: number | null;
    }>;
  };
}

interface CronRunRow {
  id: string;
  cronJobId: string;
  status: string;
  message: string | null;
  model: string | null;
  ms: number | null;
  createdAt: string;
}

/** One loaded page of run history (Round 72). Round 75 adds the load-all
 *  view, which replaces the pager with the full history. */
interface CronRunPage {
  runs: CronRunRow[];
  page: number;
  hasMore: boolean;
  /** true when this batch is the whole-history load-all view (Round 75). */
  all?: boolean;
  /** true when every run was loaded; false when the safety cap cut it short. */
  allComplete?: boolean;
}

const EMPTY_DRAFT: CronDraft = {
  name: "",
  schedule: "*/15 * * * *",
  prompt: "",
  model: "",
  maxSteps: "",
  enabled: true,
};

const SCHEDULE_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
/** History page size (Round 72): the list pages through the API's Round 68
 *  limit/offset pagination with this many rows per page. */
const RUNS_PAGE_SIZE = 20;
/** Load-all page cap (Round 75): "Load all runs" fetches at most this many
 *  20-row pages so a pathologically deep history stays bounded; when the cap
 *  is hit the label says "First N runs" instead of "All N runs". */
const RUNS_ALL_PAGE_CAP = 10;

/** Transition window depths offered by the cluster overview selector
 *  (Round 76); the backend clamps ?limit= to 1..100 so 100 is the deepest
 *  selectable window. */
const OVERVIEW_EVENT_LIMITS = [10, 25, 50, 100] as const;
const OVERVIEW_EVENT_LIMIT_DEFAULT = OVERVIEW_EVENT_LIMITS[0];
/** Load-all page size (Round 78): each /overview/events page requests the
 *  backend's 100-event maximum. */
const OVERVIEW_EVENT_PAGE_SIZE = 100;
/** Load-all page cap (Round 78): "Load all for this group" fetches at most
 *  this many pages so a pathologically deep failover history stays bounded;
 *  when the cap is hit the label says "first N of M" instead of "all M". */
const OVERVIEW_EVENT_ALL_PAGE_CAP = 5;

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
};

/* ------------------------------ component ------------------------------- */

export default function CronPanel() {
  const [jobs, setJobs] = useState<CronJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Round 83: preview the job list to one lease group (null = all groups);
  // the overview's "Jobs by group" row is the source of truth for options.
  const [jobGroupFilter, setJobGroupFilter] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [schedulerError, setSchedulerError] = useState(false);
  const [overview, setOverview] = useState<CronOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  // Round 73: which lease group's transition events to show (null = all).
  const [eventGroupFilter, setEventGroupFilter] = useState<string | null>(null);
  // Transition window depth (Round 76): how many newest events the overview
  // fetches, for All and per-group views alike.
  const [eventWindowDepth, setEventWindowDepth] = useState<number>(
    OVERVIEW_EVENT_LIMIT_DEFAULT,
  );
  // Round 78: full-history "load all for this group" pass. While non-null,
  // the Transitions line renders this paginated snapshot instead of the
  // depth-limited window.
  const [eventLoadAll, setEventLoadAll] =
    useState<CronOverviewEventLoadAll | null>(null);
  const [eventLoadAllBusy, setEventLoadAllBusy] = useState(false);
  const [eventLoadAllError, setEventLoadAllError] = useState<string | null>(
    null,
  );
  // Round 78: a full-history snapshot is only rendered while its captured
  // filter/depth match the current selection; a stale one is treated as
  // absent so the depth-limited window (and its load-all button) come back
  // without resetting state inside an effect.
  const eventLoadAllActive =
    eventLoadAll &&
    eventLoadAll.group === eventGroupFilter &&
    eventLoadAll.depth === eventWindowDepth
      ? eventLoadAll
      : null;

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CronJobRow | null>(null);
  const [draft, setDraft] = useState<CronDraft>(EMPTY_DRAFT);
  const [formBusy, setFormBusy] = useState(false);

  const [actionKey, setActionKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [runsByJob, setRunsByJob] = useState<Record<string, CronRunPage | null>>({});
  const [runsLoading, setRunsLoading] = useState<string | null>(null);

  // Load the job list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await apiFetch(
          jobGroupFilter ? `/cron?group=${encodeURIComponent(jobGroupFilter)}` : "/cron",
        );
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as CronJobRow[];
        if (cancelled) return;
        setJobs(body);
      } catch (e) {
        if (cancelled) return;
        setJobs([]);
        setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, jobGroupFilter]);

  // Scheduler/lease status (Round 66) + cluster overview (Round 69):
  // refresh every 5 s so lease failover and run throughput stay current
  // without a page reload. Round 73: a per-group event filter re-fetches
  // the overview immediately and the poll keeps the filtered view fresh.
  useEffect(() => {
    let cancelled = false;
    // Independent sequence guards per feed: the scheduler status and the
    // overview event window are separate responses, so sharing one counter
    // lets one feed's newer request silently discard the other's result
    // (Round 82: the chip stayed empty even though /cron/scheduler 200'd).
    let schedulerSeq = 0;
    let overviewSeq = 0;
    const load = async () => {
      const seq = ++schedulerSeq;
      try {
        const res = await apiFetch("/cron/scheduler");
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as SchedulerStatus;
        if (!cancelled && seq === schedulerSeq) {
          setScheduler(body);
          setSchedulerError(false);
        }
      } catch {
        if (!cancelled && seq === schedulerSeq) setSchedulerError(true);
      }
    };
    const loadOverview = async () => {
      const seq = ++overviewSeq;
      try {
        const res = await apiFetch(
          `/cron/overview?limit=${eventWindowDepth}${
            eventGroupFilter ? `&group=${encodeURIComponent(eventGroupFilter)}` : ""
          }`,
        );
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as CronOverview;
        // Only the newest requested response may render: an in-flight poll
        // started before a filter click/seeded event must not clobber the
        // fresher result (Round 74).
        if (!cancelled && seq === overviewSeq) {
          setOverview(body);
          setOverviewError(false);
        }
      } catch {
        if (!cancelled && seq === overviewSeq) setOverviewError(true);
      }
    };
    void load();
    void loadOverview();
    const timer = setInterval(() => {
      void load();
      void loadOverview();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventGroupFilter, eventWindowDepth]);

  // Two-click delete disarm after a few seconds.
  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 5000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  // Page one history page through the API's limit/offset pagination
  // (Round 72): a full page means older runs may exist.
  const fetchRunPage = useCallback(
    async (id: string, page: number): Promise<CronRunPage> => {
      const res = await apiFetch(
        `/cron/${id}/runs?limit=${RUNS_PAGE_SIZE}&offset=${page * RUNS_PAGE_SIZE}`,
      );
      if (!res.ok) throw new Error(await apiError(res));
      const runs = (await res.json()) as CronRunRow[];
      return { runs, page, hasMore: runs.length === RUNS_PAGE_SIZE };
    },
    [],
  );

  // Load-all view (Round 75): fetch every page until a short page or the
  // safety cap, so a deep history can be scanned in one scroll instead of
  // clicking Newer back page by page. Page size stays inside the backend's
  // limit clamp, so no API contract change is needed.
  const fetchAllRuns = useCallback(
    async (id: string): Promise<CronRunPage> => {
      const collected: CronRunRow[] = [];
      for (let page = 0; page < RUNS_ALL_PAGE_CAP; page++) {
        const res = await apiFetch(
          `/cron/${id}/runs?limit=${RUNS_PAGE_SIZE}&offset=${page * RUNS_PAGE_SIZE}`,
        );
        if (!res.ok) throw new Error(await apiError(res));
        const rows = (await res.json()) as CronRunRow[];
        collected.push(...rows);
        if (rows.length < RUNS_PAGE_SIZE) break;
      }
      return {
        runs: collected,
        page: 0,
        hasMore: false,
        all: true,
        allComplete: collected.length < RUNS_PAGE_SIZE * RUNS_ALL_PAGE_CAP,
      };
    },
    [],
  );

  // Load-all transitions (Round 78): page through every event for the
  // selected filter (or all groups) and swap the Transitions line to the
  // full-history view. Mirrors the run-history load-all — pages of 100
  // inside the API's clamp, bounded by OVERVIEW_EVENT_ALL_PAGE_CAP — so
  // deep failover histories can be scanned without unbounded payloads.
  const loadAllEvents = useCallback(async () => {
    if (eventLoadAllBusy) return;
    setEventLoadAllBusy(true);
    setEventLoadAllError(null);
    try {
      const group = eventGroupFilter;
      const depth = eventWindowDepth;
      const collected: CronOverviewEvent[] = [];
      let total = 0;
      for (let page = 0; page < OVERVIEW_EVENT_ALL_PAGE_CAP; page++) {
        const res = await apiFetch(
          `/cron/overview/events?limit=${OVERVIEW_EVENT_PAGE_SIZE}&offset=${
            page * OVERVIEW_EVENT_PAGE_SIZE
          }${group ? `&group=${encodeURIComponent(group)}` : ""}`,
        );
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as CronOverviewEventPage;
        total = body.total;
        collected.push(...body.events);
        if (body.events.length < OVERVIEW_EVENT_PAGE_SIZE) break;
      }
      setEventLoadAll({
        events: collected,
        total,
        complete: collected.length === total,
        group,
        depth,
      });
    } catch (e) {
      setEventLoadAllError(errText(e));
    } finally {
      setEventLoadAllBusy(false);
    }
  }, [eventGroupFilter, eventWindowDepth, eventLoadAllBusy]);

  // Auto-refresh expanded run histories (Round 70, page-aware in Round 72):
  // while a history list is open, re-fetch its current page every 5 s and
  // also refresh right after a manual run returns, so a freshly completed
  // run appears on page one without collapsing and reopening the toggle.
  const runsByJobRef = useRef(runsByJob);
  useEffect(() => {
    runsByJobRef.current = runsByJob;
  }, [runsByJob]);
  const refreshExpandedRuns = useCallback(async () => {
    const expanded = Object.entries(runsByJobRef.current)
      .filter(([, page]) => page !== null)
      .map(([id, page]) => [id, page!.page, page!.all === true] as const);
    await Promise.all(
      expanded.map(async ([id, page, all]) => {
        try {
          const next = all ? await fetchAllRuns(id) : await fetchRunPage(id, page);
          setRunsByJob((m) => {
            if (m[id] === null) return m;
            // A stale poll must not clobber a page the user just navigated
            // to via Older/Newer/Jump to newest/load-all (Rounds 74-75);
            // skip when the open list moved or changed view while fetching.
            if (m[id].page !== page || (m[id].all === true) !== all) return m;
            return { ...m, [id]: next };
          });
        } catch {
          // Keep the last known list: a transient poll failure must not
          // clobber an open history list or spam the error banner.
        }
      }),
    );
  }, [fetchRunPage, fetchAllRuns]);
  useEffect(() => {
    const timer = setInterval(() => void refreshExpandedRuns(), 5000);
    return () => clearInterval(timer);
  }, [refreshExpandedRuns]);

  const refresh = () => setReloadKey((k) => k + 1);

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setShowForm(true);
    setError(null);
    setNotice(null);
  };

  const openEdit = (job: CronJobRow) => {
    setEditing(job);
    setDraft({
      name: job.name,
      schedule: job.schedule,
      prompt: job.prompt,
      model: job.model ?? "",
      maxSteps: job.maxSteps === null ? "" : String(job.maxSteps),
      enabled: job.enabled,
    });
    setShowForm(true);
    setError(null);
    setNotice(null);
  };

  const submitForm = async () => {
    const name = draft.name.trim();
    const schedule = draft.schedule.trim();
    const prompt = draft.prompt.trim();
    setFormBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!name) throw new Error("Name is required");
      if (!SCHEDULE_RE.test(schedule)) {
        throw new Error(
          "Schedule must be five cron fields: minute hour day-of-month month day-of-week",
        );
      }
      if (!prompt) throw new Error("Prompt is required");
      const maxSteps = draft.maxSteps.trim() ? Number(draft.maxSteps.trim()) : undefined;
      if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20)) {
        throw new Error("Max steps must be an integer from 1 to 20");
      }
      const payload: Record<string, unknown> = {
        name,
        schedule,
        prompt,
        model: draft.model.trim() || undefined,
        enabled: draft.enabled,
      };
      if (maxSteps !== undefined) payload.maxSteps = maxSteps;
      else if (editing) payload.maxSteps = null;

      const res = editing
        ? await apiFetch(`/cron/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetch("/cron", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error(await apiError(res));
      setShowForm(false);
      setEditing(null);
      setDraft(EMPTY_DRAFT);
      setNotice(editing ? `Saved job ${draft.name}` : `Created job ${draft.name}`);
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setFormBusy(false);
    }
  };

  const runNow = async (job: CronJobRow) => {
    setActionKey(`run:${job.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/cron/${job.id}/run`, { method: "POST" });
      if (!res.ok) throw new Error(await apiError(res));
      const row = (await res.json()) as CronJobRow;
      setNotice(
        row.lastRunStatus === "done"
          ? `Ran ${job.name} — ${row.lastRunStatus} in ${formatDuration(row.lastRunMs)}`
          : `Ran ${job.name} — ${row.lastRunStatus ?? "unknown"}`,
      );
      refresh();
      void refreshExpandedRuns();
    } catch (e) {
      setError(errText(e));
    } finally {
      setActionKey(null);
    }
  };

  const toggleEnabled = async (job: CronJobRow) => {
    setActionKey(`toggle:${job.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/cron/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      if (!res.ok) throw new Error(await apiError(res));
      setNotice(job.enabled ? `Paused ${job.name}` : `Resumed ${job.name}`);
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setActionKey(null);
    }
  };

  const deleteJob = async (job: CronJobRow) => {
    if (confirmDeleteId !== job.id) {
      setConfirmDeleteId(job.id);
      setNotice(null);
      return;
    }
    setActionKey(`delete:${job.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/cron/${job.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await apiError(res));
      setConfirmDeleteId(null);
      setNotice(`Deleted job ${job.name}`);
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setActionKey(null);
    }
  };

  const toggleRuns = async (job: CronJobRow) => {
    if (runsByJob[job.id]) {
      setRunsByJob((m) => ({ ...m, [job.id]: null }));
      return;
    }
    setRunsLoading(job.id);
    setError(null);
    setNotice(null);
    try {
      const page = await fetchRunPage(job.id, 0);
      setRunsByJob((m) => ({ ...m, [job.id]: page }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunsLoading(null);
    }
  };

  /** Flip the open history list to an adjacent page (Round 72). */
  const goRunPage = async (job: CronJobRow, page: number) => {
    if (page < 0) return;
    setRunsLoading(job.id);
    setError(null);
    setNotice(null);
    try {
      const next = await fetchRunPage(job.id, page);
      setRunsByJob((m) => (m[job.id] === null ? m : { ...m, [job.id]: next }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunsLoading(null);
    }
  };

  /** Switch an open history list to the load-all view (Round 75). */
  const loadAllRuns = async (job: CronJobRow) => {
    setRunsLoading(job.id);
    setError(null);
    setNotice(null);
    try {
      const next = await fetchAllRuns(job.id);
      setRunsByJob((m) => (m[job.id] === null ? m : { ...m, [job.id]: next }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunsLoading(null);
    }
  };

  const statusClass = (job: CronJobRow): string => {
    if (!job.enabled) return styles.statusPaused;
    if (job.lastRunStatus === "running") return styles.statusRunning;
    if (job.lastRunStatus === "error") return styles.statusError;
    if (job.lastRunStatus === "done") return styles.statusDone;
    return styles.statusIdle;
  };

  const eventTotals = new Map(
    (overview?.eventStats ?? []).map((stat) => [stat.group, stat.total] as const),
  );
  const eventTotalAll = [...eventTotals.values()].reduce((sum, n) => sum + n, 0);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Cron Jobs</h1>
          <p className={styles.subtitle}>
            Schedule recurring agent tasks with five-field cron expressions.
          </p>
          <div className={styles.schedulerRow}>
            {scheduler ? (
              <>
                {scheduler.enabled === false ? (
                  <span
                    className={`${styles.schedulerChip} ${styles.schedulerStandby}`}
                    title="This backend runs in API-only mode (CRON_SCHEDULER_ENABLED=false): no background scheduler, no lease, no boot recovery; CRUD and Run now still work."
                  >
                    Scheduler disabled — API-only
                  </span>
                ) : (
                  <span
                    className={`${styles.schedulerChip} ${
                      scheduler.leaseHeld
                        ? styles.schedulerActive
                        : styles.schedulerStandby
                    }`}
                    title={
                      scheduler.leaseHeld
                        ? "This backend replica owns the scheduler lease; due jobs fire here with failover in ~5 s."
                        : "Another backend replica owns the scheduler lease; this node stands by (failover in ~5 s) but still serves CRUD and Run now."
                    }
                  >
                    {scheduler.leaseHeld
                      ? "Scheduler active on this node"
                      : "Scheduler standby — lease held elsewhere"}
                  </span>
                )}
                <span className={styles.schedulerMeta}>
                  {scheduler.enabled === false
                    ? "no lease · no background firing"
                    : `last beat ${scheduler.lastTickAt ? formatTime(scheduler.lastTickAt) : "—"}`}
                  {scheduler.enabled !== false &&
                    scheduler.leaseHeld &&
                    scheduler.leaseExpireAt &&
                    ` · lease to ${formatTime(scheduler.leaseExpireAt)}`}
                </span>
              </>
            ) : schedulerError ? (
              <span className={styles.schedulerMeta}>Scheduler status unavailable</span>
            ) : null}
          </div>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.btnGhost} onClick={refresh}>
            Refresh
          </button>
        </div>
      </header>

      {overview ? (
        <section className={styles.overview} data-testid="cron-overview">
          <h2 className={styles.overviewTitle}>Cluster overview</h2>
          <div className={styles.overviewRow}>
            <span className={styles.overviewLabel}>Lease groups:</span>
            {overview.leases.length === 0 ? (
              <span className={styles.schedulerMeta}>No lease rows yet</span>
            ) : (
              overview.leases.map((lease) => (
                <span
                  key={lease.group}
                  className={`${styles.schedulerChip} ${
                    scheduler?.enabled === false
                      ? styles.schedulerStandby
                      : lease.held
                        ? styles.schedulerActive
                        : styles.schedulerStandby
                  }`}
                  title={
                    scheduler?.enabled === false
                      ? `Group ${lease.group} · API-only backend (CRON_SCHEDULER_ENABLED=false) — no lease`
                      : `Group ${lease.group} · owner ${lease.owner} · lease ${
                          lease.held ? "held" : "expired"
                        } to ${formatTime(lease.expireAt)}`
                  }
                >
                  {scheduler?.enabled === false
                    ? `${lease.group} · disabled · no lease`
                    : `${lease.group} · ${lease.held ? "active" : "expired"} · ${lease.owner}`}
                </span>
              ))
            )}
          </div>
          <div className={styles.overviewRow}>
            <span className={styles.overviewLabel}>Jobs by group:</span>
            {overview.jobGroups.length === 0 ? (
              <span className={styles.schedulerMeta}>No cron jobs yet</span>
            ) : (
              overview.jobGroups.map((owned) => (
                <span
                  key={owned.group}
                  className={`${styles.schedulerChip} ${styles.jobOwnershipChip}`}
                  title={`Group ${owned.group} · ${owned.jobs} job(s) · ${owned.enabled} enabled · ${owned.running} running · ${owned.due} due now`}
                  data-testid="overview-job-group"
                  data-job-group={owned.group}
                  data-jobs={owned.jobs}
                  data-enabled={owned.enabled}
                  data-running={owned.running}
                  data-due={owned.due}
                >
                  {owned.group} · {owned.jobs} job{owned.jobs === 1 ? "" : "s"} ·{" "}
                  {owned.enabled} enabled · {owned.running} running ·{" "}
                  {owned.due} due
                </span>
              ))
            )}
          </div>
          <div className={styles.overviewRow}>
            <span className={styles.overviewLabel}>Transitions:</span>
            {overview.eventGroups.length > 1 && (
              <span
                className={styles.overviewFilter}
                data-testid="overview-event-filter"
              >
                <button
                  type="button"
                  className={`${styles.btnGhost} ${
                    eventGroupFilter === null
                      ? styles.overviewFilterActive
                      : ""
                  }`}
                  aria-pressed={eventGroupFilter === null}
                  data-event-group="all"
                  data-event-total={eventTotalAll}
                  onClick={() => setEventGroupFilter(null)}
                >
                  All ({eventTotalAll})
                </button>
                {overview.eventGroups.map((group) => (
                  <button
                    key={group}
                    type="button"
                    className={`${styles.btnGhost} ${
                      eventGroupFilter === group
                        ? styles.overviewFilterActive
                        : ""
                    }`}
                    aria-pressed={eventGroupFilter === group}
                    data-event-group={group}
                    data-event-total={eventTotals.get(group) ?? 0}
                    onClick={() => setEventGroupFilter(group)}
                  >
                    {group} ({eventTotals.get(group) ?? 0})
                  </button>
                ))}
              </span>
            )}
            {overview.eventGroups.length > 0 && (
              <span className={styles.schedulerMeta}> · window:</span>
            )}
            {overview.eventGroups.length > 0 && (
              <select
                className={styles.select}
                data-event-depth={eventWindowDepth}
                data-testid="overview-event-depth"
                aria-label="Transition window depth"
                value={eventWindowDepth}
                onChange={(e) => setEventWindowDepth(Number(e.target.value))}
              >
                {OVERVIEW_EVENT_LIMITS.map((depth) => (
                  <option key={depth} value={depth}>
                    newest {depth}
                  </option>
                ))}
              </select>
            )}
            {eventLoadAllActive ? (
              <span
                className={styles.overviewStat}
                data-testid="overview-events-all"
                data-shown={eventLoadAllActive.events.length}
                data-total={eventLoadAllActive.total}
                data-complete={eventLoadAllActive.complete}
              >
                {eventLoadAllActive.events.map((evt, index) => (
                  <span
                    key={evt.id}
                    title={`${evt.group} · ${evt.event} · owner ${evt.owner}${
                      evt.previousOwner
                        ? ` · previous ${evt.previousOwner}`
                        : ""
                    } at ${formatTime(evt.createdAt)}`}
                  >
                    {index > 0 ? " · " : ""}
                    {evt.group} · {evt.event} · {evt.owner.slice(0, 8)}…
                    {evt.previousOwner
                      ? ` (was ${evt.previousOwner.slice(0, 8)}…)`
                      : ""}{" "}
                    · {formatTime(evt.createdAt)}
                  </span>
                ))}
              </span>
            ) : overview.events.length === 0 ? (
              <span className={styles.schedulerMeta}>
                none recorded yet
              </span>
            ) : (
              <span className={styles.overviewStat}>
                {overview.events.map((evt, index) => (
                  <span
                    key={evt.id}
                    title={`${evt.group} · ${evt.event} · owner ${evt.owner}${
                      evt.previousOwner
                        ? ` · previous ${evt.previousOwner}`
                        : ""
                    } at ${formatTime(evt.createdAt)}`}
                  >
                    {index > 0 ? " · " : ""}
                    {evt.group} · {evt.event} · {evt.owner.slice(0, 8)}…
                    {evt.previousOwner
                      ? ` (was ${evt.previousOwner.slice(0, 8)}…)`
                      : ""}{" "}
                    · {formatTime(evt.createdAt)}
                  </span>
                ))}
              </span>
            )}
            {overview.events.length > 0 && (
              <span
                className={styles.schedulerMeta}
                data-event-window={`${
                  eventLoadAllActive
                    ? eventLoadAllActive.events.length
                    : overview.events.length
                }:${
                  eventLoadAllActive
                    ? eventLoadAllActive.total
                    : eventGroupFilter
                      ? eventTotals.get(eventGroupFilter) ?? 0
                      : eventTotalAll
                }`}
              >
                {" "}·{" "}
                {eventLoadAllActive
                  ? eventLoadAllActive.complete
                    ? `all ${eventLoadAllActive.total} transitions`
                    : `first ${eventLoadAllActive.events.length} of ${eventLoadAllActive.total} transitions`
                  : `newest ${overview.events.length} of ${
                      eventGroupFilter
                        ? eventTotals.get(eventGroupFilter) ?? 0
                        : eventTotalAll
                    } transitions`}
                {eventGroupFilter ? ` for ${eventGroupFilter}` : ""}
              </span>
            )}
            {overview.events.length > 0 &&
              (eventLoadAllActive ? (
                <button
                  type="button"
                  className={styles.btnGhost}
                  data-testid="overview-events-all-back"
                  onClick={() => {
                    setEventLoadAll(null);
                    setEventLoadAllError(null);
                  }}
                >
                  {" "}· back to newest {eventWindowDepth}
                </button>
              ) : eventLoadAllBusy ? (
                <span className={styles.schedulerMeta}>loading all…</span>
              ) : overview.events.length <
                (eventGroupFilter
                  ? eventTotals.get(eventGroupFilter) ?? 0
                  : eventTotalAll) ? (
                <button
                  type="button"
                  className={styles.btnGhost}
                  data-testid="overview-events-load-all"
                  data-group={eventGroupFilter ?? "all"}
                  data-shown={overview.events.length}
                  data-total={
                    eventGroupFilter
                      ? eventTotals.get(eventGroupFilter) ?? 0
                      : eventTotalAll
                  }
                  onClick={() => void loadAllEvents()}
                  disabled={eventLoadAllBusy}
                >
                  {" "}·{" "}
                  {eventGroupFilter
                    ? "Load all for this group"
                    : "Load all transitions"}
                </button>
              ) : null)}
            {eventLoadAllError && (
              <span className={styles.schedulerMeta}>{eventLoadAllError}</span>
            )}
          </div>
          <div className={styles.overviewRow}>
            <span className={styles.overviewLabel}>Runs:</span>
            <span className={styles.overviewStat}>
              {overview.runs.total} total · {overview.runs.lastHour} in the
              last hour
              {overview.runs.byStatus.map((stat) => (
                <span key={stat.status}>
                  {" "}
                  · {stat.count}{" "}
                  {(STATUS_LABEL[stat.status] ?? stat.status).toLowerCase()}
                </span>
              ))}
            </span>
          </div>
          {overview.runs.perJob.length > 0 && (
            <div className={styles.overviewRow}>
              <span className={styles.overviewLabel}>Busiest jobs:</span>
              <span className={styles.overviewStat}>
                {overview.runs.perJob.map((job, index) => (
                  <span key={job.cronJobId}>
                    {index > 0 ? " · " : ""}
                    {job.name ?? job.cronJobId} ({job.runCount})
                  </span>
                ))}
              </span>
            </div>
          )}
        </section>
      ) : overviewError ? (
        <div className={styles.schedulerRow}>
          <span className={styles.schedulerMeta}>
            Cluster overview unavailable
          </span>
        </div>
      ) : null}

      {(error || notice) && (
        <button
          className={error ? styles.errorBanner : styles.successBanner}
          title="Dismiss"
          onClick={() => {
            setError(null);
            setNotice(null);
          }}
        >
          {error ?? notice}
        </button>
      )}

      <div className={styles.toolbar}>
        <label
          className={styles.fieldLabel}
          style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
        >
          Group:
          <select
            className={styles.select}
            aria-label="Cron job group filter"
            data-testid="job-group-filter"
            value={jobGroupFilter ?? ""}
            onChange={(e) => setJobGroupFilter(e.target.value || null)}
          >
            <option value="">All groups</option>
            {(overview?.jobGroups ?? []).map((owned) => (
              <option key={owned.group} value={owned.group}>
                {owned.group} · {owned.jobs} job{owned.jobs === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        <button
          className={styles.btnPrimary}
          onClick={() => {
            if (showForm) {
              setShowForm(false);
              setEditing(null);
            } else {
              openCreate();
            }
          }}
        >
          {showForm ? "Hide form" : "New cron job"}
        </button>
      </div>

      {showForm && (
        <form
          className={styles.panel}
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm();
          }}
        >
          <div className={styles.panelTitle}>
            {editing ? `Edit ${editing.name}` : "New cron job"}
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <input
              aria-label="Cron job name"
              className={styles.input}
              value={draft.name}
              placeholder="daily-digest"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Schedule</span>
            <input
              aria-label="Cron schedule"
              className={styles.input}
              value={draft.schedule}
              placeholder="*/15 * * * *"
              onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}
            />
            <span className={styles.help}>
              Five fields — minute hour day-of-month month day-of-week. E.g.{" "}
              <code>*/15 * * * *</code> runs every 15 minutes,{" "}
              <code>0 9 * * 1-5</code> runs weekdays at 09:00.
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Prompt</span>
            <textarea
              aria-label="Cron prompt"
              className={styles.textarea}
              value={draft.prompt}
              placeholder="Ask the agent to do something on every run, e.g. Summarize this week's channel activity."
              rows={3}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Model (optional)</span>
              <input
                aria-label="Cron model"
                className={styles.input}
                value={draft.model}
                placeholder="ds4-flash"
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Max steps (1–20)</span>
              <input
                aria-label="Cron max steps"
                className={styles.input}
                value={draft.maxSteps}
                placeholder="10"
                inputMode="numeric"
                onChange={(e) =>
                  setDraft({ ...draft, maxSteps: e.target.value })
                }
              />
            </label>
          </div>
          <label className={styles.checkRow}>
            <input
              aria-label="Cron enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            Enabled (schedule starts immediately)
          </label>
          <div className={styles.panelActions}>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={formBusy}
            >
              {formBusy ? "Saving…" : editing ? "Save changes" : "Create job"}
            </button>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading && jobs.length === 0 ? (
        <div className={styles.muted}>Loading…</div>
      ) : jobs.length === 0 && !error ? (
        <div className={styles.muted}>
          No cron jobs yet. Create one to schedule a recurring agent task.
        </div>
      ) : (
        <ul className={styles.list}>
          {jobs.map((job) => {
            const runPage = runsByJob[job.id] ?? null;
            return (
            <li key={job.id} className={styles.row} data-name={job.name}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitleLine}>
                  <span className={styles.rowName}>{job.name}</span>
                  <span className={`${styles.statusPill} ${statusClass(job)}`}>
                    {!job.enabled
                      ? "Paused"
                      : STATUS_LABEL[job.lastRunStatus ?? "idle"] ?? "Idle"}
                  </span>
                  <code className={styles.scheduleTag}>{job.schedule}</code>
                  <span
                    className={`${styles.schedulerChip} ${styles.jobOwnershipChip}`}
                    data-testid="job-group-badge"
                    data-job-group={job.schedulerGroup}
                    title={`Owned by lease group ${job.schedulerGroup}`}
                  >
                    {job.schedulerGroup}
                  </span>
                </div>
                <div className={styles.rowMeta}>
                  Last run {formatTime(job.lastRunAt)} ·{" "}
                  {job.lastRunStatus ? job.lastRunStatus : "never run"}
                  {job.lastRunStatus === "done" && ` · model ${job.lastRunModel ?? "?"}`}
                  {formatDuration(job.lastRunMs) &&
                    ` · ${formatDuration(job.lastRunMs)}`}
                </div>
                {job.lastRunMessage && (
                  <div className={styles.rowMessage} title={job.lastRunMessage}>
                    {job.lastRunMessage}
                  </div>
                )}
                <div className={styles.rowMeta}>
                  Next run:{" "}
                  {job.enabled ? formatTime(job.nextRunAt) : "paused"}
                </div>
                {runPage && (
                  <div
                    className={styles.runList}
                    data-runs={job.id}
                    data-runs-page={runPage.page}
                    data-runs-has-more={runPage.hasMore ? "1" : "0"}
                  >
                    {runPage.runs.length === 0 ? (
                      <div className={styles.muted}>No runs recorded yet.</div>
                    ) : (
                      runPage.runs.map((run) => (
                        <div
                          key={run.id}
                          className={styles.runRow}
                          data-run-status={run.status}
                        >
                          <span
                            className={`${styles.statusPill} ${
                              run.status === "done"
                                ? styles.statusDone
                                : styles.statusError
                            }`}
                          >
                            {run.status === "done" ? "Done" : "Failed"}
                          </span>
                          <span className={styles.runMeta}>
                            {formatTime(run.createdAt)}
                          </span>
                          {run.model && (
                            <span className={styles.runMeta}>· {run.model}</span>
                          )}
                          {formatDuration(run.ms) && (
                            <span className={styles.runMeta}>
                              · {formatDuration(run.ms)}
                            </span>
                          )}
                          {run.message && (
                            <span className={styles.rowMessage} title={run.message}>
                              {run.message}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                    {runPage.all ? (
                      <div className={styles.runPager} data-runs-all="1">
                        <button
                          className={styles.btnGhost}
                          data-paged-view="1"
                          disabled={runsLoading === job.id}
                          onClick={() => goRunPage(job, 0)}
                        >
                          Paged view
                        </button>
                        <span className={styles.runMeta}>
                          {runPage.allComplete ? "All" : "First"} {runPage.runs.length} runs
                        </span>
                      </div>
                    ) : (
                      (runPage.page > 0 || runPage.hasMore) && (
                        <div className={styles.runPager}>
                          {runPage.page > 0 && (
                            <>
                              <button
                                className={styles.btnGhost}
                                data-jump-newest="1"
                                disabled={runsLoading === job.id}
                                onClick={() => goRunPage(job, 0)}
                              >
                                Jump to newest
                              </button>
                              <button
                                className={styles.btnGhost}
                                disabled={runsLoading === job.id}
                                onClick={() => goRunPage(job, runPage.page - 1)}
                              >
                                Newer
                              </button>
                            </>
                          )}
                          <span className={styles.runMeta}>
                            Page {runPage.page + 1}
                          </span>
                          {runPage.hasMore && (
                            <button
                              className={styles.btnGhost}
                              data-load-all="1"
                              disabled={runsLoading === job.id}
                              onClick={() => loadAllRuns(job)}
                            >
                              Load all runs
                            </button>
                          )}
                          {runPage.hasMore && (
                            <button
                              className={styles.btnGhost}
                              disabled={runsLoading === job.id}
                              onClick={() => goRunPage(job, runPage.page + 1)}
                            >
                              Older
                            </button>
                          )}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
              <div className={styles.rowActions}>
                <button
                  className={styles.btnPrimary}
                  disabled={job.lastRunStatus === "running" || actionKey !== null}
                  onClick={() => runNow(job)}
                >
                  {actionKey === `run:${job.id}` ? "Running…" : "Run now"}
                </button>
                <button
                  className={styles.btnGhost}
                  disabled={actionKey !== null}
                  onClick={() => toggleEnabled(job)}
                >
                  {actionKey === `toggle:${job.id}`
                    ? "Saving…"
                    : job.enabled
                      ? "Pause"
                      : "Resume"}
                </button>
                <button
                  className={styles.btnGhost}
                  aria-label={`History for ${job.name}`}
                  disabled={actionKey !== null}
                  onClick={() => toggleRuns(job)}
                >
                  {runsLoading === job.id
                    ? "Loading…"
                    : runsByJob[job.id]
                      ? "Hide history"
                      : "History"}
                </button>
                <button
                  className={styles.btnGhost}
                  disabled={actionKey !== null}
                  onClick={() => openEdit(job)}
                >
                  Edit
                </button>
                <button
                  className={styles.btnDanger}
                  disabled={actionKey !== null}
                  onClick={() => deleteJob(job)}
                >
                  {actionKey === `delete:${job.id}`
                    ? "Deleting…"
                    : confirmDeleteId === job.id
                      ? "Confirm?"
                      : "Delete"}
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
