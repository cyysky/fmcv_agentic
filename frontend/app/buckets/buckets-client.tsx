"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./buckets.module.css";
import { apiFetch } from "../../lib/api";

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

type FolderType = "agent" | "project";

interface BucketRow {
  id: string;
  name: string;
  folderType: FolderType;
  folderName: string;
  createdAt: string;
  updatedAt: string;
  _count?: { documents: number };
}

type DocumentKind = "pdf" | "text" | "video" | "audio" | "other";

interface ManagedDocument {
  id: string;
  bucketId: string;
  name: string;
  kind: DocumentKind;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
}

interface BucketDetail extends BucketRow {
  documents: ManagedDocument[];
}

/* ------------------------------- helpers -------------------------------- */

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const KIND_ICON: Record<DocumentKind, string> = {
  text: "📄",
  pdf: "📕",
  video: "🎬",
  audio: "🎵",
  other: "📦",
};

const KIND_CLASS: Record<DocumentKind, string> = {
  pdf: styles.kindPdf,
  text: styles.kindText,
  video: styles.kindVideo,
  audio: styles.kindAudio,
  other: styles.kindOther,
};

/* ------------------------------ component ------------------------------- */

export default function BucketsPanel() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [buckets, setBuckets] = useState<BucketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<{
    name: string;
    folderType: FolderType;
    folderName: string;
  }>({ name: "", folderType: "agent", folderName: "" });
  const [createBusy, setCreateBusy] = useState(false);

  const [selected, setSelected] = useState<BucketDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadKey, setUploadKey] = useState(0);

  const agentNames = useMemo(() => (workspace?.agents ?? []).map((a) => a.name), [workspace]);
  const projectNames = useMemo(() => (workspace?.projects ?? []).map((p) => p.name), [workspace]);
  const folderOptions =
    draft.folderType === "agent"
      ? agentNames.map((name) => ({
          value: name,
          label: workspace?.agents.find((a) => a.name === name)?.label
            ? `${workspace.agents.find((a) => a.name === name)?.label} (${name})`
            : name,
        }))
      : projectNames.map((name) => ({ value: name, label: name }));

  // Discover the folders a bucket can be mapped to (agent folders + projects).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/agent/workspaces");
        if (!res.ok) throw new Error(await apiError(res));
        const info = (await res.json()) as WorkspaceInfo;
        if (cancelled) return;
        setWorkspace(info);
        setDraft((d) => ({
          ...d,
          folderName: d.folderName || info.agents[0]?.name || info.projects[0]?.name || "",
        }));
      } catch (e) {
        if (!cancelled) setWorkspaceError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the bucket list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await apiFetch("/buckets");
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as BucketRow[];
        if (cancelled) return;
        setBuckets(body);
      } catch (e) {
        if (cancelled) return;
        setBuckets([]);
        setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refreshDetail = async (id: string) => {
    setDetailBusy(true);
    try {
      const res = await apiFetch(`/buckets/${id}`);
      if (!res.ok) throw new Error(await apiError(res));
      const body = (await res.json()) as BucketDetail;
      setSelected(body);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDetailBusy(false);
    }
  };

  // When a bucket is open and the list is refreshed, reload its details too.
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    let cancelled = false;
    (async () => {
      setDetailBusy(true);
      try {
        const res = await apiFetch(`/buckets/${id}`);
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as BucketDetail;
        if (!cancelled) setSelected(body);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setDetailBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, selected?.id]);

  const resetDraft = () => {
    setDraft({
      name: "",
      folderType: "agent",
      folderName: agentNames[0] ?? "",
    });
  };

  const createBucket = async () => {
    const name = draft.name.trim();
    const folderName = draft.folderName.trim();
    setCreateBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!name) throw new Error("Bucket name is required");
      if (!folderName) throw new Error("Pick a project or agent folder");
      const res = await apiFetch("/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          folderType: draft.folderType,
          folderName,
        }),
      });
      if (!res.ok) throw new Error(await apiError(res));
      setShowCreate(false);
      resetDraft();
      setNotice(`Created bucket ${name}`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const openBucket = (bucket: BucketRow) => {
    setSelected({ ...bucket, documents: [] });
    setError(null);
    setNotice(null);
  };

  const uploadDocument = async () => {
    if (!selected || !uploadFile) return;
    setUploadBusy(true);
    setError(null);
    setNotice(null);
    const fileName = uploadFile.name;
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      const res = await apiFetch(`/buckets/${selected.id}/documents`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(await apiError(res));
      setUploadFile(null);
      setUploadKey((k) => k + 1);
      await refreshDetail(selected.id);
      setNotice(`Uploaded ${fileName}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setUploadBusy(false);
    }
  };

  const downloadDocument = async (doc: ManagedDocument) => {
    if (!selected) return;
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(
        `/buckets/${selected.id}/documents/${doc.id}/download`,
      );
      if (!res.ok) throw new Error(await apiError(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${doc.name}`);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Buckets</h1>
          <p className={styles.subtitle}>
            Managed document buckets mapped to project or agent folders.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.btnGhost}
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className={styles.badge}>
        Read-only — documents can only be added &amp; downloaded, never edited
        or deleted
      </div>

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

      {!selected ? (
        <>
          <div className={styles.toolbar}>
            <button
              className={styles.btnPrimary}
              onClick={() => {
                setShowCreate((v) => !v);
                setError(null);
                setNotice(null);
              }}
            >
              {showCreate ? "Hide form" : "New bucket"}
            </button>
          </div>

          {showCreate && (
            <form
              className={styles.panel}
              onSubmit={(e) => {
                e.preventDefault();
                void createBucket();
              }}
            >
              <div className={styles.panelTitle}>New bucket</div>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Name</span>
                <input
                  aria-label="Bucket name"
                  className={styles.input}
                  value={draft.name}
                  placeholder="research-notes"
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.target.value })
                  }
                />
                <span className={styles.help}>
                  Unique, read-only bucket. Letters, digits, dash or underscore
                  only.
                </span>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Mapped to</span>
                <select
                  aria-label="Folder type"
                  className={styles.select}
                  value={draft.folderType}
                  onChange={(e) => {
                    const folderType = e.target.value as FolderType;
                    const first =
                      folderType === "agent"
                        ? agentNames[0]
                        : projectNames[0];
                    setDraft({
                      ...draft,
                      folderType,
                      folderName: first ?? "",
                    });
                  }}
                >
                  <option value="agent">Agent folder</option>
                  <option value="project">Project folder</option>
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Folder</span>
                <select
                  aria-label="Folder name"
                  className={styles.select}
                  value={draft.folderName}
                  onChange={(e) =>
                    setDraft({ ...draft, folderName: e.target.value })
                  }
                  disabled={!workspace || folderOptions.length === 0}
                >
                  {folderOptions.length === 0 && (
                    <option value="">No folders available</option>
                  )}
                  {folderOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.panelActions}>
                <button
                  type="submit"
                  className={styles.btnPrimary}
                  disabled={createBusy}
                >
                  Create bucket
                </button>
                <button
                  type="button"
                  className={styles.btnGhost}
                  onClick={() => {
                    setShowCreate(false);
                    resetDraft();
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {loading && buckets.length === 0 ? (
            <div className={styles.muted}>Loading…</div>
          ) : buckets.length === 0 && !error ? (
            <div className={styles.muted}>
              No buckets yet. Create one to start adding managed documents.
            </div>
          ) : (
            <ul className={styles.list}>
              {buckets.map((bucket) => {
                const count = bucket._count?.documents ?? 0;
                return (
                  <li
                    key={bucket.id}
                    className={styles.row}
                    data-name={bucket.name}
                  >
                    <span className={styles.rowIcon}>🗂️</span>
                    <button
                      className={styles.rowName}
                      onClick={() => openBucket(bucket)}
                    >
                      {bucket.name}
                    </button>
                    <span className={styles.rowMeta}>
                      {bucket.folderType} / {bucket.folderName}
                    </span>
                    <span className={styles.rowMeta}>
                      {count} doc{count === 1 ? "" : "s"}
                    </span>
                    <span className={styles.rowMeta}>
                      {formatTime(bucket.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <div className={styles.detail}>
          <button
            className={styles.btnGhost}
            onClick={() => {
              setSelected(null);
              setNotice(null);
              setError(null);
            }}
          >
            ← All buckets
          </button>

          <div className={styles.detailHeader}>
            <h2 className={styles.detailTitle}>{selected.name}</h2>
            <p className={styles.detailMeta}>
              {selected.folderType} / {selected.folderName} ·{" "}
              {selected.documents.length} doc
              {selected.documents.length === 1 ? "" : "s"} · created{" "}
              {formatTime(selected.createdAt)}
            </p>
          </div>

          <form
            className={styles.panel}
            onSubmit={(e) => {
              e.preventDefault();
              void uploadDocument();
            }}
          >
            <div className={styles.panelTitle}>Add a document</div>
            <div className={styles.uploadRow}>
              <input
                key={uploadKey}
                aria-label="Document file"
                className={styles.fileInput}
                type="file"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                type="submit"
                className={styles.btnPrimary}
                disabled={!uploadFile || uploadBusy}
              >
                {uploadBusy ? "Uploading…" : "Upload"}
              </button>
            </div>
            <span className={styles.help}>
              Up to 100 MB. A file name can only be uploaded once per bucket —
              documents are immutable.
            </span>
          </form>

          {detailBusy && selected.documents.length === 0 ? (
            <div className={styles.muted}>Loading…</div>
          ) : selected.documents.length === 0 && !detailBusy ? (
            <div className={styles.muted}>
              No documents yet. Upload one to add it to this bucket.
            </div>
          ) : (
            <ul className={styles.list}>
              {selected.documents.map((doc) => (
                <li
                  key={doc.id}
                  className={styles.row}
                  data-name={doc.name}
                >
                  <span className={styles.rowIcon}>{KIND_ICON[doc.kind]}</span>
                  <span className={styles.rowName}>{doc.name}</span>
                  <span
                    className={`${styles.kindBadge} ${KIND_CLASS[doc.kind]}`}
                  >
                    {doc.kind}
                  </span>
                  <span className={styles.rowMeta}>{formatSize(doc.sizeBytes)}</span>
                  <span className={styles.rowMeta}>
                    {formatTime(doc.createdAt)}
                  </span>
                  <span className={styles.rowActions}>
                    <button
                      className={styles.btnGhost}
                      onClick={() => downloadDocument(doc)}
                    >
                      Download
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
