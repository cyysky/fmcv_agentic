"use client";

import { useEffect, useState } from "react";
import styles from "./files.module.css";
import { API_URL, apiFetch } from "../../lib/api";

/* ------------------------------- types ---------------------------------- */

interface ScopeAgent {
  name: string;
  label: string;
  description: string;
  root: string;
  workDir: string;
}

interface WorkspaceInfo {
  root: string;
  projectsDir: string;
  projects: { name: string; path: string }[];
  agents: ScopeAgent[];
}

type EntryType = "file" | "directory";

interface FileEntry {
  name: string;
  type: EntryType;
  size: number;
  mtimeMs: number;
}

interface FileListResponse {
  scope: string;
  path: string;
  entries: FileEntry[];
}

interface FileReadResponse {
  scope: string;
  path: string;
  size: number;
  content: string;
}

type Draft =
  | { kind: "new-file"; name: string; content: string }
  | { kind: "new-folder"; name: string }
  | { kind: "edit"; target: string; name: string; content: string };

interface ViewerState {
  target: string;
  entry: FileEntry;
  content: string | null;
  loading: boolean;
  error?: string;
}

/* ------------------------------- helpers -------------------------------- */

const query = (params: Record<string, string>): string => {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) usp.set(key, value);
  return usp.toString();
};

async function apiError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.message === "string") detail = body.message;
    else if (Array.isArray(body?.message)) detail = body.message.join("; ");
    else if (typeof body?.error === "string") detail = body.error;
  } catch {
    /* non-JSON error body */
  }
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

const joinPath = (dir: string, name: string): string =>
  dir ? `${dir}/${name}` : name;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

const isHtmlName = (name: string): boolean => /\.html?$/i.test(name);

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/* ------------------------------ component ------------------------------- */

export default function FilesPanel() {
  const [agents, setAgents] = useState<ScopeAgent[]>([]);
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [scope, setScope] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const readOnly = scope.startsWith("project:");

  // Discover the scopes the backend exposes (agents + public projects).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/agent/workspaces");
        if (!res.ok) throw new Error(await apiError(res));
        const info = (await res.json()) as WorkspaceInfo;
        if (cancelled) return;
        setAgents(info.agents);
        setProjects(info.projects);
        if (info.agents.length > 0) setScope(`agent:${info.agents[0].name}`);
      } catch (e) {
        if (!cancelled) setWorkspaceError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the one-level listing for the current scope/path.
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/files/list?${query({ scope, path })}`);
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as FileListResponse;
        if (cancelled) return;
        setEntries(body.entries);
      } catch (e) {
        if (cancelled) return;
        setEntries([]);
        setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, path, reloadKey]);

  const changeScope = (value: string) => {
    setScope(value);
    setPath("");
    setViewer(null);
    setDraft(null);
    setNotice(null);
  };

  const navigate = (nextPath: string) => {
    setPath(nextPath);
    setViewer(null);
    setDraft(null);
    setNotice(null);
  };

  const crumbs = path ? ["", ...path.split("/")] : [""];

  const openViewer = async (entry: FileEntry) => {
    const target = joinPath(path, entry.name);
    setViewer({ target, entry, content: null, loading: true });
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/files/read?${query({ scope, path: target })}`);
      if (!res.ok) throw new Error(await apiError(res));
      const body = (await res.json()) as FileReadResponse;
      setViewer((v) =>
        v && v.target === target ? { ...v, content: body.content, loading: false } : v,
      );
    } catch (e) {
      setViewer((v) =>
        v && v.target === target
          ? {
              ...v,
              loading: false,
              // HTML previews stream inline even when the (capped) text read
              // fails, e.g. for pages larger than the viewer cap.
              error: isHtmlName(entry.name) ? undefined : errText(e),
            }
          : v,
      );
    }
  };

  const startEdit = async (entry: FileEntry) => {
    const target = joinPath(path, entry.name);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/files/read?${query({ scope, path: target })}`);
      if (!res.ok) throw new Error(await apiError(res));
      const body = (await res.json()) as FileReadResponse;
      setViewer(null);
      setDraft({ kind: "edit", target, name: entry.name, content: body.content });
    } catch (e) {
      setError(errText(e));
    }
  };

  const editViewerFile = () => {
    if (!viewer) return;
    setDraft({
      kind: "edit",
      target: viewer.target,
      name: viewer.entry.name,
      content: viewer.content ?? "",
    });
    setViewer(null);
    setNotice(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    setDraftBusy(true);
    setError(null);
    setNotice(null);
    let successText = "";
    try {
      if (draft.kind === "new-file" || draft.kind === "edit") {
        const name = draft.name.trim();
        if (draft.kind === "new-file" && !name) {
          throw new Error("File name is required");
        }
        const target =
          draft.kind === "edit" ? draft.target : joinPath(path, name);
        const res = await apiFetch(
          `/files/write?${query({ scope, path: target })}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: draft.content }),
          },
        );
        if (!res.ok) throw new Error(await apiError(res));
        successText =
          draft.kind === "edit" ? `Saved ${target}` : `Created ${target}`;
      } else {
        const name = draft.name.trim();
        if (!name) throw new Error("Folder name is required");
        const res = await apiFetch(
          `/files/mkdir?${query({ scope, path: joinPath(path, name) })}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(await apiError(res));
        successText = `Created folder ${joinPath(path, name)}`;
      }
      setDraft(null);
      setViewer(null);
      setReloadKey((k) => k + 1);
      setNotice(successText);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDraftBusy(false);
    }
  };

  const downloadEntry = async (entry: FileEntry) => {
    const target = joinPath(path, entry.name);
    try {
      const res = await apiFetch(`/files/download?${query({ scope, path: target })}`);
      if (!res.ok) throw new Error(await apiError(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${target}`);
    } catch (e) {
      setError(errText(e));
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    const target = joinPath(path, entry.name);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(
        `/files/delete?${query({ scope, path: target })}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(await apiError(res));
      if (entry.type === "directory" && target === path) setPath("");
      if (viewer?.target === target) setViewer(null);
      if (draft?.kind === "edit" && draft.target === target) setDraft(null);
      setNotice(`Deleted ${target}`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(errText(e));
    }
  };

  const htmlViewUrl =
    viewer && !viewer.loading && !viewer.error && isHtmlName(viewer.entry.name)
      ? `${API_URL}/files/view?${query({ scope, path: viewer.target })}`
      : null;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Files</h1>
          <p className={styles.subtitle}>
            Browse and edit agent workspaces and public project folders.
          </p>
        </div>
        <div className={styles.headerActions}>
          <select
            aria-label="Scope"
            className={styles.select}
            value={scope}
            onChange={(e) => changeScope(e.target.value)}
            disabled={!scope}
          >
            {scope === "" && <option value="">Loading scopes…</option>}
            {agents.length > 0 && (
              <optgroup label="Agents (read/write)">
                {agents.map((a) => (
                  <option key={a.name} value={`agent:${a.name}`}>
                    {a.label}
                  </option>
                ))}
              </optgroup>
            )}
            {projects.length > 0 && (
              <optgroup label="Projects (read only)">
                {projects.map((p) => (
                  <option key={p.name} value={`project:${p.name}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            className={styles.btnGhost}
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Refresh
          </button>
        </div>
      </header>

      {(error || workspaceError) && (
        <button
          className={styles.errorBanner}
          title="Dismiss"
          onClick={() => {
            setError(null);
            setWorkspaceError(null);
            setNotice(null);
          }}
        >
          {error ?? workspaceError}
        </button>
      )}

      {notice && (
        <button
          className={styles.successBanner}
          title="Dismiss"
          onClick={() => setNotice(null)}
        >
          {notice}
        </button>
      )}

      {readOnly && (
        <div className={styles.badge}>Read-only scope — edits disabled</div>
      )}

      <nav className={styles.breadcrumb} aria-label="Path">
        {crumbs.map((seg, i) => {
          const isLast = i === crumbs.length - 1;
          const target = crumbs.slice(1, i + 1).join("/");
          return (
            <span key={i} className={styles.crumbItem}>
              {i > 0 && <span className={styles.crumbSep}>/</span>}
              {isLast ? (
                <span className={styles.crumbCurrent}>
                  {seg === "" ? "root" : seg}
                </span>
              ) : (
                <button
                  className={styles.crumbLink}
                  onClick={() => navigate(target)}
                >
                  {seg === "" ? "root" : seg}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      {!readOnly && (
        <div className={styles.toolbar}>
          <button
            className={styles.btnPrimary}
            onClick={() => {
              setViewer(null);
              setDraft({ kind: "new-file", name: "", content: "" });
              setNotice(null);
            }}
          >
            New file
          </button>
          <button
            className={styles.btnGhost}
            onClick={() => {
              setViewer(null);
              setDraft({ kind: "new-folder", name: "" });
              setNotice(null);
            }}
          >
            New folder
          </button>
        </div>
      )}

      {draft && !readOnly && (
        <form
          className={styles.panel}
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <div className={styles.panelTitle}>
            {draft.kind === "new-file"
              ? "New file"
              : draft.kind === "new-folder"
                ? "New folder"
                : `Edit ${draft.name}`}
          </div>
          {draft.kind !== "edit" && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                aria-label="File name"
                className={styles.input}
                value={draft.name}
                placeholder={
                  draft.kind === "new-folder" ? "folder-name" : "notes/hello.txt"
                }
                onChange={(e) =>
                  setDraft({ ...draft, name: e.target.value })
                }
              />
            </label>
          )}
          {draft.kind !== "new-folder" && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Content</span>
              <textarea
                aria-label="File content"
                className={styles.textarea}
                value={draft.content}
                rows={5}
                placeholder="file content (optional)"
                onChange={(e) =>
                  setDraft({ ...draft, content: e.target.value })
                }
              />
            </label>
          )}
          <div className={styles.panelActions}>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={draftBusy}
            >
              {draft.kind === "edit" ? "Save" : "Create"}
            </button>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={() => {
                setDraft(null);
                setViewer(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading && entries.length === 0 ? (
        <div className={styles.muted}>Loading…</div>
      ) : entries.length === 0 && !error ? (
        <div className={styles.muted}>This folder is empty.</div>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.name} className={styles.row} data-name={entry.name}>
              <span className={styles.rowIcon}>
                {entry.type === "directory" ? "📁" : "📄"}
              </span>
              {entry.type === "directory" ? (
                <button
                  className={styles.rowName}
                  onClick={() => navigate(joinPath(path, entry.name))}
                >
                  {entry.name}
                </button>
              ) : (
                <span className={styles.rowName}>{entry.name}</span>
              )}
              <span className={styles.rowMeta}>
                {entry.type === "file" ? formatSize(entry.size) : "—"}
              </span>
              <span className={styles.rowMeta}>
                {formatTime(entry.mtimeMs)}
              </span>
              <span className={styles.rowActions}>
                <button
                  className={styles.btnGhost}
                  onClick={() => openViewer(entry)}
                >
                  View
                </button>
                {entry.type === "file" && (
                  <button
                    className={styles.btnGhost}
                    onClick={() => downloadEntry(entry)}
                  >
                    Download
                  </button>
                )}
                {!readOnly && (
                  <>
                    <button
                      className={styles.btnGhost}
                      onClick={() => startEdit(entry)}
                    >
                      Edit
                    </button>
                    <button
                      className={styles.btnDanger}
                      onClick={() => deleteEntry(entry)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {viewer && (
        <div className={styles.panel}>
          <div className={styles.panelTitle}>
            <span className={styles.viewerName}>{viewer.entry.name}</span>
            <span className={styles.panelActions}>
              {htmlViewUrl && (
                <a
                  className={styles.btnLink}
                  href={htmlViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open HTML in new tab"
                >
                  Open in new tab
                </a>
              )}
              {viewer.entry.type === "file" && (
                <button
                  className={styles.btnGhost}
                  onClick={() => downloadEntry(viewer.entry)}
                >
                  Download
                </button>
              )}
              {!readOnly && (
                <button className={styles.btnGhost} onClick={editViewerFile}>
                  Edit
                </button>
              )}
              <button
                className={styles.btnGhost}
                onClick={() => setViewer(null)}
              >
                Close
              </button>
            </span>
          </div>
          {viewer.loading ? (
            <div className={styles.muted}>Loading…</div>
          ) : viewer.error ? (
            <pre className={`${styles.viewer} ${styles.viewerError}`}>
              {viewer.error}
            </pre>
          ) : htmlViewUrl ? (
            <iframe
              aria-label="HTML preview"
              className={styles.htmlFrame}
              src={htmlViewUrl}
              sandbox=""
              title={`Preview of ${viewer.entry.name}`}
            />
          ) : (
            <pre className={styles.viewer}>{viewer.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}
