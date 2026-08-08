import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CronJob, CronRun, Prisma } from '@prisma/client';
import { CronExpressionParser } from 'cron-parser';
import { BaseAgentService } from '../agent/base-agent.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCronJobDto, UpdateCronJobDto } from './cron.dto';
import { randomUUID } from 'node:crypto';

/** Scheduler tick granularity; cron firing lands within this window. */
export const CRON_TICK_MS = 1000;
/**
 * Distributed scheduler lease (Round 65): the ticker runs only on the
 * replica that holds a fresh lease. A dead holder fails over after
 * LEASE_DURATION_MS; the lease is renewed atomically with each tick.
 */
export const CRON_LEASE_DURATION_MS = 5000;
/** Default scheduler lease group; override per deployment with
 *  CRON_LEASE_GROUP (e.g. an isolated group per e2e run). */
export const CRON_LEASE_GROUP = 'default';
/** Truncation cap for the run result stored/displayed on the job row. */
export const MAX_RUN_MESSAGE = 500;
/** Retention cap for per-job run history: keep only the newest runs. */
export const MAX_RUN_HISTORY = 100;
/** How many busiest jobs to surface in the cluster overview (Round 69). */
export const OVERVIEW_TOP_JOBS = 5;
/** How many recent lease transitions to surface in the overview by default
 *  (Round 71); the overview API accepts a client-chosen `?limit=` up to
 *  OVERVIEW_EVENT_LIMIT_MAX (Round 76). */
export const OVERVIEW_RECENT_EVENTS = 10;
/** Upper bound for the overview transition window (Round 76). */
export const OVERVIEW_EVENT_LIMIT_MAX = 100;
/** Agent-turn is the only supported task right now (DIRECTION item 2). */
export const TASK_TYPE_AGENT_TURN = 'agent-turn';
/** Terminal status written by this service when a run ends. */
export const STATUS_RUNNING = 'running';
/**
 * SQL-safe "not currently running" filter. Postgres evaluates
 * `NOT ("lastRunStatus" = 'running')` as NULL on never-run rows, so Prisma's
 * plain `{ not }` filter silently excludes fresh jobs with a NULL status.
 * Match both non-running and never-run rows explicitly.
 */
const NOT_RUNNING_FILTER = {
  OR: [{ lastRunStatus: { not: STATUS_RUNNING } }, { lastRunStatus: null }],
};

/** One scheduler lease group's current state (Round 69). */
export interface CronOverviewLease {
  group: string;
  owner: string;
  expireAt: string | null;
  held: boolean;
  updatedAt: string | null;
}

/** Aggregate run stats broken down by terminal status (Round 69). */
export interface CronRunStatusStat {
  status: string;
  count: number;
  avgMs: number | null;
}

/** Run volume for one job in the cluster overview (Round 69). */
export interface CronJobRunStat {
  cronJobId: string;
  name: string | null;
  runCount: number;
  avgMs: number | null;
}

/** One recorded lease transition for a scheduler group (Round 71). */
export interface CronOverviewEvent {
  id: string;
  group: string;
  event: 'acquired' | 'lost';
  owner: string;
  previousOwner: string | null;
  createdAt: string;
}

/** Total recorded transitions for one lease group, so the per-group event
 *  window (newest OVERVIEW_RECENT_EVENTS) is understandable next to the
 *  group's full history (Round 74). */
export interface CronOverviewEventStat {
  group: string;
  total: number;
}

/** One page of transition events for the cluster overview's per-group
 *  "load all for this group" pass (Round 78): events are newest-first with
 *  `offset`/`limit` paging inside the 1..100 clamp, so a group with more
 *  history than the overview window can be walked page by page without
 *  unbounded payloads. */
export interface CronOverviewEventPage {
  group: string | null;
  events: CronOverviewEvent[];
  total: number;
  offset: number;
  limit: number;
}

/** Cluster-wide scheduler observability payload (Round 69). */
export interface CronOverview {
  now: string;
  leases: CronOverviewLease[];
  events: CronOverviewEvent[];
  /** Lease groups that have transition history, for per-group filtering
   *  (Round 73). */
  eventGroups: string[];
  /** Per-group transition totals, so the UI can say "showing newest N of
   *  M transitions" and label filter chips with their history size (Round 74). */
  eventStats: CronOverviewEventStat[];
  runs: {
    total: number;
    lastHour: number;
    byStatus: CronRunStatusStat[];
    perJob: CronJobRunStat[];
  };
}

/** Parse `schedule` as a 5-field cron expression and return its next
 *  occurrence strictly after `from`. Throws a BadRequestException with a
 *  clear message when the expression is invalid. */
export function nextCronRun(
  schedule: string,
  from = new Date(Date.now() + CRON_TICK_MS),
): Date {
  try {
    const parsed = CronExpressionParser.parse(schedule.trim(), {
      currentDate: from,
    });
    return parsed.next().toDate();
  } catch (err) {
    throw new BadRequestException(
      `Invalid cron schedule "${schedule}": ${(err as Error).message}`,
    );
  }
}

/**
 * Flatten, trim, and cap a persisted message at `max` UTF-16 code units.
 * The ellipsis lives inside the cap and the cut never splits a surrogate
 * pair (e.g. an emoji straddling the boundary), so stored run messages stay
 * valid Unicode after truncation (Round 77).
 */
export function truncate(
  text: string | undefined | null,
  max: number,
): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  if (max < 1) return null;
  if (max === 1) return '…';
  let cut = max - 1; // reserve one code unit for the ellipsis
  // Back off over a high surrogate whose low partner would be cut away.
  if (
    cut > 0 &&
    (flat.charCodeAt(cut - 1) & 0xfc00) === 0xd800 &&
    (flat.charCodeAt(cut) & 0xfc00) === 0xdc00
  ) {
    cut -= 1;
  }
  return `${flat.slice(0, cut)}…`;
}

/**
 * Recurring cron jobs (DIRECTION.md item 2).
 *
 * A job runs a scheduled agent turn (`agent-turn` task): on each firing the
 * job's prompt is sent through BaseAgentService.runTurn (with the optional
 * pinned model/connection/maxSteps) and the terminal result is persisted on
 * the row as `lastRun*`. The scheduler is an in-process ticker that checks
 * due jobs every second; `nextRunAt` and `lastRun*` survive backend
 * restarts, and jobs left "running" by a crash are marked "error" on boot.
 */
@Injectable()
export class CronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronService.name);
  private ticker: NodeJS.Timeout | null = null;
  /** Unique owner id for the distributed scheduler lease. */
  private readonly leaseOwner = randomUUID();
  /**
   * API-only switch (Round 79): `CRON_SCHEDULER_ENABLED=false` keeps CRUD +
   * run-now reachable but disables the background scheduler entirely — no
   * lease acquisition, no tick, no boot-time recovery sweep. A shared-DB
   * deployment (or the live stack during local API E2E) can opt out of
   * background firing without stopping the server.
   */
  private readonly schedulerEnabled =
    (process.env.CRON_SCHEDULER_ENABLED?.trim() ?? 'true').toLowerCase() !==
    'false';
  /** True while this instance holds a fresh scheduler lease. */
  private leaseHeld = false;
  /** Expiry this instance last negotiated when claiming/renewing the lease. */
  private leaseExpiresAt: Date | null = null;
  /** Wall-clock time of this instance's most recent scheduler beat. */
  private lastTickAt: Date | null = null;
  /** In-memory mirror of cron rows so the per-second tick never hammers the DB. */
  private readonly jobs = new Map<string, CronJob>();
  /** Per-job concurrency guard (one in-flight execution per job). */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: BaseAgentService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.schedulerEnabled) {
      this.logger.log(
        'Cron scheduler disabled (CRON_SCHEDULER_ENABLED=false): API-only mode — no lease, no tick, no boot recovery sweep; manual run-now still works',
      );
      return;
    }
    // Row identity is the lease group itself (id is the PK). In Round 65 the
    // row id was a fixed 'singleton', which prevented more than one group
    // from ever inserting AND made the PK collide across groups. Sweep any
    // old-scheme rows for our group (safe now: new replicas come up after the
    // old holder is stopped, so nothing renews them).
    const group = process.env.CRON_LEASE_GROUP?.trim() || CRON_LEASE_GROUP;
    await this.prisma
      .$executeRaw`DELETE FROM cron_scheduler_leases WHERE "schedulerGroup" = ${group} AND id <> ${group}`.catch(
      (err) => {
        this.logger.warn(
          `Could not clean legacy cron lease rows: ${(err as Error).message}`,
        );
      },
    );
    await this.prisma.cronJob
      .updateMany({
        where: { lastRunStatus: STATUS_RUNNING },
        data: {
          lastRunStatus: 'error',
          lastRunMessage: 'Interrupted by backend restart',
        },
      })
      .catch((err) => {
        this.logger.warn(
          `Could not recover interrupted cron runs: ${(err as Error).message}`,
        );
      });

    let rows: CronJob[] = [];
    try {
      rows = await this.prisma.cronJob.findMany({
        orderBy: { createdAt: 'desc' },
      });
    } catch (err) {
      this.logger.warn(
        `Could not load cron jobs on startup: ${(err as Error).message}`,
      );
    }
    for (const row of rows) {
      this.jobs.set(row.id, row);
      if (row.enabled) {
        await this.recomputeNextRun(row.id).catch((err) => {
          this.logger.warn(
            `Could not schedule cron job ${row.id}: ${(err as Error).message}`,
          );
        });
      }
    }
    this.ticker = setInterval(() => {
      void this.tick();
    }, CRON_TICK_MS);
    this.ticker.unref();
    this.leaseHeld = await this.acquireLease();
    this.logger.log(
      `Cron scheduler started: ${rows.length} job(s), ${[...this.jobs.values()].filter((j) => j.enabled).length} enabled, tick ${CRON_TICK_MS}ms, scheduler lease ${this.leaseHeld ? 'held' : 'standby'}`,
    );
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /* ------------------------------ CRUD ------------------------------ */

  async create(dto: CreateCronJobDto): Promise<CronJob> {
    const name = dto.name.trim();
    const schedule = dto.schedule.trim();
    const enabled = dto.enabled ?? true;
    nextCronRun(schedule); // validate early and clearly
    await this.assertConnection(dto.connectionId);
    const nextRunAt = enabled ? nextCronRun(schedule) : null;
    let row: CronJob;
    try {
      row = await this.prisma.cronJob.create({
        data: {
          name,
          schedule,
          taskType: dto.taskType ?? TASK_TYPE_AGENT_TURN,
          prompt: dto.prompt,
          ...(dto.model?.trim() ? { model: dto.model.trim() } : {}),
          ...(dto.connectionId ? { connectionId: dto.connectionId } : {}),
          ...(dto.maxSteps ? { maxSteps: dto.maxSteps } : {}),
          enabled,
          nextRunAt,
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`Cron job name "${name}" already exists`);
      }
      throw err;
    }
    this.jobs.set(row.id, row);
    return row;
  }

  async list(): Promise<CronJob[]> {
    return this.prisma.cronJob.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async get(id: string): Promise<CronJob> {
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cron job ${id} not found`);
    this.jobs.set(row.id, row);
    return row;
  }

  async update(id: string, dto: UpdateCronJobDto): Promise<CronJob> {
    const existing = await this.get(id);
    if (!Object.values(dto).some((v) => v !== undefined)) {
      throw new BadRequestException('At least one field is required to update');
    }
    if (dto.schedule) {
      nextCronRun(dto.schedule.trim()); // validate early and clearly
    }
    const enabled = dto.enabled ?? existing.enabled;
    const scheduleChanged = dto.schedule !== undefined;
    let nextRunAt = existing.nextRunAt;
    if (dto.enabled === false) {
      nextRunAt = null;
    } else if (dto.enabled === true || (scheduleChanged && enabled)) {
      nextRunAt = nextCronRun((dto.schedule ?? existing.schedule).trim());
    }
    await this.assertConnection(dto.connectionId);
    const updated = await this.prisma.cronJob.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        schedule: dto.schedule?.trim(),
        taskType: dto.taskType,
        prompt: dto.prompt,
        model: dto.model === undefined ? undefined : dto.model.trim() || null,
        connectionId:
          dto.connectionId === undefined ? undefined : dto.connectionId || null,
        maxSteps:
          dto.maxSteps === undefined ? undefined : (dto.maxSteps ?? null),
        enabled: dto.enabled,
        nextRunAt,
      },
    });
    this.jobs.set(updated.id, updated);
    return updated;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const row = await this.get(id);
    const dbRow = await this.prisma.cronJob.findUnique({ where: { id } });
    const activeElsewhere =
      dbRow?.lastRunStatus === STATUS_RUNNING && !this.running.has(id);
    if (this.running.has(id) || activeElsewhere) {
      throw new ConflictException(
        `Cron job "${row.name}" is running; wait for it to finish before deleting`,
      );
    }
    await this.prisma.cronJob.delete({ where: { id } });
    this.jobs.delete(id);
    return { deleted: true };
  }

  /** Run a cron job immediately, outside its schedule. */
  async runNow(id: string): Promise<CronJob> {
    return this.executeJob(id);
  }

  /**
   * Recent terminal runs for a job, newest first, with offset pagination
   * (Round 68). Defaults: limit 20 (clamped 1-100), offset 0 (clamped >= 0).
   */
  async runs(id: string, limit = 20, offset = 0): Promise<CronRun[]> {
    await this.get(id); // 404 on an unknown job
    return this.prisma.cronRun.findMany({
      where: { cronJobId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(Math.trunc(limit) || 20, 1), 100),
      skip: Math.max(Math.trunc(offset) || 0, 0),
    });
  }

  /**
   * Paginated transition events for the cluster overview (Round 78): a
   * per-group "load all" pass pages through every event with limit/offset
   * inside the same 1..100 clamp as the overview window, and the response
   * carries the group's event total so the UI can say "all N" or "first N
   * of M" when the page cap cut the pass short.
   */
  async overviewEvents(
    group?: string,
    limit = OVERVIEW_RECENT_EVENTS,
    offset = 0,
  ): Promise<CronOverviewEventPage> {
    const eventLimit = Math.min(
      Math.max(Math.trunc(limit) || OVERVIEW_RECENT_EVENTS, 1),
      OVERVIEW_EVENT_LIMIT_MAX,
    );
    const skip = Math.max(Math.trunc(offset) || 0, 0);
    const where = group ? { schedulerGroup: group } : {};
    const [rows, total] = await Promise.all([
      this.prisma.cronSchedulerEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: eventLimit,
        skip,
      }),
      this.prisma.cronSchedulerEvent.count({ where }),
    ]);
    return {
      group: group ?? null,
      events: rows.map((event) => ({
        id: event.id,
        group: event.schedulerGroup,
        event: event.event as 'acquired' | 'lost',
        owner: event.owner,
        previousOwner: event.previousOwner,
        createdAt: event.createdAt.toISOString(),
      })),
      total,
      offset: skip,
      limit: eventLimit,
    };
  }

  /**
   * Retention cap (Round 68): after each terminal insert, keep only the
   * newest MAX_RUN_HISTORY runs for the job and prune the rest. Best
   * effort — a pruning failure is logged and never breaks the run result.
   */
  private async pruneRunHistory(id: string): Promise<void> {
    const keep = await this.prisma.cronRun.findMany({
      where: { cronJobId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      take: MAX_RUN_HISTORY,
    });
    await this.prisma.cronRun.deleteMany({
      where: { cronJobId: id, id: { notIn: keep.map((run) => run.id) } },
    });
  }

  /* ---------------------------- scheduler ---------------------------- */

  /**
   * Atomically claim/renew the distributed scheduler lease. Only one
   * replica (per schedulerGroup) gets a success per statement, so after a
   * holder dies and its lease expires a standby takes over within one tick.
   */
  private async acquireLease(): Promise<boolean> {
    const now = Date.now();
    const expireAt = new Date(now + CRON_LEASE_DURATION_MS);
    const group = process.env.CRON_LEASE_GROUP?.trim() || CRON_LEASE_GROUP;
    // Single atomic INSERT ... ON CONFLICT: insert this group's row when
    // missing; otherwise renew only when we already own it or its lease has
    // expired. A replica that loses the race simply stays in standby.
    const count = await this.prisma.$executeRaw`
        INSERT INTO cron_scheduler_leases (id, "schedulerGroup", owner, "expireAt", "createdAt", "updatedAt")
        VALUES (${group}, ${group}, ${this.leaseOwner}, ${expireAt}, now(), now())
        ON CONFLICT (id) DO UPDATE SET
          owner = EXCLUDED.owner,
          "expireAt" = EXCLUDED."expireAt",
          "updatedAt" = now()
        WHERE cron_scheduler_leases.owner = EXCLUDED.owner
           OR cron_scheduler_leases."expireAt" <= now()
      `;
    if (count === 1) {
      this.leaseExpiresAt = expireAt;
    }
    return count === 1;
  }

  private async tick(): Promise<void> {
    // Belt-and-braces: the ticker never starts in API-only mode, but a
    // stray direct call must not fire jobs either (Round 79).
    if (!this.schedulerEnabled) return;
    this.lastTickAt = new Date();
    // Only the replica holding a fresh lease fires due jobs. Standby
    // replicas keep serving CRUD/run-now and reclaim the lease on failover.
    const group = process.env.CRON_LEASE_GROUP?.trim() || CRON_LEASE_GROUP;
    // While standing by, learn who currently holds the lease so a takeover
    // can record the previous owner in the transition audit.
    const previousOwner = !this.leaseHeld
      ? await this.prisma.cronSchedulerLease
          .findUnique({ where: { id: group }, select: { owner: true } })
          .then((row) => row?.owner ?? null)
          .catch(() => null)
      : null;
    const held = await this.acquireLease();
    if (this.leaseHeld !== held) {
      const transition = held ? 'acquired' : 'lost';
      this.logger.log(
        held
          ? 'Cron scheduler lease acquired; taking over scheduled firing'
          : 'Cron scheduler lease lost; standing by',
      );
      // Append-only audit (Round 71): a failover shows up as an `acquired`
      // event whose previousOwner is the replica that died; `lost` records
      // this replica dropping a lease it previously held. Best effort — a
      // failed write is logged and never blocks the scheduler.
      await this.prisma.cronSchedulerEvent
        .create({
          data: {
            schedulerGroup: group,
            owner: this.leaseOwner,
            event: transition,
            previousOwner: held ? previousOwner : this.leaseOwner,
          },
        })
        .catch((err) => {
          this.logger.warn(
            `Could not record cron scheduler lease ${transition} event: ${(err as Error).message}`,
          );
        });
    }
    this.leaseHeld = held;
    if (!held) return;
    const now = Date.now();
    // Read the scheduler's view from the DB (multi-replica safe): the map is
    // only a cache; the DB is the source of truth for enabled/due/running.
    const due: Pick<CronJob, 'id'>[] = await this.prisma.cronJob.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: new Date(now) },
        ...NOT_RUNNING_FILTER,
      },
      select: { id: true },
    });
    for (const { id } of due) {
      this.executeJob(id).catch((err) => {
        this.logger.warn(
          `Could not fire cron job ${id}: ${(err as Error).message}`,
        );
      });
    }
  }

  private async executeJob(id: string): Promise<CronJob> {
    // Same-instance guard first (no await): a second runNow/delete on this
    // replica must not even reach the DB claim while this instance runs it.
    if (this.running.has(id)) {
      throw new ConflictException('Cron job is already running');
    }
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cron job ${id} not found`);
    const claimed = await this.prisma.cronJob.updateMany({
      where: {
        id,
        ...NOT_RUNNING_FILTER,
      },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: STATUS_RUNNING,
        lastRunMessage: null,
        lastRunModel: null,
        lastRunMs: null,
      },
    });
    if (claimed.count === 0) {
      // Another replica claimed this firing (run-now or a due tick with
      // split-brain leases); never run it twice in the cluster.
      throw new ConflictException(`Cron job "${row.name}" is already running`);
    }
    this.running.add(id);
    const startedAt = Date.now();
    try {
      let result: { answer: string; model: string };
      try {
        result = await this.agent.runTurn({
          message: row.prompt,
          ...(row.model ? { model: row.model } : {}),
          ...(row.connectionId ? { connectionId: row.connectionId } : {}),
          maxSteps: row.maxSteps ?? 10,
        });
      } catch (err) {
        await this.recordResult(
          id,
          'error',
          (err as Error).message,
          undefined,
          Date.now() - startedAt,
        );
        return this.refreshed(id);
      }
      await this.recordResult(
        id,
        'done',
        result.answer,
        result.model,
        Date.now() - startedAt,
      );
      return this.refreshed(id);
    } finally {
      this.running.delete(id);
    }
  }

  /** Persist a terminal run result and slide the scheduler to the next slot. */
  private async recordResult(
    id: string,
    status: 'done' | 'error',
    message: string | undefined,
    model: string | undefined,
    ms: number,
  ): Promise<void> {
    // The firing replica may not have this row cached (a job created on a
    // different replica gets fired by the lease holder), so derive the next
    // slot from the DB row, not the in-memory mirror.
    const current =
      this.jobs.get(id) ??
      (await this.prisma.cronJob
        .findUnique({ where: { id } })
        .catch(() => null));
    const updated = await this.prisma.cronJob.updateMany({
      where: {
        id,
        lastRunStatus: STATUS_RUNNING,
      },
      data: {
        lastRunStatus: status,
        lastRunMessage: truncate(message, MAX_RUN_MESSAGE),
        ...(model ? { lastRunModel: model } : { lastRunModel: null }),
        lastRunMs: ms,
        nextRunAt:
          current?.enabled && current.schedule
            ? nextCronRun(current.schedule)
            : null,
      },
    });
    if (updated.count === 1) {
      this.jobs.set(
        id,
        (await this.prisma.cronJob.findUnique({ where: { id } })) ??
          (current as CronJob),
      );
      const created = await this.prisma.cronRun
        .create({
          data: {
            cronJobId: id,
            status,
            message: truncate(message, MAX_RUN_MESSAGE),
            ...(model ? { model } : { model: null }),
            ms,
          },
        })
        .catch((err) => {
          this.logger.warn(
            `Could not persist cron run history for ${id}: ${(err as Error).message}`,
          );
          return null;
        });
      if (created) {
        await this.pruneRunHistory(id).catch((err) => {
          this.logger.warn(
            `Could not prune cron run history for ${id}: ${(err as Error).message}`,
          );
        });
      }
    }
  }

  /** Local scheduler/lease view for ops and the UI (Round 66). Round 79
   *  adds `enabled` so API-only nodes (CRON_SCHEDULER_ENABLED=false) are
   *  visibly distinguished from standby replicas. */
  schedulerStatus(): {
    enabled: boolean;
    leaseHeld: boolean;
    leaseGroup: string;
    leaseExpireAt: string | null;
    tickIntervalMs: number;
    failoverMs: number;
    lastTickAt: string | null;
    jobCount: number;
    enabledCount: number;
  } {
    const rows = [...this.jobs.values()];
    return {
      enabled: this.schedulerEnabled,
      leaseHeld: !!(
        this.schedulerEnabled &&
        this.leaseHeld &&
        this.leaseExpiresAt &&
        this.leaseExpiresAt.getTime() > Date.now()
      ),
      leaseGroup: process.env.CRON_LEASE_GROUP?.trim() || CRON_LEASE_GROUP,
      leaseExpireAt: this.leaseExpiresAt?.toISOString() ?? null,
      tickIntervalMs: CRON_TICK_MS,
      failoverMs: CRON_LEASE_DURATION_MS,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      jobCount: rows.length,
      enabledCount: rows.filter((row) => row.enabled).length,
    };
  }

  /**
   * Cluster-wide scheduler observability (Round 69): every lease group's
   * current ownership/freshness plus aggregate run throughput (totals,
   * last hour, status breakdown, busiest jobs) across all jobs, so
   * multi-replica ownership and run volume are visible in one call. Round 71
   * adds recent lease transition events so failover history (acquired/lost,
   * previous owner, timestamp) is visible alongside current ownership. Round 74
   * adds per-group transition totals (eventStats) so the newest-10 window can
   * be labeled against each group's full history. Round 76: `limit` widens
   * (or narrows) the transition window (1..100, default 10) so a selected
   * group can show more than its newest 10 events.
   */
  async overview(
    group?: string,
    limit = OVERVIEW_RECENT_EVENTS,
  ): Promise<CronOverview> {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const eventLimit = Math.min(
      Math.max(Math.trunc(limit) || OVERVIEW_RECENT_EVENTS, 1),
      OVERVIEW_EVENT_LIMIT_MAX,
    );
    const [leases, events, eventGroups, total, lastHour, byStatus, topJobs] =
      await Promise.all([
        this.prisma.cronSchedulerLease.findMany({
          orderBy: { schedulerGroup: 'asc' },
        }),
        this.prisma.cronSchedulerEvent.findMany({
          ...(group ? { where: { schedulerGroup: group } } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: eventLimit,
        }),
        this.prisma.cronSchedulerEvent.groupBy({
          by: ['schedulerGroup'],
          _count: { _all: true },
          orderBy: { schedulerGroup: 'asc' },
        }),
        this.prisma.cronRun.count(),
        this.prisma.cronRun.count({
          where: { createdAt: { gte: hourAgo } },
        }),
        this.prisma.cronRun.groupBy({
          by: ['status'],
          _count: { _all: true },
          _avg: { ms: true },
        }),
        this.prisma.cronRun.groupBy({
          by: ['cronJobId'],
          _count: { _all: true },
          _avg: { ms: true },
          orderBy: { _count: { cronJobId: 'desc' } },
          take: OVERVIEW_TOP_JOBS,
        }),
      ]);
    const jobNames = new Map(
      (
        await this.prisma.cronJob.findMany({
          where: { id: { in: topJobs.map((row) => row.cronJobId) } },
          select: { id: true, name: true },
        })
      ).map((job) => [job.id, job.name]),
    );
    return {
      now: now.toISOString(),
      leases: leases.map((lease) => ({
        group: lease.schedulerGroup,
        owner: lease.owner,
        expireAt: lease.expireAt.toISOString(),
        held: lease.expireAt.getTime() > now.getTime(),
        updatedAt: lease.updatedAt.toISOString(),
      })),
      events: events.map((event) => ({
        id: event.id,
        group: event.schedulerGroup,
        event: event.event as 'acquired' | 'lost',
        owner: event.owner,
        previousOwner: event.previousOwner,
        createdAt: event.createdAt.toISOString(),
      })),
      eventGroups: eventGroups.map((row) => row.schedulerGroup),
      eventStats: eventGroups.map((row) => ({
        group: row.schedulerGroup,
        total: row._count._all,
      })),
      runs: {
        total,
        lastHour,
        byStatus: byStatus.map((row) => ({
          status: row.status,
          count: row._count._all,
          avgMs: row._avg.ms ?? null,
        })),
        perJob: topJobs.map((row) => ({
          cronJobId: row.cronJobId,
          name: jobNames.get(row.cronJobId) ?? null,
          runCount: row._count._all,
          avgMs: row._avg.ms ?? null,
        })),
      },
    };
  }

  private async refreshed(id: string): Promise<CronJob> {
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cron job ${id} not found`);
    this.jobs.set(row.id, row);
    return row;
  }

  private async recomputeNextRun(id: string): Promise<void> {
    const row =
      this.jobs.get(id) ??
      (await this.prisma.cronJob.findUnique({ where: { id } }));
    if (!row) return;
    const nextRunAt = row.enabled ? nextCronRun(row.schedule) : null;
    const updated = await this.prisma.cronJob.update({
      where: { id },
      data: { nextRunAt },
    });
    this.jobs.set(id, updated);
  }

  /* ---------------------------- internals ---------------------------- */

  private async assertConnection(
    connectionId: string | undefined,
  ): Promise<void> {
    if (!connectionId) return;
    const row = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });
    if (!row) {
      throw new BadRequestException(`Connection ${connectionId} not found`);
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}
