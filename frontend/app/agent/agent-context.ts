"use client";

import { createContext, useContext } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AgentEntry,
  AgentSessionSummary,
  ChannelDetail,
  ChannelJobEvent,
  ChannelSummary,
  ChatMsg,
  ConnectionOption,
  DirNode,
  MemberStatus,
  WorkspaceInfo,
  ModelOption,
} from "./agent-types";

/**
 * agent-context.ts — shared context for the lazy sessions/channels panels.
 *
 * Round 96: the panels used to consume ~25 sessions / ~45 channels controlled
 * props drilled from AgentPage. The provider now lives in the eager agent
 * client and the lazy panels read the same values through context hooks, so
 * adding a field no longer means threading a new prop through three places.
 * The module is tiny (types + two createContext objects) and leaves the
 * Round 93 lazy chunk split intact.
 */

export interface SessionsPanelValue {
  sessions: AgentSessionSummary[];
  sessionsError: string | null;
  setSessionsError: (v: string | null) => void;
  creatingSession: boolean;
  createSession: () => void;
  selSessionId: string | null;
  openSession: (id: string) => Promise<void>;
  editingSessionId: string | null;
  setEditingSessionId: (v: string | null) => void;
  draftSessionTitle: string;
  setDraftSessionTitle: (v: string) => void;
  commitSessionRename: (id: string) => Promise<void>;
  connLabel: (id: string | undefined) => string | null;
  startSessionRename: (s: AgentSessionSummary) => void;
  deleteSession: (id: string) => Promise<void>;
  selectedConn: ConnectionOption | null;
  sessionLoading: boolean;
  sessionMsgs: ChatMsg[];
  sessionBusy: boolean;
  endRef: RefObject<HTMLDivElement | null>;
  sessionInput: string;
  setSessionInput: (v: string) => void;
  sendSession: () => void;
}


export interface ChannelsPanelValue {
  channelsError: string | null;
  setChannelsError: (v: string | null) => void;
  channels: ChannelSummary[];
  selChannelId: string | null;
  openChannel: (id: string) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;
  showNew: boolean;
  setShowNew: (v: boolean) => void;
  dmOpen: boolean;
  setDmOpen: Dispatch<SetStateAction<boolean>>;
  dmBusy: boolean;
  loadAvailableAgents: () => void;
  availableAgents: AgentEntry[];
  openDirectMessage: (agentName: string) => Promise<void>;
  detail: ChannelDetail | null;
  liveAgent: string | null;
  runAgent: string;
  setRunAgent: (v: string) => void;
  selectMember: (agentName: string) => void;
  removeMember: (agentName: string) => Promise<void>;
  memberInput: string;
  setMemberInput: (v: string) => void;
  addMember: () => void;
  memberBusy: boolean;
  chFeedRef: RefObject<HTMLDivElement | null>;
  detailLoading: boolean;
  chBusy: boolean;
  chMode: "post" | "run";
  setChMode: (v: "post" | "run") => void;
  jobEvents: ChannelJobEvent[];
  jobSeen: number;
  jobStatus: "running" | "done" | "error" | "stopped" | null;
  jobError: string | null;
  activeJob: { jobId: string; channelId: string; agentName: string } | null;
  interject: () => void;
  postToChannel: () => void;
  startJob: () => void;
  stopJob: () => void;
  runModel: string;
  setRunModel: (v: string) => void;
  models: ModelOption[];
  chInput: string;
  setChInput: (v: string) => void;
  memberStatusLoading: boolean;
  memberStatus: MemberStatus[];
  selMember: string | null;
  setSelMember: Dispatch<SetStateAction<string | null>>;
  collapsed: Record<string, boolean>;
  toggleCollapse: (path: string) => void;
  newName: string;
  setNewName: (v: string) => void;
  newProject: string;
  setNewProject: (v: string) => void;
  newCreator: string;
  setNewCreator: (v: string) => void;
  creating: boolean;
  createChannel: () => void;
}

export const SessionsPanelContext = createContext<SessionsPanelValue | null>(null);
export const ChannelsPanelContext = createContext<ChannelsPanelValue | null>(null);

export function useSessionsPanel(): SessionsPanelValue {
  const value = useContext(SessionsPanelContext);
  if (!value) throw new Error("useSessionsPanel must be rendered inside the agent page provider");
  return value;
}

export function useChannelsPanel(): ChannelsPanelValue {
  const value = useContext(ChannelsPanelContext);
  if (!value) throw new Error("useChannelsPanel must be rendered inside the agent page provider");
  return value;
}

/**
 * Workspace-viewer context (Round 97). AgentPage owns the workspace data and
 * loaders so the header's Workspace toggle shares the same cache/show state;
 * the viewer JSX (tree rendering + folder icons) is lazy so the eager /agent
 * first load keeps only the header glue. Keys are prefixed with `ws` to stay
 * disjoint from the sessions/channels panel values (which also carry
 * collapsed/toggleCollapse).
 */
export interface WorkspaceViewerValue {
  wsInfo: WorkspaceInfo | null;
  wsError: string | null;
  setWsError: (v: string | null) => void;
  wsShow: boolean;
  wsLoadingTree: string | null;
  wsSelAgent: string | null;
  wsAgentTrees: Record<string, DirNode | null>;
  wsSelProject: string | null;
  wsProjectTrees: Record<string, DirNode | null>;
  wsLoadAgentTree: (name: string) => Promise<void>;
  wsLoadProjectTree: (name: string) => Promise<void>;
}

export const WorkspaceViewerContext = createContext<WorkspaceViewerValue | null>(null);

export function useWorkspaceViewer(): WorkspaceViewerValue {
  const value = useContext(WorkspaceViewerContext);
  if (!value) throw new Error("useWorkspaceViewer must be rendered inside the agent page provider");
  return value;
}
