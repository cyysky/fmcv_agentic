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

  /* ----------------------- workspace viewer helpers ---------------------- */

  const loadWorkspace = useCallback(async () => {
    if (wsInfo) {
      setShowViewer((s) => !s);
      return;
    }
    setWsError(null);
    try {
      const res = await fetch(`${API_URL}/agent/workspaces`);
      if (!res.ok) throw new Error(`Failed to load workspaces (HTTP ${res.status})`);
      const data = (await res.json()) as WorkspaceInfo;
      setWsInfo(data);
      setShowViewer(true);
    } catch (e) {
      setWsError(e instanceof Error ? e.message : "Failed to load workspaces");
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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Agent</h1>
          <p className={styles.subtitle}>
            Chat with the workspace agent — it can read and write files in its
            own folder.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.btnGhost}
            onClick={loadWorkspace}
            disabled={busy}
          >
            {wsInfo && showViewer ? "Hide Workspace" : "Workspace"}
          </button>
          <select
            className={styles.modelSelect}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={models.length === 0}
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
            disabled={messages.length === 0 || busy}
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.bannerError} onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showViewer && wsInfo && (
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
