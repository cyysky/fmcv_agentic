"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./agent.module.css";
import { apiFetch } from "../../lib/api";
import dynamic from "next/dynamic";
import type {
  AgentEntry,
  AgentSessionDetail,
  AgentSessionSummary,
  ChannelDetail,
  ChannelJobEvent,
  ChannelJobResponse,
  ChannelMessage,
  ChannelSummary,
  ChatMsg,
  ConnectionOption,
  DirNode,
  MemberStatus,
  ModelOption,
  ToolTraceStep,
  TurnResponse,
  WorkspaceInfo,
} from "./agent-types";
import {
  ChannelsPanelContext,
  SessionsPanelContext,
  WorkspaceViewerContext,
} from "./agent-context";

// Round 93: the sessions/channels tab panels live in agent-views.tsx and are
// loaded on demand, so the /agent first load no longer includes their JSX.
const AgentSessionsView = dynamic(
  () => import("./agent-views").then((m) => m.AgentSessionsPanel),
  { ssr: false },
);
const AgentChannelsView = dynamic(
  () => import("./agent-views").then((m) => m.AgentChannelsPanel),
  { ssr: false },
);
// Round 97: the workspace viewer (agent/project trees + folder icons) is also
// lazy — it loads only after the Workspace header button reveals it.
const WorkspaceViewer = dynamic(() => import("./workspace-viewer"), {
  ssr: false,
});

/* ----------------------------- component -------------------------------- */

export default function AgentPage() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [connectionId, setConnectionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Remember the catalog model chosen for the default gateway while a
  // connection is active, so switching back restores it.
  const lastGatewayModelRef = useRef<string>("");

  // workspace viewer state (Round 97: render moves to a lazy chunk; the
  // header + loaders stay here so the Workspace toggle shares the cache)
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [wsShow, setWsShow] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsSelAgent, setWsSelAgent] = useState<string | null>(null);
  const [wsAgentTrees, setWsAgentTrees] = useState<Record<string, DirNode | null>>({});
  const [wsSelProject, setWsSelProject] = useState<string | null>(null);
  const [wsProjectTrees, setWsProjectTrees] = useState<Record<string, DirNode | null>>({});
  const [wsLoadingTree, setWsLoadingTree] = useState<string | null>(null);

  // sessions view state
  const [view, setView] = useState<"chat" | "sessions" | "channels">("chat");
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selSessionId, setSelSessionId] = useState<string | null>(null);
  const [sessionMsgs, setSessionMsgs] = useState<ChatMsg[]>([]);
  const [sessionInput, setSessionInput] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draftSessionTitle, setDraftSessionTitle] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);

  // channels view state
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [selChannelId, setSelChannelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // The new-channel modal lives in the lazy channels panel; AgentPage only opens it.
  const [, setShowNew] = useState(false);
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

  // Saved Connections (from Settings) can pin chat sessions/turns to a
  // custom provider — endpoint, model, key, and default parameters all come
  // from the chosen row instead of the built-in gateway.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/connections`);
        if (!res.ok) throw new Error(`Failed to load connections (HTTP ${res.status})`);
        const data = (await res.json()) as ConnectionOption[];
        if (!cancelled) setConnections(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load connections");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedConn = connections.find((c) => c.id === connectionId) ?? null;

  // With a connection selected the model picker offers the connection's own
  // model as the default (value "") plus catalog overrides. A catalog model
  // is sent only when it differs from the connection's modelName, so the
  // default path stays "model omitted, connection model wins".
  const sendModel = !!model && (!selectedConn || model !== selectedConn.modelName);

  const handleConnectionChange = (value: string) => {
    if (value) {
      lastGatewayModelRef.current = model;
      setConnectionId(value);
      // Defer to the connection's own model until the user picks an override.
      setModel("");
    } else {
      setConnectionId("");
      setModel(lastGatewayModelRef.current || "");
    }
  };

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
  // newly created sub-channels appear without a page reload. Round 98: skip
  // the refresh while the tab is hidden (visibilityState gate) so idle
  // background tabs stop polling the backend; the existing interval resumes
  // on the next tick once the tab is visible again.
  useEffect(() => {
    if (view !== "channels") return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== "hidden") loadChannels();
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
        body: JSON.stringify({
          message: text,
          history,
          ...(sendModel ? { model } : {}),
          ...(selectedConn ? { connectionId: selectedConn.id } : {}),
        }),
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
  }, [input, busy, model, messages, selectedConn, sendModel]);

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

  const connLabel = useCallback(
    (id: string | undefined): string | null =>
      id ? (connections.find((c) => c.id === id)?.displayName ?? null) : null,
    [connections],
  );

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
      const pinned = !!data.connectionId && connections.some((c) => c.id === data.connectionId);
      setConnectionId(pinned ? (data.connectionId as string) : "");
      // A pinned session answers with its connection's model unless the user
      // picks a catalog override again — per-chat overrides are not
      // resurrected silently on reopen.
      setModel((cur) => (pinned ? "" : data.model || cur));
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
  }, [connections]);

  const createSession = useCallback(async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    setSessionsError(null);
    try {
      const res = await apiFetch(`/agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(sendModel ? { model } : {}),
          ...(selectedConn ? { connectionId: selectedConn.id } : {}),
        }),
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
  }, [creatingSession, model, loadSessions, openSession, selectedConn, sendModel]);

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

  const startSessionRename = useCallback((s: AgentSessionSummary) => {
    setEditingSessionId(s.id);
    setDraftSessionTitle(s.title && s.title !== "New session" ? s.title : "");
  }, []);

  const commitSessionRename = useCallback(
    async (id: string) => {
      const title = draftSessionTitle.trim();
      const current = sessions.find((s) => s.id === id)?.title;
      if (!title || title === current) {
        setEditingSessionId(null);
        return;
      }
      setSessionsError(null);
      try {
        const res = await apiFetch(`/agent/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!res.ok) throw new Error(`Failed to rename session (HTTP ${res.status})`);
        setEditingSessionId(null);
        setDraftSessionTitle("");
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
      } catch (e) {
        setSessionsError(e instanceof Error ? e.message : "Failed to rename session");
        setEditingSessionId(id);
      }
    },
    [draftSessionTitle, sessions],
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
        body: JSON.stringify({
          message: text,
          ...(sendModel ? { model } : {}),
          ...(selectedConn ? { connectionId: selectedConn.id } : {}),
        }),
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
        // The backend auto-titles a default-titled session from its first
        // user message; refresh the sidebar so the new title shows up.
        void loadSessions();
      }
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSessionBusy(false);
    }
  }, [sessionInput, sessionBusy, selSessionId, model, loadSessions, selectedConn, sendModel]);

  /* ----------------------- workspace viewer helpers ---------------------- */

  const loadWorkspace = useCallback(async () => {
    if (wsInfo) {
      setWsShow((s) => !s);
      return;
    }
    setWsError(null);
    try {
      const res = await apiFetch(`/agent/workspaces`);
      if (!res.ok) throw new Error(`Failed to load workspace (HTTP ${res.status})`);
      const data = (await res.json()) as WorkspaceInfo;
      setWsInfo(data);
      setWsShow(true);
    } catch (e) {
      setWsError(e instanceof Error ? e.message : "Failed to load workspace");
    }
  }, [wsInfo]);

  const loadAgentTree = useCallback(
    async (name: string) => {
      if (wsAgentTrees[name] !== undefined) {
        setWsSelAgent((cur) => (cur === name ? null : name));
        return;
      }
      setWsLoadingTree(name);
      try {
        const res = await apiFetch(`/agent/workspaces/agents/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DirNode | null;
        setWsAgentTrees((prev) => ({ ...prev, [name]: data }));
        setWsSelAgent(name);
      } catch (e) {
        setWsError(e instanceof Error ? e.message : `Failed to load ${name}`);
      } finally {
        setWsLoadingTree(null);
      }
    },
    [wsAgentTrees],
  );

  const loadProjectTree = useCallback(
    async (name: string) => {
      if (wsProjectTrees[name] !== undefined) {
        setWsSelProject((cur) => (cur === name ? null : name));
        return;
      }
      setWsLoadingTree(name);
      try {
        const res = await apiFetch(`/agent/workspaces/projects/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DirNode | null;
        setWsProjectTrees((prev) => ({ ...prev, [name]: data }));
        setWsSelProject(name);
      } catch (e) {
        setWsError(e instanceof Error ? e.message : `Failed to load ${name}`);
      } finally {
        setWsLoadingTree(null);
      }
    },
    [wsProjectTrees],
  );

  const toggleCollapse = (path: string) =>
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));

  /* --------------- lazy panels: context values (Round 96) --------------- */

  const sessionsPanelValue = {
    sessions,
    sessionsError,
    setSessionsError,
    creatingSession,
    createSession,
    selSessionId,
    openSession,
    editingSessionId,
    setEditingSessionId,
    draftSessionTitle,
    setDraftSessionTitle,
    commitSessionRename,
    connLabel,
    startSessionRename,
    deleteSession,
    selectedConn,
    sessionLoading,
    sessionMsgs,
    sessionBusy,
    endRef,
    sessionInput,
    setSessionInput,
    sendSession,
  };

  const channelsPanelValue = {
    channelsError,
    setChannelsError,
    channels,
    selChannelId,
    openChannel,
    deleteChannel,
    setShowNew,
    dmOpen,
    setDmOpen,
    dmBusy,
    loadAvailableAgents,
    availableAgents,
    openDirectMessage,
    detail,
    liveAgent,
    runAgent,
    setRunAgent,
    selectMember,
    removeMember,
    memberInput,
    setMemberInput,
    addMember,
    memberBusy,
    chFeedRef,
    detailLoading,
    chBusy,
    chMode,
    setChMode,
    jobEvents,
    jobSeen,
    jobStatus,
    jobError,
    activeJob,
    interject,
    postToChannel,
    startJob,
    stopJob,
    runModel,
    setRunModel,
    models,
    chInput,
    setChInput,
    memberStatusLoading,
    memberStatus,
    selMember,
    setSelMember,
    collapsed,
    toggleCollapse,
    newName,
    setNewName,
    newProject,
    setNewProject,
    newCreator,
    setNewCreator,
    creating,
    createChannel,
  };

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
            {wsInfo && wsShow ? "Hide Workspace" : "Workspace"}
          </button>
          <select
            className={styles.modelSelect}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={view === "channels" || (models.length === 0 && !selectedConn)}
            title={
              selectedConn
                ? model
                  ? `Using ${model} via ${selectedConn.displayName}`
                  : `Using the connection's model (${selectedConn.modelName})`
                : undefined
            }
          >
            {selectedConn ? (
              <>
                <option value="">{selectedConn.modelName} (connection default)</option>
                {(selectedConn.models ?? [])
                  .filter(
                    (m) =>
                      m.toLowerCase() !== selectedConn.modelName.toLowerCase(),
                  )
                  .map((m) => (
                    <option key={m} value={m}>
                      {m} (connection)
                    </option>
                  ))}
                {models
                  .filter(
                    (m) =>
                      m.id.toLowerCase() !==
                        selectedConn.modelName.toLowerCase() &&
                      !(selectedConn.models ?? []).some(
                        (cm) => cm.toLowerCase() === m.id.toLowerCase(),
                      ),
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </>
            ) : models.length === 0 ? (
              <option value="">Loading models…</option>
            ) : (
              models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))
            )}
          </select>
          <select
            className={styles.modelSelect}
            value={connectionId}
            onChange={(e) => handleConnectionChange(e.target.value)}
            disabled={view === "channels"}
            aria-label="Settings connection"
            title={
              selectedConn
                ? model
                  ? `Chat uses ${model} at ${selectedConn.baseUrl}`
                  : `Chat uses ${selectedConn.modelName} at ${selectedConn.baseUrl}`
                : "Chat uses the default gateway + catalog model"
            }
          >
            <option value="">Default gateway</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} · {c.modelName}
              </option>
            ))}
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

      {view === "chat" && wsShow && (
        <WorkspaceViewerContext.Provider
          value={{
            wsInfo,
            wsError,
            setWsError,
            wsShow,
            wsLoadingTree,
            wsSelAgent,
            wsAgentTrees,
            wsSelProject,
            wsProjectTrees,
            wsLoadAgentTree: loadAgentTree,
            wsLoadProjectTree: loadProjectTree,
          }}
        >
          <WorkspaceViewer />
        </WorkspaceViewerContext.Provider>
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
        <SessionsPanelContext.Provider value={sessionsPanelValue}>
          <AgentSessionsView />
        </SessionsPanelContext.Provider>
      )}
      {view === "channels" && (
        <ChannelsPanelContext.Provider value={channelsPanelValue}>
          <AgentChannelsView />
        </ChannelsPanelContext.Provider>
      )}
    </div>
  );
}

/* ------------------------------ sub-renders ------------------------------ */

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


