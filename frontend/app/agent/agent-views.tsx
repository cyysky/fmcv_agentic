"use client";

import { useState } from "react";
import styles from "./agent.module.css";
import { formatTime, formatTimeShort } from "../../lib/time";
import type {
  ChannelJobEvent,
  ChannelSummary,
  MemberStatus,
} from "./agent-types";
import { useChannelsPanel, useSessionsPanel } from "./agent-context";

/**
 * agent-views.tsx — sessions + channels tab panels for the agent page.
 *
 * Extracted in Round 93: AgentPage keeps all state/handlers and renders these
 * two controlled panels through `next/dynamic({ ssr: false })`, so the chat
 * first load stays lean. Round 96: the panels now read their state from
 * agent-context instead of controlled props; JSX is unchanged from the move.
 */

function isProjDir(v: unknown): boolean {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/* ----------------------------- sessions panel ---------------------------- */


export function AgentSessionsPanel() {
  const {
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
  } = useSessionsPanel();
  return (
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
                        {editingSessionId === s.id ? (
                          <span
                            className={styles.sessionTitle}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              className={styles.sessionRenameInput}
                              value={draftSessionTitle}
                              autoFocus
                              aria-label="Session title"
                              onChange={(e) => setDraftSessionTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void commitSessionRename(s.id);
                                } else if (e.key === "Escape") {
                                  setEditingSessionId(null);
                                }
                              }}
                              onBlur={() => {
                                if (draftSessionTitle.trim() && draftSessionTitle.trim() !== (s.title || "")) {
                                  void commitSessionRename(s.id);
                                } else {
                                  setEditingSessionId(null);
                                }
                              }}
                            />
                          </span>
                        ) : (
                          <span className={styles.sessionTitle}>
                            {s.title || "Untitled"}
                          </span>
                        )}
                        <span className={styles.sessionMeta}>
                          {formatTime(s.createdAt)}
                          {connLabel(s.connectionId) && (
                            <span className={styles.sessionBadge}>
                              {connLabel(s.connectionId)}
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        className={styles.sessionRenameBtn}
                        title="Rename session"
                        aria-label={`Rename session ${s.title || "Untitled"}`}
                        onClick={() => startSessionRename(s)}
                      >
                        ✎
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
                  {selectedConn && (
                    <div className={styles.sessionNote}>
                      Using connection {selectedConn.displayName} ·{" "}
                      {selectedConn.modelName}
                    </div>
                  )}
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
  
  );
}

/* ----------------------------- channels panel ---------------------------- */


export function AgentChannelsPanel() {
  const {
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
  } = useChannelsPanel();
  return (
    <>
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
                            <span className={styles.chMsgTime}>{formatTime(m.createdAt)}</span>
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
    </>
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
            started {formatTimeShort(memberStatus.startedAt)}
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
