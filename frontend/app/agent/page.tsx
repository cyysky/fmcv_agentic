"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./agent.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5555/api";

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

type ChannelJobEvent =
  | { type: "tool_call"; ts: string; name?: string; arguments?: string;
      result?: string; step?: number }
  | { type: "interject"; ts: string; text?: string; step?: number }
  | { type: "answer";   ts: string; text?: string }
  | { type: "status";   ts: string; text?: string }
  | { type: "error";    ts: string; text?: string };

interface ChannelJobResponse {
  jobId: string;
  status: "running" | "done" | "error";
  events: ChannelJobEvent[];
  answer?: string;
  steps?: number;
  error?: string;
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

  // channels view state
  const [view, setView] = useState<"chat" | "channels">("chat");
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
  const [chMode, setChMode] = useState<"post" | "run">("post");
  const [chInput, setChInput] = useState("");
  const [chBusy, setChBusy] = useState(false);
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const chFeedRef = useRef<HTMLDivElement | null>(null);
  const [activeJob, setActiveJob] = useState<{
    jobId: string; channelId: string; agentName: string;
  } | null>(null);
  const [jobEvents, setJobEvents] = useState<ChannelJobEvent[]>([]);
  const [jobStatus, setJobStatus] = useState<"running"|"done"|"error"|null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobSeen, setJobSeen] = useState(0);
  const jobPollRef = useRef<number | null>(null);
  const [liveAgent, setLiveAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/agent/models`);
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
  }, [messages, busy]);

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
      const res = await fetch(`${API_URL}/channels`);
      if (!res.ok) throw new Error(`Failed to load channels (HTTP ${res.status})`);
      const data = (await res.json()) as ChannelSummary[];
      setChannels(data);
      setChannelsError(null);
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to load channels");
    }
  }, []);

  useEffect(() => {
    if (view === "channels" && channels.length === 0) loadChannels();
  }, [view, channels.length, loadChannels]);

  const fetchChannel = useCallback(async (id: string): Promise<ChannelDetail> => {
    const res = await fetch(`${API_URL}/channels/${id}`);
    if (!res.ok) throw new Error(`Failed to load channel (HTTP ${res.status})`);
    return (await res.json()) as ChannelDetail;
  }, []);

  const openChannel = useCallback(
    async (id: string) => {
      if (id !== selChannelId) resetJobState();
      setSelChannelId(id);
      setDetailLoading(true);
      setChannelsError(null);
      try {
        const data = await fetchChannel(id);
        setDetail(data);
        setRunAgent((cur) => cur || (data.members[0] ?? ""));
      } catch (e) {
        setChannelsError(e instanceof Error ? e.message : "Failed to load channel");
      } finally {
        setDetailLoading(false);
      }
    },
    [fetchChannel, selChannelId, resetJobState],
  );

  const createChannel = useCallback(async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setChannelsError(null);
    try {
      const res = await fetch(`${API_URL}/channels`, {
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
        const res = await fetch(`${API_URL}/channels/${id}`, { method: "DELETE" });
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
    [selChannelId],
  );

  const addMember = useCallback(async () => {
    const agentName = memberInput.trim();
    if (!agentName || !selChannelId || memberBusy) return;
    setMemberBusy(true);
    setChannelsError(null);
    try {
      const res = await fetch(`${API_URL}/channels/${selChannelId}/members`, {
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
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to add member");
    } finally {
      setMemberBusy(false);
    }
  }, [memberInput, selChannelId, memberBusy]);

  const removeMember = useCallback(
    async (agentName: string) => {
      if (!selChannelId) return;
      setChannelsError(null);
      try {
        const res = await fetch(
          `${API_URL}/channels/${selChannelId}/members/${encodeURIComponent(agentName)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`Failed to remove member (HTTP ${res.status})`);
        const data = (await res.json()) as ChannelDetail;
        setDetail(data);
        if (runAgent === agentName) setRunAgent(data.members[0] ?? "");
      } catch (e) {
        setChannelsError(e instanceof Error ? e.message : "Failed to remove member");
      }
    },
    [selChannelId, runAgent],
  );

  const postToChannel = useCallback(async () => {
    const text = chInput.trim();
    if (!text || !selChannelId || chBusy) return;
    setChBusy(true);
    setChannelsError(null);
    try {
      const res = await fetch(`${API_URL}/channels/${selChannelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", author: "you", text }),
      });
      if (!res.ok) throw new Error(`Failed to post message (HTTP ${res.status})`);
      const msg = (await res.json()) as ChannelMessage;
      setDetail((d) => (d ? { ...d, messages: [...d.messages, msg] } : d));
      setChInput("");
    } catch (e) {
      setChannelsError(e instanceof Error ? e.message : "Failed to post message");
    } finally {
      setChBusy(false);
    }
  }, [chInput, selChannelId, chBusy]);

  const pollJob = useCallback(
    (jobId: string, channelId: string) => {
      stopPolling();
      jobPollRef.current = window.setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/channels/${channelId}/jobs/${jobId}`);
          if (!res.ok) throw new Error(`Poll failed (HTTP ${res.status})`);
          const data = (await res.json()) as ChannelJobResponse;
          setJobEvents(data.events);
          setJobStatus(data.status);
          setJobError(data.error ?? null);
          if (data.status === "done" || data.status === "error") {
            stopPolling();
            setActiveJob(null);
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
    [stopPolling, fetchChannel],
  );

  const startJob = useCallback(async () => {
    const message = chInput.trim();
    const agentName = runAgent.trim();
    if (!message || !agentName || !selChannelId) return;
    setChannelsError(null);
    try {
      const res = await fetch(`${API_URL}/channels/${selChannelId}/jobs`, {
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
      setJobEvents([]);
      setJobStatus("running");
      setJobError(null);
      setJobSeen(0);
      setChInput("");
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
  }, [chInput, runAgent, runModel, selChannelId, pollJob]);

  const interject = useCallback(async () => {
    const text = chInput.trim();
    if (!text || !activeJob) return;
    setChannelsError(null);
    try {
      const res = await fetch(
        `${API_URL}/channels/${activeJob.channelId}/jobs/${activeJob.jobId}/interject`,
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

  const selectMember = useCallback(
    (agentName: string) => {
      setRunAgent(agentName);
      setLiveAgent(agentName);
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
      const res = await fetch(`${API_URL}/agent/turn`, {
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

  const toggleTab = (next: "chat" | "channels") => {
    setView(next);
    if (next === "channels") loadChannels();
  };

  /* ----------------------- workspace viewer helpers ---------------------- */

  const loadWorkspace = useCallback(async () => {
    if (wsInfo) {
      setShowViewer((s) => !s);
      return;
    }
    setWsError(null);
    try {
      const res = await fetch(`${API_URL}/agent/workspaces`);
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
        const res = await fetch(`${API_URL}/agent/workspaces/agents/${name}`);
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
        const res = await fetch(`${API_URL}/agent/workspaces/projects/${name}`);
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
            disabled={models.length === 0 || view !== "chat"}
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
                  channels.map((c) => (
                    <div
                      key={c.id}
                      className={`${styles.channelRow} ${
                        selChannelId === c.id ? styles.channelRowActive : ""
                      }`}
                    >
                      <button
                        className={styles.channelBtn}
                        onClick={() => openChannel(c.id)}
                      >
                        <span className={styles.channelName}># {c.name}</span>
                        <span className={styles.channelMeta}>
                          {c.memberCount} member{c.memberCount === 1 ? "" : "s"}
                          {c.projectName ? ` · ${c.projectName}` : ""}
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
                  ))
                )}
              </div>
              <button className={styles.btnGhost} onClick={() => setShowNew(true)}>
                ＋ New channel
              </button>
            </aside>

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
                        {jobStatus === "running" && (
                          <div className={`${styles.chMsg} ${styles.liveStatus}`}>
                            <div className={styles.typing}>Agent is working…</div>
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
                        if (chMode === "post") postToChannel();
                        else if (activeJob && jobStatus === "running") interject();
                        else startJob();
                      }}
                    >
                      <textarea
                        className={styles.input}
                        value={chInput}
                        onChange={(e) => setChInput(e.target.value)}
                        placeholder={
                          chMode === "post"
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
                        {chMode === "post"
                          ? chBusy
                            ? "…"
                            : "Post"
                          : activeJob && jobStatus === "running"
                            ? "⏳ Working…"
                            : "Run"}
                      </button>
                    </form>
                  </div>
                </>
              )}
            </section>

            {/* --------------------------------------------- project viewer -- */}
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
