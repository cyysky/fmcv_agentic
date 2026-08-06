"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./agent.module.css";
import { apiFetch } from "../../lib/api";


interface ModelOption {
  id: string;
  label: string;
  description: string;
  is_default: boolean;
}

interface ToolTraceStep {
  type: "tool_call";
  name: string;
  arguments: string;
  result: string;
}

interface TurnResponse {
  answer: string;
  model: string;
  steps: number;
  trace?: ToolTraceStep[];
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  trace?: ToolTraceStep[];
}

interface AgentSessionSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
}

interface AgentSessionMessage {
  role: string;
  content: string;
}

interface AgentSessionDetail extends AgentSessionSummary {
  messages: AgentSessionMessage[];
}

type ChannelJobEvent =
  | { type: "tool_call"; ts: string; name?: string; arguments?: string;
      result?: string; step?: number }
  | { type: "interject"; ts: string; text?: string; step?: number }
  | { type: "answer";   ts: string; text?: string }
  | { type: "status";   ts: string; text?: string }
  | { type: "error";    ts: string; text?: string }
  | { type: "stopped";  ts: string; text?: string };

interface ChannelJobResponse {
  jobId: string;
  status: "running" | "done" | "error" | "stopped";
  events: ChannelJobEvent[];
  answer?: string;
  steps?: number;
  error?: string;
}

/** Per-member debugging status returned by GET /channels/:id/member-status. */
interface MemberStatus {
  agentName: string;
  hasRun: boolean;
  status: "running" | "done" | "error" | "stopped" | null;
  answer: string | null;
  steps: number | null;
  error: string | null;
  events: ChannelJobEvent[];
  startedAt: string | null;
}

/* ------------------------- workspace viewer types ------------------------ */

interface AgentEntry {
  name: string;
  label: string;
  description: string;
  root: string;
  workDir: string;
}

interface ProjectEntry {
  name: string;
  path: string;
}

interface WorkspaceInfo {
  root: string;
  projectsDir: string;
  projects: ProjectEntry[];
  agents: AgentEntry[];
}

/** Recursive tree of a single directory listing, in {"name": {…} | null} form. */
type DirNode = { [name: string]: DirNode | null };

const isDir = (v: DirNode | null | undefined): v is DirNode =>
  v !== null && v !== undefined && typeof v === "object";

/* --------------------------- channels types ------------------------------ */

interface ChannelSummary {
  id: string;
  slug: string;
  name: string;
  projectName: string | null;
  parentId: string | null;
  agentName: string | null;
  memberCount: number;
  createdAt: string;
}

interface ChannelMessage {
  id: string;
  role: "system" | "user" | "agent";
  author: string;
  text: string;
  toolCalls?: unknown;
  createdAt: string;
}

interface ChannelDetail extends ChannelSummary {
  members: string[];
  messages: ChannelMessage[];
  projectTree: Record<string, unknown>;
}

/** Recursive project tree: dir -> nested object, file -> null. */
function isProjDir(v: unknown): boolean {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/* ----------------------------- component -------------------------------- */

export default function AgentPage() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // workspace viewer state
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [showViewer, setShowViewer] = useState(false);
  const [selAgent, setSelAgent] = useState<string | null>(null);
  const [agentTrees, setAgentTrees] = useState<Record<string, DirNode | null>>({});
  const [selProject, setSelProject] = useState<string | null>(null);
  const [projectTrees, setProjectTrees] = useState<Record<string, DirNode | null>>({});
  const [loadingTree, setLoadingTree] = useState<string | null>(null);

  // sessions view state
  const [view, setView] = useState<"chat" | "sessions" | "channels">("chat");
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selSessionId, setSelSessionId] = useState<string | null>(null);
  const [sessionMsgs, setSessionMsgs] = useState<ChatMsg[]>([]);
  const [sessionInput, setSessionInput] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);

  // channels view state
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [selChannelId, setSelChannelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newCreator, setNewCreator] = useState("");
  // discoverable-add + DM state
  const [availableAgents, setAvailableAgents] = useState<AgentEntry[]>([]);
  const [dmOpen, setDmOpen] = useState(false);
  const [dmBusy, setDmBusy] = useState(false);
  const [chMode, setChMode] = useState<"post" | "run">("post");
  const [chInput, setChInput] = useState("");
  const [chBusy, setChBusy] = useState(false);
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberStatus, setMemberStatus] = useState<MemberStatus[]>([]);
  const [memberStatusLoading, setMemberStatusLoading] = useState(false);
  const [selMember, setSelMember] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const chFeedRef = useRef<HTMLDivElement | null>(null);
  const [activeJob, setActiveJob] = useState<{
    jobId: string; channelId: string; agentName: string;
  } | null>(null);
  const [jobEvents, setJobEvents] = useState<ChannelJobEvent[]>([]);
  const [jobStatus, setJobStatus] = useState<"running"|"done"|"error"|"stopped"|null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobSeen, setJobSeen] = useState(0);
  const jobPollRef = useRef<number | null>(null);
  const [liveAgent, setLiveAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/agent/models`);
        if (!res.ok) throw new Error(`Failed to load models (HTTP ${res.status})`);
        const data = (await res.json()) as ModelOption[];
        if (cancelled) return;
        setModels(data);
        const def = data.find((m) => m.is_default) ?? data[0];
        if (def) setModel(def.id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load models");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, sessionMsgs, sessionBusy, selSessionId]);

  useEffect(() => {
    
  }, []);

  useEffect(() => {
    chFeedRef.current?.scrollTo({ top: chFeedRef.current.scrollHeight });
  }, [detail?.messages, chBusy, detailLoading, jobEvents, jobStatus]);

  useEffect(() => {
    setJobSeen((s) => (jobEvents.length > s ? jobEvents.length : s));
  }, [jobEvents]);

  const stopPolling = useCallback(() => {
    if (jobPollRef.current !== null) {
      window.clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const resetJobState = useCallback(() => {
    stopPolling();
    setActiveJob(null);
    setJobEvents([]);
    setJobStatus(null);
    setJobError(null);
    setJobSeen(0);
    setLiveAgent(null);
  }, [stopPolling]);

  const loadChannels = useCallback(async () => {
    try {
      const res = await apiFetch(`/channels`);
      if (!res.ok) throw new Error(`Failed to load channels (HTTP ${res.status})`);
      const data = (await res.json()) as ChannelSummary[];
      setChannels(data);
      setChannelsError(null);
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to load channels");
    }
  }, []);

  useEffect(() => {
    if (view === "channels") loadChannels();
  }, [view, loadChannels]);

  // Live-refresh the channel list every 8s while on the channels view so
  // newly created sub-channels appear without a page reload.
  useEffect(() => {
    if (view !== "channels") return;
    const t = window.setInterval(() => {
      loadChannels();
    }, 8000);
    return () => window.clearInterval(t);
  }, [view, loadChannels]);

  const fetchChannel = useCallback(async (id: string): Promise<ChannelDetail> => {
    const res = await apiFetch(`/channels/${id}`);
    if (!res.ok) throw new Error(`Failed to load channel (HTTP ${res.status})`);
    return (await res.json()) as ChannelDetail;
  }, []);

  const loadMemberStatus = useCallback(async (id: string) => {
    setMemberStatusLoading(true);
    try {
      const res = await apiFetch(`/channels/${id}/member-status`);
      if (!res.ok) throw new Error(`Failed to load member status (HTTP ${res.status})`);
      setMemberStatus((await res.json()) as MemberStatus[]);
    } catch {
      /* non-fatal: keep last known */
    } finally {
      setMemberStatusLoading(false);
    }
  }, []);

  const openChannel = useCallback(
    async (id: string) => {
      if (id !== selChannelId) {
        resetJobState();
        setSelMember(null);
      }
      setSelChannelId(id);
      setDetailLoading(true);
      setChannelsError(null);
      try {
        const data = await fetchChannel(id);
        setDetail(data);
        setRunAgent((cur) => cur || (data.members[0] ?? ""));
        loadMemberStatus(id);
      } catch (e) {
        setChannelsError(e instanceof Error ? e.message : "Failed to load channel");
      } finally {
        setDetailLoading(false);
      }
    },
    [fetchChannel, selChannelId, resetJobState, loadMemberStatus],
  );

  const createChannel = useCallback(async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setChannelsError(null);
    try {
      const res = await apiFetch(`/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          projectName: newProject.trim() || undefined,
          creatorAgent: newCreator.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`Failed to create channel (HTTP ${res.status})`);
      const data = (await res.json()) as ChannelDetail;
      setShowNew(false);
      setNewName("");
      setNewProject("");
      setNewCreator("");
      setChannels((prev) => [...prev, data]);
      await openChannel(data.id);
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to create channel");
    } finally {
      setCreating(false);
    }
  }, [newName, newProject, newCreator, creating, openChannel]);

  const deleteChannel = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this channel? This cannot be undone.")) return;
      setChannelsError(null);
      try {
        const res = await apiFetch(`/channels/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Failed to delete channel (HTTP ${res.status})`);
        setChannels((prev) => prev.filter((c) => c.id !== id));
        if (selChannelId === id) {
          resetJobState();
          setSelChannelId(null);
          setDetail(null);
        }
      } catch (e) {
        setChannelsError(e instanceof Error ? e.message : "Failed to delete channel");
      }
    },
    [selChannelId, resetJobState],
  );

  const addMember = useCallback(async () => {
    const agentName = memberInput.trim();
    if (!agentName || !selChannelId || memberBusy) return;
    setMemberBusy(true);
    setChannelsError(null);
    try {
      const res = await apiFetch(`/channels/${selChannelId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName }),
      });
      if (!res.ok) throw new Error(`Failed to add member (HTTP ${res.status})`);
      const data = (await res.json()) as ChannelDetail;
      setDetail(data);
      setChannels((prev) =>
        prev.map((c) => (c.id === selChannelId ? { ...c, memberCount: data.memberCount } : c)),
      );
      setRunAgent((cur) => cur || agentName);
      setMemberInput("");
      loadMemberStatus(selChannelId);
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to add member");
    } finally {
      setMemberBusy(false);
    }
  }, [memberInput, selChannelId, memberBusy, loadMemberStatus]);

  const removeMember = useCallback(
    async (agentName: string) => {
      if (!selChannelId) return;
      setChannelsError(null);
      try {
        const res = await apiFetch(
          `/channels/${selChannelId}/members/${encodeURIComponent(agentName)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`Failed to remove member (HTTP ${res.status})`);
        const data = (await res.json()) as ChannelDetail;
        setDetail(data);
        if (runAgent === agentName) setRunAgent(data.members[0] ?? "");
        if (selMember === agentName) setSelMember(null);
        loadMemberStatus(selChannelId);
      } catch (e) {
        setChannelsError(e instanceof Error ? e.message : "Failed to remove member");
      }
    },
    [selChannelId, runAgent, selMember, loadMemberStatus],
  );

  /**
   * Load the discoverable agent catalog for the "Add member" / "New DM" pickers.
   * Falls back to keeping whatever was loaded before on failure.
   */
  const loadAvailableAgents = useCallback(async () => {
    try {
      const res = await apiFetch(`/agent/workspaces`);
      if (!res.ok) return;
      const data = (await res.json()) as WorkspaceInfo;
      setAvailableAgents(data.agents ?? []);
    } catch {
      /* non-fatal: leave pickers empty */
    }
  }, []);

  useEffect(() => {
    if (view === "channels") loadAvailableAgents();
  }, [view, loadAvailableAgents]);

  /**
   * Open a private 1:1 DM with an agent: find-or-create a dedicated
   * single-agent channel named "dm-<agent>", select it, and enter "run" mode
   * so the composer immediately talks to (runs) that agent.
   */
  const openDirectMessage = useCallback(
    async (agentName: string) => {
      if (dmBusy) return;
      setDmBusy(true);
      setChannelsError(null);
      setDmOpen(false);
      try {
        const existing = channels.find(
          (c) => c.slug === `dm-${agentName}` || c.name.toLowerCase() === `dm-${agentName}`,
        );
        let id = existing?.id;
        if (!id) {
          const res = await apiFetch(`/channels`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `dm-${agentName}`,
              creatorAgent: agentName,
            }),
          });
          if (!res.ok) throw new Error(`Failed to open DM (HTTP ${res.status})`);
          const data = (await res.json()) as ChannelDetail;
          id = data.id;
          setChannels((prev) => [...prev, data]);
        }
        await loadChannels();
        await openChannel(id!);
        setRunAgent(agentName);
        setLiveAgent(agentName);
        setChMode("run");
      } catch (e) {
        setChannelsError(e instanceof Error ? e.message : "Failed to open DM");
      } finally {
        setDmBusy(false);
      }
    },
    [channels, dmBusy, loadChannels, openChannel],
  );

  const pollJob = useCallback(
    (jobId: string, channelId: string) => {
      stopPolling();
      jobPollRef.current = window.setInterval(async () => {
        try {
          const res = await apiFetch(`/channels/${channelId}/jobs/${jobId}`);
          if (!res.ok) throw new Error(`Poll failed (HTTP ${res.status})`);
          const data = (await res.json()) as ChannelJobResponse;
          setJobEvents(data.events);
          setJobStatus(data.status);
          setJobError(data.error ?? null);
          if (data.status === "done" || data.status === "error" || data.status === "stopped") {
            stopPolling();
            setActiveJob(null);
            loadMemberStatus(channelId);
            try {
              const fresh = await fetchChannel(channelId);
              setDetail(fresh);
            } catch {
              /* keep current detail */
            }
          }
        } catch {
          /* transient poll errors ignored */
        }
      }, 1200);
    },
    [stopPolling, fetchChannel, loadMemberStatus],
  );

  const postToChannel = useCallback(async () => {
    const text = chInput.trim();
    if (!text || !selChannelId || chBusy) return;
    setChBusy(true);
    setChannelsError(null);
    try {
      const res = await apiFetch(`/channels/${selChannelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", author: "you", text }),
      });
      if (!res.ok) throw new Error(`Failed to post message (HTTP ${res.status})`);
      const data = (await res.json()) as {
        msg: ChannelMessage;
        jobId?: string;
        status?: string;
        agentName?: string;
      };
      const msg = data.msg;
      setDetail((d) => (d ? { ...d, messages: [...d.messages, msg] } : d));
      setChInput("");
      // The backend auto-starts a streaming reply job on plain posts; if one
      // was created, watch it so the observation panel + final answer appear.
      const replyJobId = (data as { jobId?: string }).jobId;
      const replyAgent = (data as { agentName?: string }).agentName;
      if (replyJobId && replyAgent) {
        setActiveJob({ jobId: replyJobId, channelId: selChannelId, agentName: replyAgent });
        setLiveAgent(replyAgent);
        setJobEvents([]);
        setJobStatus("running");
        setJobError(null);
        setJobSeen(0);
        setSelMember(replyAgent);
        loadMemberStatus(selChannelId);
        pollJob(replyJobId, selChannelId);
      }
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to post message");
    } finally {
      setChBusy(false);
    }
  }, [chInput, selChannelId, chBusy, pollJob, loadMemberStatus]);

  const startJob = useCallback(async () => {
    const message = chInput.trim();
    const agentName = runAgent.trim();
    if (!message || !agentName || !selChannelId) return;
    setChannelsError(null);
    try {
      const res = await apiFetch(`/channels/${selChannelId}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName, message, model: runModel || undefined }),
      });
      const data = (await res.json().catch(() => null)) as {
        jobId?: string;
        status?: string;
        message?: unknown;
      } | null;
      if (!res.ok) {
        let errMsg = `Agent run failed (HTTP ${res.status})`;
        if (data && typeof data.message === "string") errMsg = data.message;
        setDetail((d) =>
          d
            ? {
                ...d,
                messages: [
                  ...d.messages,
                  {
                    id: `err-${Date.now()}`,
                    role: "agent",
                    author: agentName,
                    text: errMsg,
                    createdAt: new Date().toISOString(),
                  },
                ],
              }
            : d,
        );
        return;
      }
      const jobId = data?.jobId;
      if (!jobId) throw new Error("No jobId returned");
      setActiveJob({ jobId, channelId: selChannelId, agentName });
      setLiveAgent(agentName);
      setSelMember(agentName);
      setJobEvents([]);
      setJobStatus("running");
      setJobError(null);
      setJobSeen(0);
      setChInput("");
      loadMemberStatus(selChannelId);
      pollJob(jobId, selChannelId);
    } catch (e) {
      setDetail((d) =>
        d
          ? {
              ...d,
              messages: [
                ...d.messages,
                {
                  id: `err-${Date.now()}`,
                  role: "agent",
                  author: runAgent.trim() || "agent",
                  text: e instanceof Error ? e.message : "Request failed",
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : d,
      );
    }
  }, [chInput, runAgent, runModel, selChannelId, pollJob, loadMemberStatus]);

  const interject = useCallback(async () => {
    const text = chInput.trim();
    if (!text || !activeJob) return;
    setChannelsError(null);
    try {
      const res = await apiFetch(
        `/channels/${activeJob.channelId}/jobs/${activeJob.jobId}/interject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      if (!res.ok) throw new Error(`Interject failed (HTTP ${res.status})`);
      setChInput("");
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to interject");
    }
  }, [chInput, activeJob]);

  const stopJob = useCallback(async () => {
    if (!activeJob) return;
    setChannelsError(null);
    try {
      const res = await apiFetch(
        `/channels/${activeJob.channelId}/jobs/${activeJob.jobId}/stop`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) throw new Error(`Stop failed (HTTP ${res.status})`);
      stopPolling();
      setActiveJob(null);
      setJobStatus("stopped");
      setJobEvents((ev) => [
        ...ev,
        { type: "status", ts: new Date().toISOString(), text: "Agent run stopped." },
      ]);
      try {
        const fresh = await fetchChannel(activeJob.channelId);
        setDetail(fresh);
      } catch {
        /* keep current detail */
      }
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to stop agent");
    }
  }, [activeJob, stopPolling, fetchChannel]);

  const selectMember = useCallback(
    (agentName: string) => {
      setRunAgent(agentName);
      setLiveAgent(agentName);
      setSelMember(agentName);
      if (selChannelId) {
        loadChannels();
        openChannel(selChannelId);
      }
    },
    [selChannelId, loadChannels, openChannel],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const history = messages.filter((m) => m.role === "user").map((m) => m.content);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    try {
      const res = await apiFetch(`/agent/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, model: model || undefined }),
      });
      const data = (await res.json().catch(() => null)) as TurnResponse | null;
      if (!res.ok) {
        const errData = data as { message?: string | string[] } | null;
        let msg = `Request failed (HTTP ${res.status})`;
        if (errData && Array.isArray(errData.message)) msg = errData.message.join(", ");
        else if (errData && typeof errData.message === "string") msg = errData.message;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: msg, error: true },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data?.answer ?? "(no answer)",
            trace: data?.trace,
          },
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }, [input, busy, model, messages]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  const toggleTab = (next: "chat" | "sessions" | "channels") => {
    setView(next);
    if (next === "channels") loadChannels();
    if (next === "sessions") void loadSessions();
  };

  /* ----------------------- session helpers --------------------------- */

  const loadSessions = useCallback(async (): Promise<AgentSessionSummary[]> => {
    setSessionsError(null);
    try {
      const res = await apiFetch(`/agent/sessions`);
      if (!res.ok) throw new Error(`Failed to load sessions (HTTP ${res.status})`);
      const data = (await res.json()) as AgentSessionSummary[];
      const newestFirst = [...data].reverse();
      setSessions(newestFirst);
      return newestFirst;
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Failed to load sessions");
      return [];
    }
  }, []);

  const openSession = useCallback(async (id: string) => {
    setSelSessionId(id);
    setSessionMsgs([]);
    setSessionLoading(true);
    setSessionsError(null);
    try {
      const res = await apiFetch(`/agent/sessions/${id}`);
      if (!res.ok) throw new Error(`Failed to load session (HTTP ${res.status})`);
      const data = (await res.json()) as AgentSessionDetail;
      setModel((cur) => data.model || cur);
      setSessionMsgs(
        data.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
            content: m.content,
          })),
      );
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Failed to load session");
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const createSession = useCallback(async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    setSessionsError(null);
    try {
      const res = await apiFetch(`/agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(model ? { model } : {}),
      });
      if (!res.ok) throw new Error(`Failed to create session (HTTP ${res.status})`);
      const data = (await res.json()) as AgentSessionDetail;
      await loadSessions();
      await openSession(data.id);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Failed to create session");
    } finally {
      setCreatingSession(false);
    }
  }, [creatingSession, model, loadSessions, openSession]);

  const deleteSession = useCallback(
    async (id: string) => {
      setSessionsError(null);
      try {
        const res = await apiFetch(`/agent/sessions/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Failed to delete session (HTTP ${res.status})`);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (selSessionId === id) {
          setSelSessionId(null);
          setSessionMsgs([]);
        }
      } catch (e) {
        setSessionsError(e instanceof Error ? e.message : "Failed to delete session");
      }
    },
    [selSessionId],
  );

  const sendSession = useCallback(async () => {
    const text = sessionInput.trim();
    if (!text || sessionBusy || !selSessionId) return;
    setSessionBusy(true);
    setSessionsError(null);
    setSessionMsgs((prev) => [...prev, { role: "user", content: text }]);
    setSessionInput("");
    try {
      const res = await apiFetch(`/agent/sessions/${selSessionId}/converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, ...(model ? { model } : {}) }),
      });
      const data = (await res.json().catch(() => null)) as TurnResponse | null;
      if (!res.ok) {
        const errData = data as { message?: string | string[] } | null;
        let msg = `Request failed (HTTP ${res.status})`;
        if (errData && Array.isArray(errData.message)) msg = errData.message.join(", ");
        else if (errData && typeof errData.message === "string") msg = errData.message;
        setSessionMsgs((prev) => [...prev, { role: "assistant", content: msg, error: true }]);
      } else {
        setSessionMsgs((prev) => [
          ...prev,
          { role: "assistant", content: data?.answer ?? "(no answer)" },
        ]);
      }
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSessionBusy(false);
    }
  }, [sessionInput, sessionBusy, selSessionId, model]);

  /* ----------------------- workspace viewer helpers ---------------------- */

  const loadWorkspace = useCallback(async () => {
    if (wsInfo) {
      setShowViewer((s) => !s);
      return;
    }
    setWsError(null);
    try {
      const res = await apiFetch(`/agent/workspaces`);
      if (!res.ok) throw new Error(`Failed to load workspace (HTTP ${res.status})`);
      const data = (await res.json()) as WorkspaceInfo;
      setWsInfo(data);
      setShowViewer(true);
    } catch (e) {
      setWsError(e instanceof Error ? e.message : "Failed to load workspace");
    }
  }, [wsInfo]);

  const loadAgentTree = useCallback(
    async (name: string) => {
      if (agentTrees[name] !== undefined) {
        setSelAgent((cur) => (cur === name ? null : name));
        return;
      }
      setLoadingTree(name);
      try {
        const res = await apiFetch(`/agent/workspaces/agents/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DirNode | null;
        setAgentTrees((prev) => ({ ...prev, [name]: data }));
        setSelAgent(name);
      } catch (e) {
        setWsError(e instanceof Error ? e.message : `Failed to load ${name}`);
      } finally {
        setLoadingTree(null);
      }
    },
    [agentTrees],
  );

  const loadProjectTree = useCallback(
    async (name: string) => {
      if (projectTrees[name] !== undefined) {
        setSelProject((cur) => (cur === name ? null : name));
        return;
      }
      setLoadingTree(name);
      try {
        const res = await apiFetch(`/agent/workspaces/projects/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DirNode | null;
        setProjectTrees((prev) => ({ ...prev, [name]: data }));
        setSelProject(name);
      } catch (e) {
        setWsError(e instanceof Error ? e.message : `Failed to load ${name}`);
      } finally {
        setLoadingTree(null);
      }
    },
    [projectTrees],
  );

  const toggleCollapse = (path: string) =>
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));

  /* ------------------------------- render -------------------------------- */

  return (
    <div className={`${styles.container} ${view === "channels" ? styles.containerWide : ""}`}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Agent</h1>
          <p className={styles.subtitle}>
            Chat with the workspace agent or collaborate in team channels.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            className={view === "chat" ? styles.btnPrimary : styles.btnGhost}
            onClick={() => toggleTab("chat")}
          >
            Chat
          </button>
          <button
            className={view === "sessions" ? styles.btnPrimary : styles.btnGhost}
            onClick={() => toggleTab("sessions")}
          >
            Sessions
          </button>
          <button
            className={view === "channels" ? styles.btnPrimary : styles.btnGhost}
            onClick={() => toggleTab("channels")}
          >
            Channels
          </button>
          <button
            className={styles.btnGhost}
            onClick={loadWorkspace}
            disabled={busy || view !== "chat"}
          >
            {wsInfo && showViewer ? "Hide Workspace" : "Workspace"}
          </button>
          <select
            className={styles.modelSelect}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={models.length === 0 || view === "channels"}
          >
            {models.length === 0 ? (
              <option value="">Loading models…</option>
            ) : (
              models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))
            )}
          </select>
          <button
            className={styles.btnGhost}
            onClick={clearChat}
            disabled={messages.length === 0 || busy || view !== "chat"}
          >
            Clear
          </button>
        </div>
      </div>

      {view === "chat" && error && (
        <div className={styles.bannerError} onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {view === "chat" && showViewer && wsInfo && (
        <div className={styles.workspace}>
          <div className={styles.wsRow}>
            <div className={styles.wsBlock}>
              <div className={styles.wsBlockTitle}>Agents</div>
              {wsInfo.agents.length === 0 ? (
                <div className={styles.muted}>No agent folders</div>
              ) : (
                wsInfo.agents.map((a) => (
                  <div key={a.name}>
                    <button
                      className={styles.treeItem}
                      onClick={() => loadAgentTree(a.name)}
                    >
                      <span className={styles.treeCaret}>
                        {loadingTree === a.name
                          ? "…"
                          : agentTrees[a.name] !== undefined
                            ? selAgent === a.name
                              ? "▾"
                              : "▸"
                            : "▸"}
                      </span>
                      {a.label}
                    </button>
                    {selAgent === a.name && agentTrees[a.name] !== undefined && (
                      <div className={styles.treeNested}>
                        {renderTree(agentTrees[a.name], styles, `${a.name}::`)}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className={styles.wsBlock}>
              <div className={styles.wsBlockTitle}>Projects</div>
              {wsInfo.projects.length === 0 ? (
                <div className={styles.muted}>No projects</div>
              ) : (
                wsInfo.projects.map((p) => (
                  <div key={p.name}>
                    <button
                      className={styles.treeItem}
                      onClick={() => loadProjectTree(p.name)}
                    >
                      <span className={styles.treeCaret}>
                        {loadingTree === p.name
                          ? "…"
                          : projectTrees[p.name] !== undefined
                            ? selProject === p.name
                              ? "▾"
                              : "▸"
                            : "▸"}
                      </span>
                      {p.name}
                    </button>
                    {selProject === p.name && projectTrees[p.name] !== undefined && (
                      <div className={styles.treeNested}>
                        {renderTree(projectTrees[p.name], styles, `${p.name}::`)}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          {wsError && (
            <div className={styles.wsError} onClick={() => setWsError(null)}>
              {wsError}
            </div>
          )}
        </div>
      )}

      {view === "chat" && (
        <>
          <div className={styles.thread}>
            {messages.length === 0 && !busy ? (
              <div className={styles.empty}>
                <p className={styles.muted}>
                  Ask the agent to do something. Example:{" "}
                  <em>&quot;Create a file called note.txt in my folder.&quot;</em>
                </p>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={`${styles.bubble} ${
                    m.role === "user" ? styles.bubbleUser : styles.bubbleAgent
                  } ${m.error ? styles.bubbleError : ""}`}
                >
                  <div className={styles.bubbleLabel}>
                    {m.role === "user" ? "You" : "Agent"}
                  </div>
                  <div className={styles.bubbleText}>{m.content}</div>

                  {m.role === "assistant" && m.trace && m.trace.length > 0 && (
                    <TraceView trace={m.trace} />
                  )}
                </div>
              ))
            )}

            {busy && (
              <div className={`${styles.bubble} ${styles.bubbleAgent}`}>
                <div className={styles.bubbleLabel}>Agent</div>
                <div className={styles.typing}>Typing…</div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            className={styles.composer}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              className={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
              rows={1}
              disabled={busy}
            />
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={busy || input.trim() === ""}
            >
              {busy ? "…" : "Send"}
            </button>
          </form>
        </>
      )}

      {view === "sessions" && (
        <>
          {sessionsError && (
            <div className={styles.bannerError} onClick={() => setSessionsError(null)}>
              {sessionsError}
            </div>
          )}
          <div className={styles.sessionPane}>
            <div className={styles.sessionSidebar}>
              <div className={styles.sessionSidebarHeader}>
                <div className={styles.wsBlockTitle}>
                  Sessions ({sessions.length})
                </div>
                <button
                  className={styles.btnPrimary}
                  onClick={() => void createSession()}
                  disabled={creatingSession}
                >
                  {creatingSession ? "Creating…" : "New chat"}
                </button>
              </div>
              <div className={styles.sessionList}>
                {sessions.length === 0 && !creatingSession ? (
                  <div className={styles.muted}>
                    No saved sessions yet — start a new chat.
                  </div>
                ) : (
                  sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`${styles.sessionItem} ${
                        selSessionId === s.id ? styles.sessionItemActive : ""
                      }`}
                    >
                      <button
                        className={styles.sessionOpen}
                        onClick={() => void openSession(s.id)}
                      >
                        <span className={styles.sessionTitle}>
                          {s.title || "Untitled"}
                        </span>
                        <span className={styles.sessionMeta}>
                          {new Date(s.createdAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        className={styles.sessionDelete}
                        title="Delete session"
                        aria-label={`Delete session ${s.title || "Untitled"}`}
                        onClick={() => {
                          if (window.confirm("Delete this session? This cannot be undone.")) {
                            void deleteSession(s.id);
                          }
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className={styles.sessionChat}>
              {!selSessionId ? (
                <div className={styles.empty}>
                  <p className={styles.muted}>
                    Pick a saved session or start a new chat to continue.
                    Sessions are saved to the backend and survive a restart.
                  </p>
                </div>
              ) : (
                <>
                  <div className={styles.thread}>
                    {sessionLoading ? (
                      <div className={styles.empty}>
                        <p className={styles.muted}>Loading session…</p>
                      </div>
                    ) : sessionMsgs.length === 0 ? (
                      <div className={styles.empty}>
                        <p className={styles.muted}>
                          This session has no messages yet — say hello.
                        </p>
                      </div>
                    ) : (
                      sessionMsgs.map((m, i) => (
                        <div
                          key={i}
                          className={`${styles.bubble} ${
                            m.role === "user" ? styles.bubbleUser : styles.bubbleAgent
                          } ${m.error ? styles.bubbleError : ""}`}
                        >
                          <div className={styles.bubbleLabel}>
                            {m.role === "user" ? "You" : "Agent"}
                          </div>
                          <div className={styles.bubbleText}>{m.content}</div>
                        </div>
                      ))
                    )}
                    {sessionBusy && (
                      <div className={`${styles.bubble} ${styles.bubbleAgent}`}>
                        <div className={styles.bubbleLabel}>Agent</div>
                        <div className={styles.typing}>Typing…</div>
                      </div>
                    )}
                    <div ref={endRef} />
                  </div>
                  <form
                    className={styles.composer}
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendSession();
                    }}
                  >
                    <textarea
                      className={styles.input}
                      value={sessionInput}
                      onChange={(e) => setSessionInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          sendSession();
                        }
                      }}
                      placeholder="Message this session…  (Enter to send, Shift+Enter for newline)"
                      rows={1}
                      disabled={sessionBusy || sessionLoading}
                    />
                    <button
                      type="submit"
                      className={styles.btnPrimary}
                      disabled={sessionBusy || sessionLoading || sessionInput.trim() === ""}
                    >
                      {sessionBusy ? "…" : "Send"}
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {view === "channels" && (
        <>
          {channelsError && (
            <div className={styles.bannerError} onClick={() => setChannelsError(null)}>
              {channelsError}
            </div>
          )}

          <div className={styles.channels}>
            {/* ------------------------------------------------- sidebar -- */}
            <aside className={styles.channelSidebar}>
              <div className={styles.channelSidebarHead}>
                <span className={styles.wsBlockTitle}>Channels</span>
                <button
                  className={styles.iconBtn}
                  title="New channel"
                  onClick={() => setShowNew(true)}
                >
                  ＋
                </button>
              </div>
              <div className={styles.channelList}>
                {channels.length === 0 ? (
                  <div className={styles.muted}>No channels yet</div>
                ) : (
                  (() => {
                    const parents = channels.filter((c) => !c.parentId);
                    const subs = channels.filter((c) => c.parentId);
                    const items: (ChannelSummary | null)[] = [];
                    for (const p of parents) {
                      items.push(p);
                      const children = subs.filter((s) => s.parentId === p.id);
                      if (children.length > 0) items.push(...children);
                    }
                    // Any orphaned sub-channels (parent missing) at the end.
                    const orphanSubs = subs.filter(
                      (s) => !parents.some((p) => p.id === s.parentId),
                    );
                    if (orphanSubs.length > 0) items.push(...orphanSubs);
                    return items.map((c) =>
                      c === null ? null : (
                        <div
                          key={c.id}
                          className={`${styles.channelRow} ${
                            c.parentId ? styles.channelRowSub : ""
                          } ${selChannelId === c.id ? styles.channelRowActive : ""}`}
                        >
                          <button
                            className={styles.channelBtn}
                            onClick={() => openChannel(c.id)}
                          >
                            <span className={styles.channelName}>
                              {c.parentId ? "└ " : "# "}
                              {c.name}
                            </span>
                            <span className={styles.channelMeta}>
                              {c.agentName
                                ? `debug · ${c.parentId ? "discuss with " : ""}${c.agentName}`
                                : `${c.memberCount} member${c.memberCount === 1 ? "" : "s"}${
                                    c.projectName ? ` · ${c.projectName}` : ""
                                  }`}
                            </span>
                          </button>
                          <button
                            className={styles.iconBtn}
                            title="Delete channel"
                            onClick={() => deleteChannel(c.id)}
                          >
                            🗑
                          </button>
                        </div>
                      ),
                    );
                  })()
                )}
              </div>
              <button className={styles.btnGhost} onClick={() => setShowNew(true)}>
                ＋ New channel
              </button>
              {view === "channels" && (
                <button
                  className={styles.btnGhost}
                  onClick={() => {
                    if (!dmOpen) loadAvailableAgents();
                    setDmOpen((v) => !v);
                  }}
                  disabled={dmBusy}
                >
                  {dmOpen ? "Close DM" : "＋ New DM"}
                </button>
              )}
            </aside>

          {dmOpen && (
            <div className={styles.dmOverlay} onClick={() => setDmOpen(false)}>
              <div
                className={styles.dmPanel}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.dmHead}>
                  <span>Start a direct message</span>
                  <button
                    className={styles.iconBtn}
                    onClick={() => setDmOpen(false)}
                  >
                    ✕
                  </button>
                </div>
                <div className={styles.dmBody}>
                  {availableAgents.length === 0 ? (
                    <div className={styles.muted}>
                      No agents available. Add agents to a channel first.
                    </div>
                  ) : (
                    availableAgents.map((a) => (
                      <button
                        key={a.name}
                        className={styles.dmRow}
                        disabled={dmBusy}
                        onClick={() => openDirectMessage(a.name)}
                      >
                        <span className={styles.dmRowName}>{a.name}</span>
                        {a.label && (
                          <span className={styles.muted}>{a.label}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

            {/* ------------------------------------------------ conversation -- */}
            <section className={styles.conversation}>
              {!detail ? (
                <div className={styles.empty}>
                  <div className={styles.muted}>
                    Select a channel to open the conversation.
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.convHead}>
                    <div className={styles.convTitle}># {detail.name}</div>
                    <div className={styles.muted}>
                      {detail.slug} · {detail.memberCount} member
                      {detail.memberCount === 1 ? "" : "s"}
                      {detail.projectName ? ` · ${detail.projectName}` : ""}
                    </div>
                  </div>

                  <div className={styles.members}>
                    <div className={styles.memberTop}>
                      <span className={styles.wsBlockTitle}>Members</span>
                    </div>
                    <div className={styles.memberChips}>
                      {detail.members.length === 0 ? (
                        <span className={styles.muted}>No members</span>
                      ) : (
                        detail.members.map((m) => (
                          <span
                            key={m}
                            className={`${styles.memberChip} ${
                              liveAgent === m ? styles.memberChipActive : ""
                            } ${runAgent === m ? styles.memberChipSelected : ""}`}
                          >
                            <button
                              className={styles.memberSelect}
                              title="Select agent to run"
                              onClick={() => selectMember(m)}
                            >
                              {m}
                            </button>
                            <button
                              className={styles.memberRemove}
                              title="Remove member"
                              onClick={() => removeMember(m)}
                            >
                              ✕
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    <form
                      className={styles.memberAdd}
                      onSubmit={(e) => {
                        e.preventDefault();
                        addMember();
                      }}
                    >
                      <input
                        className={styles.input}
                        value={memberInput}
                        onChange={(e) => setMemberInput(e.target.value)}
                        placeholder="Add member by agent name"
                        disabled={memberBusy}
                      />
                      <button
                        className={styles.btnGhost}
                        disabled={memberBusy || memberInput.trim() === ""}
                      >
                        Add
                      </button>
                    </form>
                  </div>

                  <div className={styles.channelFeed} ref={chFeedRef}>
                    {detailLoading ? (
                      <div className={styles.muted}>Loading…</div>
                    ) : detail.messages.length === 0 ? (
                      <div className={styles.empty}>
                        <div className={styles.muted}>No messages yet</div>
                      </div>
                    ) : (
                      detail.messages.map((m) => (
                        <div key={m.id} className={styles.chMsg}>
                          <div className={styles.chMsgLabel}>
                            <span className={styles.chMsgAuthor}>{m.author}</span>
                            <span className={styles.chMsgRole}>[{m.role}]</span>
                            <span className={styles.chMsgTime}>{m.createdAt}</span>
                          </div>
                          <div className={styles.chMsgText}>{m.text}</div>
                        </div>
                      ))
                    )}
                    {chBusy && chMode === "run" && (
                      <div className={styles.chMsg}>
                        <div className={styles.typing}>Running agent…</div>
                      </div>
                    )}
                    {jobStatus && (
                      <>
                        <LiveJobEvents events={jobEvents.slice(0, jobSeen)} />
                        {jobStatus === "error" && jobError && (
                          <div className={`${styles.chMsg} ${styles.liveError}`}>
                            <div className={styles.chMsgRole}>[error]</div>
                            <div className={styles.chMsgText}>{jobError}</div>
                          </div>
                        )}
                        {jobStatus === "running" && activeJob && (
                          <div className={`${styles.chMsg} ${styles.liveStatus}`}>
                            <div className={styles.typing}>
                              {activeJob.agentName} is working… (type + Post to
                              divert, or Stop)
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className={styles.chComposer}>
                    <div className={styles.chModeRow}>
                      <button
                        className={`${styles.chModeBtn} ${
                          chMode === "post" ? styles.chModeActive : ""
                        }`}
                        onClick={() => setChMode("post")}
                        disabled={chBusy}
                      >
                        Post
                      </button>
                      <button
                        className={`${styles.chModeBtn} ${
                          chMode === "run" ? styles.chModeActive : ""
                        }`}
                        onClick={() => setChMode("run")}
                        disabled={chBusy}
                      >
                        Agent run
                      </button>
                    </div>

                    {chMode === "run" && (
                      <div className={styles.chRunRow}>
                        <select
                          className={styles.modelSelect}
                          value={runAgent}
                          onChange={(e) => setRunAgent(e.target.value)}
                          disabled={chBusy}
                        >
                          <option value="">member agent…</option>
                          {detail.members.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <select
                          className={styles.modelSelect}
                          value={runModel}
                          onChange={(e) => setRunModel(e.target.value)}
                          disabled={chBusy}
                        >
                          <option value="">model (default)</option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <form
                      className={styles.composer}
                      onSubmit={(e) => {
                        e.preventDefault();
                        // When an agent is already running, the composer
                        // diverts (interjects) it rather than posting/starting a
                        // new turn — that's how you redirect a wrong agent.
                        if (activeJob && jobStatus === "running") interject();
                        else if (chMode === "post") postToChannel();
                        else startJob();
                      }}
                    >
                      <textarea
                        className={styles.input}
                        value={chInput}
                        onChange={(e) => setChInput(e.target.value)}
                        placeholder={
                          activeJob && jobStatus === "running"
                            ? "Divert the agent: tell it to change course…"
                            : chMode === "post"
                              ? "Post a message to #" +
                                (detail.slug || detail.name) +
                                "…"
                              : "Message the selected agent to run…"
                        }
                        rows={1}
                        disabled={chMode === "post" ? chBusy : false}
                      />
                      <button
                        type="submit"
                        className={styles.btnPrimary}
                        disabled={
                          chMode === "post"
                            ? chBusy || chInput.trim() === ""
                            : chInput.trim() === "" ||
                              (activeJob && jobStatus === "running"
                                ? false
                                : !runAgent)
                        }
                      >
                        {activeJob && jobStatus === "running"
                          ? "↪ Divert"
                          : chMode === "post"
                            ? chBusy
                              ? "…"
                              : "Post"
                            : "Run"}
                      </button>
                      {activeJob && jobStatus === "running" && (
                        <button
                          type="button"
                          className={styles.btnDanger}
                          onClick={stopJob}
                        >
                          ■ Stop
                        </button>
                      )}
                    </form>
                  </div>
                </>
              )}
            </section>

            {/* --------------------------------------------- right column -- */}
            <div className={styles.rightCol}>
              {/* member list above project */}
              <aside className={styles.memberPanel}>
                <div className={styles.memberPanelHead}>
                  <span className={styles.wsBlockTitle}>Members</span>
                  {memberStatusLoading && (
                    <span className={styles.mutedSmall}>…</span>
                  )}
                </div>
                {!detail || detail.members.length === 0 ? (
                  <div className={styles.muted}>No members</div>
                ) : (
                  <div className={styles.memberList}>
                    {detail.members.map((m) => {
                      const st = memberStatus.find((s) => s.agentName === m);
                      const isActive =
                        st?.status === "running" || m === liveAgent;
                      const isSel = selMember === m;
                      return (
                        <button
                          key={m}
                          className={`${styles.memberRow} ${
                            isSel ? styles.memberRowSel : ""
                          }`}
                          onClick={() =>
                            setSelMember((cur) => (cur === m ? null : m))
                          }
                          title="Show debugging status"
                        >
                          <span
                            className={`${styles.memberDot} ${
                              isActive ? styles.memberDotActive : ""
                            }`}
                          />
                          <span className={styles.memberRowName}>
                            {m}
                            {st?.status === "running" && (
                              <span className={styles.memberRunning}>
                                running…
                              </span>
                            )}
                          </span>
                          {st?.status &&
                            st.status !== "running" && (
                              <span
                                className={`${styles.memberBadge} ${
                                  styles[`memberBadge${st.status}`]
                                }`}
                              >
                                {st.status}
                              </span>
                            )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* selected member debugging status */}
                {selMember && detail && (
                  <MemberDebug
                    memberStatus={memberStatus.find(
                      (s) => s.agentName === selMember,
                    )}
                    memberName={selMember}
                  />
                )}
              </aside>

              <aside className={styles.projectPanel}>
                <div className={styles.wsBlockTitle}>Project</div>
                {detail ? (
                  detail.projectTree && isProjDir(detail.projectTree) ? (
                    <ChannelTree
                      node={detail.projectTree}
                      collapsed={collapsed}
                      onToggle={toggleCollapse}
                    />
                  ) : (
                    <div className={styles.muted}>No project tree</div>
                  )
                ) : (
                  <div className={styles.muted}>Select a channel</div>
                )}
              </aside>
            </div>
          </div>
        </>
      )}

      {showNew && (
        <div className={styles.modalOverlay} onClick={() => setShowNew(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>New channel</div>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name *</span>
              <input
                className={styles.fieldInput}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="# channel name"
                autoFocus
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Project name (optional)</span>
              <input
                className={styles.fieldInput}
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                placeholder="projectName"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Creator agent (optional)</span>
              <input
                className={styles.fieldInput}
                value={newCreator}
                onChange={(e) => setNewCreator(e.target.value)}
                placeholder="creatorAgent"
              />
            </label>
            <div className={styles.modalActions}>
              <button
                className={styles.btnGhost}
                onClick={() => setShowNew(false)}
                disabled={creating}
              >
                Cancel
              </button>
              <button
                className={styles.btnPrimary}
                onClick={createChannel}
                disabled={creating || newName.trim() === ""}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ sub-renders ------------------------------ */

function LiveJobEvents({ events }: { events: ChannelJobEvent[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <>
      {events.map((ev, i) => {
        const key = `${ev.type}-${i}-${ev.ts ?? ""}`;
        if (ev.type === "tool_call") {
          const args = ev.arguments ?? "";
          return (
            <div key={key} className={`${styles.chMsg} ${styles.liveToolRow}`}>
              <div className={styles.chMsgLabel}>
                <span className={styles.chMsgAuthor}>🔧 {ev.name}</span>
                <span className={styles.chMsgRole}>[step {ev.step ?? i + 1}]</span>
              </div>
              <button
                className={styles.liveTool}
                onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
              >
                <span className={styles.traceCaret}>{open[i] ? "▾" : "▸"}</span>
                <code>{ev.name}</code>
                <span className={styles.traceArgs}>
                  {args.length > 80 ? args.slice(0, 80) + "…" : args}
                </span>
              </button>
              {open[i] && (
                <div className={styles.liveBody}>
                  {ev.arguments != null && (
                    <>
                      <div className={styles.traceLabel}>args</div>
                      <pre className={styles.traceCode}>{ev.arguments}</pre>
                    </>
                  )}
                  {ev.result != null && (
                    <>
                      <div className={styles.traceLabel}>result</div>
                      <pre className={styles.traceCode}>{ev.result}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        }
        if (ev.type === "interject") {
          return (
            <div key={key} className={`${styles.chMsg} ${styles.liveYou}`}>
              <div className={styles.chMsgLabel}>
                <span className={styles.chMsgAuthor}>you</span>
                <span className={styles.chMsgRole}>[interjected while working]</span>
              </div>
              <div className={styles.chMsgText}>{ev.text}</div>
            </div>
          );
        }
        if (ev.type === "answer") {
          return (
            <div key={key} className={styles.chMsg}>
              <div className={styles.chMsgLabel}>
                <span className={styles.chMsgAuthor}>agent</span>
                <span className={styles.chMsgRole}>[answer]</span>
              </div>
              <div className={styles.chMsgText}>{ev.text}</div>
            </div>
          );
        }
        if (ev.type === "error") {
          return (
            <div key={key} className={`${styles.chMsg} ${styles.liveError}`}>
              <div className={styles.chMsgRole}>[error]</div>
              <div className={styles.chMsgText}>{ev.text}</div>
            </div>
          );
        }
        if (ev.type === "stopped") {
          return (
            <div key={key} className={`${styles.chMsg} ${styles.liveStopped}`}>
              <div className={styles.chMsgRole}>[stopped]</div>
              <div className={styles.chMsgText}>{ev.text}</div>
            </div>
          );
        }
        return (
          <div key={key} className={`${styles.chMsg} ${styles.liveStatus}`}>
            <div className={styles.chMsgRole}>[status]</div>
            <div className={styles.chMsgText}>{ev.text}</div>
          </div>
        );
      })}
    </>
  );
}

function MemberDebug({
  memberName,
  memberStatus,
}: {
  memberName: string;
  memberStatus: MemberStatus | undefined;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (!memberStatus || !memberStatus.hasRun) {
    return (
      <div className={styles.memberDebug}>
        <div className={styles.memberDebugName}>{memberName}</div>
        <div className={styles.mutedSmall}>
          No debugging activity yet. Post a message or run an agent to see its
          live status (tool calls, answer, errors).
        </div>
      </div>
    );
  }
  const events = memberStatus.events ?? [];
  const running = memberStatus.status === "running";
  // Derive "what it is/was running" from the most recent meaningful events:
  // the freshest tool_call (name+args) or status text. Computed regardless of
  // running state so the debug status always shows the agent's activity.
  let currentActivity: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "tool_call" && ev.name) {
      currentActivity = `Running tool: ${ev.name}`;
      break;
    }
  }
  if (!currentActivity) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "status" && ev.text) {
        currentActivity = ev.text;
        break;
      }
    }
  }
  return (
    <div className={styles.memberDebug}>
      <div className={styles.memberDebugName}>{memberName}</div>
      <div className={styles.memberDebugMeta}>
        <span
          className={`${styles.memberDebugStatus} ${
            styles[`memberBadge${memberStatus.status ?? "null"}`] ??
            styles.memberBadgenull
          }`}
        >
          {running
            ? "running…"
            : memberStatus.status ?? "idle"}
        </span>
        {memberStatus.startedAt && (
          <span className={styles.mutedSmall}>
            started {new Date(memberStatus.startedAt).toLocaleTimeString()}
          </span>
        )}
        {memberStatus.steps != null && (
          <span className={styles.mutedSmall}>
            · {memberStatus.steps} tool call{memberStatus.steps === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {currentActivity && (
        <div className={styles.memberDebugCurrent}>
          <span className={styles.memberDebugCurrentLabel}>
            {running ? "⚙ Currently running" : "⚙ Last activity"}
          </span>
          <span className={styles.memberDebugCurrentText}>
            {currentActivity}
            {running ? <span className={styles.spinner}> ▚</span> : null}
          </span>
        </div>
      )}
      {memberStatus.error && (
        <div className={styles.memberDebugError}>{memberStatus.error}</div>
      )}
      {memberStatus.answer && (
        <div className={styles.memberDebugAnswer}>
          <div className={styles.memberDebugLabel}>Last answer</div>
          <div>{memberStatus.answer}</div>
        </div>
      )}
      {events.length > 0 && (
        <div className={styles.memberDebugEvents}>
          <div className={styles.memberDebugLabel}>
            Debug trace ({events.length})
          </div>
          {events.slice(0, 60).map((ev, i) => (
            <div key={i} className={styles.memberDebugEvRow}>
              {ev.type === "tool_call" ? (
                <button
                  className={styles.memberDebugEv}
                  onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
                >
                  <span className={styles.traceCaret}>
                    {open[i] ? "▾" : "▸"}
                  </span>
                  <span className={styles.memberDebugEvType}>🔧</span>
                  <code>{ev.name}</code>
                  <span className={styles.traceArgs}>
                    {ev.arguments != null && ev.arguments.length > 60
                      ? ev.arguments.slice(0, 60) + "…"
                      : ev.arguments ?? ""}
                  </span>
                </button>
              ) : (
                <div className={`${styles.memberDebugEv} ${styles.memberDebugEvText}`}>
                  <span className={styles.memberDebugEvType}>
                    {ev.type === "interject"
                      ? "↩"
                      : ev.type === "answer"
                        ? "▣"
                        : ev.type === "error"
                          ? "✕"
                          : ev.type === "stopped"
                            ? "■"
                            : "•"}
                  </span>
                  <span>{ev.text}</span>
                </div>
              )}
              {open[i] && ev.type === "tool_call" && (
                <div className={styles.memberDebugEvBody}>
                  {ev.arguments != null && (
                    <>
                      <div className={styles.traceLabel}>args</div>
                      <pre className={styles.traceCode}>{ev.arguments}</pre>
                    </>
                  )}
                  {ev.result != null && (
                    <>
                      <div className={styles.traceLabel}>result</div>
                      <pre className={styles.traceCode}>{ev.result}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {events.length > 60 && (
            <div className={styles.mutedSmall}>
              … {events.length - 60} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TraceView({ trace }: { trace: ToolTraceStep[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <div className={styles.trace}>
      <div className={styles.traceHeader}>
        <span>
          {trace.length} tool call{trace.length === 1 ? "" : "s"}
        </span>
      </div>
      {trace.map((t, i) => (
        <div key={i} className={styles.traceStep}>
          <button
            className={styles.traceTool}
            onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
          >
            <span className={styles.traceCaret}>{open[i] ? "▾" : "▸"}</span>
            <code>{t.name}</code>
            <span className={styles.traceArgs}>
              {t.arguments.length > 80
                ? t.arguments.slice(0, 80) + "…"
                : t.arguments}
            </span>
          </button>
          {open[i] && (
            <div className={styles.traceBody}>
              <div className={styles.traceLabel}>args</div>
              <pre className={styles.traceCode}>{t.arguments}</pre>
              <div className={styles.traceLabel}>result</div>
              <pre className={styles.traceCode}>{t.result}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function renderTree(
  node: DirNode | null | undefined,
  styles: { [k: string]: string },
  prefix = "",
): React.ReactNode {
  if (!node || !isDir(node)) return <div className={styles.muted}>∅</div>;
  const names = Object.keys(node);
  if (names.length === 0) return <div className={styles.muted}>∅</div>;
  return (
    <ul className={styles.treeList}>
      {names.map((name) => {
        const child = node[name];
        const isFolder = isDir(child);
        return (
          <li key={prefix + name} className={styles.treeLeaf}>
            <span className={isFolder ? styles.treeFolder : styles.treeFile}>
              {isFolder ? "📁" : "📄"} {name}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ChannelTree({
  node,
  collapsed,
  onToggle,
  path,
}: {
  node: unknown;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  path?: string;
}): React.ReactNode {
  if (!isProjDir(node)) return <div className={styles.muted}>∅</div>;
  const entries = Object.entries(node as Record<string, unknown>);
  if (entries.length === 0) return <div className={styles.muted}>∅</div>;
  const key = path ?? "";
  return (
    <div className={styles.treeNested} style={key ? undefined : { marginLeft: 0 }}>
      <ul className={styles.treeList}>
        {entries.map(([name, child]) => {
          const childPath = key ? `${key}::${name}` : name;
          const isFolder = isProjDir(child);
          if (isFolder) {
            const open = !collapsed[childPath];
            return (
              <li key={childPath} className={styles.treeLeaf}>
                <button
                  className={styles.treeItem}
                  onClick={() => onToggle(childPath)}
                >
                  <span className={styles.treeCaret}>{open ? "▾" : "▸"}</span>
                  <span className={styles.treeFolder}>📁 {name}</span>
                </button>
                {open && (
                  <div className={styles.treeNested}>
                    <ChannelTree
                      node={child}
                      collapsed={collapsed}
                      onToggle={onToggle}
                      path={childPath}
                    />
                  </div>
                )}
              </li>
            );
          }
          return (
            <li key={childPath} className={styles.treeLeaf}>
              <span className={styles.treeFile}>📄 {name}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
