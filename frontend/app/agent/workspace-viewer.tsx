"use client";

import styles from "./agent.module.css";
import type { DirNode } from "./agent-types";
import { useWorkspaceViewer } from "./agent-context";

/**
 * workspace-viewer.tsx — lazy workspace viewer for the agent page.
 *
 * Extracted in Round 97: AgentPage keeps the workspace data/loaders (shared
 * with the header Workspace toggle) and exposes them through
 * WorkspaceViewerContext; this module renders the agent/project trees and is
 * loaded via `next/dynamic({ ssr: false })`, so the eager /agent first load
 * no longer carries the tree UI.
 */

function isWsDir(v: DirNode | null | undefined): v is DirNode {
  return v !== null && v !== undefined && typeof v === "object";
}

function renderTree(
  node: DirNode | null | undefined,
  styles: { [k: string]: string },
  prefix = "",
): React.ReactNode {
  if (!node || !isWsDir(node)) return <div className={styles.muted}>∅</div>;
  const names = Object.keys(node);
  if (names.length === 0) return <div className={styles.muted}>∅</div>;
  return (
    <ul className={styles.treeList}>
      {names.map((name) => {
        const child = node[name];
        const isFolder = isWsDir(child);
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

export default function WorkspaceViewer() {
  const {
    wsInfo,
    wsError,
    setWsError,
    wsLoadingTree,
    wsSelAgent,
    wsAgentTrees,
    wsSelProject,
    wsProjectTrees,
    wsLoadAgentTree,
    wsLoadProjectTree,
  } = useWorkspaceViewer();

  if (!wsInfo) return null;

  return (
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
                  onClick={() => void wsLoadAgentTree(a.name)}
                >
                  <span className={styles.treeCaret}>
                    {wsLoadingTree === a.name
                      ? "…"
                      : wsAgentTrees[a.name] !== undefined
                        ? wsSelAgent === a.name
                          ? "▾"
                          : "▸"
                        : "▸"}
                  </span>
                  {a.label}
                </button>
                {wsSelAgent === a.name && wsAgentTrees[a.name] !== undefined && (
                  <div className={styles.treeNested}>
                    {renderTree(wsAgentTrees[a.name], styles, `${a.name}::`)}
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
                  onClick={() => void wsLoadProjectTree(p.name)}
                >
                  <span className={styles.treeCaret}>
                    {wsLoadingTree === p.name
                      ? "…"
                      : wsProjectTrees[p.name] !== undefined
                        ? wsSelProject === p.name
                          ? "▾"
                          : "▸"
                        : "▸"}
                  </span>
                  {p.name}
                </button>
                {wsSelProject === p.name && wsProjectTrees[p.name] !== undefined && (
                  <div className={styles.treeNested}>
                    {renderTree(wsProjectTrees[p.name], styles, `${p.name}::`)}
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
  );
}
