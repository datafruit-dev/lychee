"use client";

import { useMemo, useSyncExternalStore } from "react";

export type ChatRole = "user" | "assistant" | "system";

export interface ClaudeTextBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ClaudeToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage = {
  role: ChatRole;
  content: string | ClaudeTextBlock[] | (ClaudeTextBlock | ClaudeToolUse)[];
  // Additional fields from Claude Code
  isSidechain?: boolean;
  parentUuid?: string;
  uuid?: string;
  timestamp?: string;
};

export interface SessionInfo {
  lychee_id: string;
  claude_session_id: string | null;
  created_at: string;
  last_active: string;
  isStreaming?: boolean;
  is_worktree: boolean;
}

export interface RepoInfo {
  name: string;
  path: string;
  sessions: SessionInfo[];
}

type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

type RelayInboundMessage =
  | { type: "client_connected"; repo_path: string; repo_name: string }
  | { type: "client_disconnected"; repo_path: string }
  | { type: "sessions_list"; repo_path: string; sessions?: SessionInfo[]; active_session_ids?: string[] }
  | { type: "session_created"; repo_path: string; lychee_id: string }
  | { type: "session_history"; repo_path: string; lychee_id: string; messages?: ChatMessage[] }
  | { type: "session_update"; repo_path: string; lychee_id: string; new_entries?: ChatMessage[] }
  | { type: "stream_start"; repo_path: string; lychee_id: string }
  | { type: "stream_end"; repo_path: string; lychee_id: string }
  | { type: "claude_stream"; repo_path: string; lychee_id: string; data: unknown }
  | { type: "client_count"; count: number }
  | { type: "error"; repo_path?: string | null; message: string };

type RelayOutboundMessage =
  | { type: "register_browser" }
  | { type: "list_sessions"; repo_path: string }
  | { type: "create_session"; repo_path: string }
  | { type: "create_worktree_session"; repo_path: string }
  | { type: "load_session"; repo_path: string; lychee_id: string }
  | { type: "send_message"; repo_path: string; lychee_id: string | null; content: string; model: string };

interface SessionsState {
  repos: RepoInfo[];
  activeRepoPath: string | null;
  currentSessionId: string | null;
  creatingSessionForRepo: string | null;
  isCreatingSession: boolean;
  messages: ChatMessage[];
  activeStreams: Set<string>;
  connectionStatus: ConnectionStatus;
  selectedModel: string;
}

const INITIAL_STATE: SessionsState = {
  repos: [],
  activeRepoPath: null,
  currentSessionId: null,
  creatingSessionForRepo: null,
  isCreatingSession: false,
  messages: [],
  activeStreams: new Set(),
  connectionStatus: "idle",
  selectedModel: "claude-sonnet-4-5-20250929",
};

type Listener = () => void;

class SessionsService {
  private state: SessionsState = INITIAL_STATE;
  private listeners: Set<Listener> = new Set();
  private ws: WebSocket | null = null;
  private reconnectTimeout: number | null = null;
  private readonly wsUrl: string;

  constructor() {
    this.wsUrl = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_WS_URL) || "ws://localhost:3001/ws";

    if (typeof window !== "undefined") {
      this.connect();
      window.addEventListener("beforeunload", () => this.cleanup());
    }
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.state;

  getServerSnapshot = () => INITIAL_STATE;

  selectSession = (repoPath: string, lycheeId: string) => {
    this.updateState((prev) => ({
      ...prev,
      activeRepoPath: repoPath,
      currentSessionId: lycheeId,
      messages: [],
      isCreatingSession: false,
      creatingSessionForRepo: null,
    }));

    this.sendMessage({
      type: "load_session",
      repo_path: repoPath,
      lychee_id: lycheeId,
    });
  };

  createSession = (repoPath: string) => {
    this.updateState((prev) => ({
      ...prev,
      creatingSessionForRepo: repoPath,
      isCreatingSession: true,
    }));

    this.sendMessage({
      type: "create_session",
      repo_path: repoPath,
    });
  };

  createWorktreeSession = (repoPath: string) => {
    this.updateState((prev) => ({
      ...prev,
      creatingSessionForRepo: repoPath,
      isCreatingSession: true,
    }));

    this.sendMessage({
      type: "create_worktree_session",
      repo_path: repoPath,
    });
  };

  refreshSessions = (repoPath: string) => {
    this.sendMessage({
      type: "list_sessions",
      repo_path: repoPath,
    });
  };

  setModel = (model: string) => {
    this.updateState((prev) => ({
      ...prev,
      selectedModel: model,
    }));
  };

  sendChatMessage = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    const { activeRepoPath, currentSessionId, activeStreams, selectedModel } = this.state;
    if (!activeRepoPath || !currentSessionId || activeStreams.has(currentSessionId)) {
      return;
    }

    // Optimistically add user message for immediate feedback
    // Use temp UUID so we can deduplicate when real message arrives from file
    const userMessage: ChatMessage = {
      role: "user",
      content: trimmed,
      uuid: `temp-${Date.now()}-${Math.random()}`
    };

    // Store pending message in localStorage for refresh recovery
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`pending-message-${currentSessionId}`, trimmed);
    }

    this.updateState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
    }));

    this.sendMessage({
      type: "send_message",
      repo_path: activeRepoPath,
      lychee_id: currentSessionId,
      content: trimmed,
      model: selectedModel,
    });
  };


  private connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.updateState((prev) => ({
      ...prev,
      connectionStatus: "connecting",
    }));

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (error) {
      console.error("Failed to create WebSocket", error);
      this.handleDisconnect("error");
      return;
    }

    this.ws.onopen = () => {
      this.updateState((prev) => ({
        ...prev,
        connectionStatus: "open",
      }));
      this.sendMessage({ type: "register_browser" });
    };

    this.ws.onmessage = (event) => {
      let parsed: RelayInboundMessage | null = null;
      try {
        parsed = JSON.parse(event.data);
      } catch (error) {
        console.error("Failed to parse relay message", event.data, error);
      }

      if (parsed) {
        this.handleInboundMessage(parsed);
      }
    };

    this.ws.onerror = (event) => {
      console.error("WebSocket error", event);
      this.updateState((prev) => ({
        ...prev,
        connectionStatus: "error",
      }));
    };

    this.ws.onclose = () => {
      this.handleDisconnect("closed");
    };
  }

  private handleInboundMessage(message: RelayInboundMessage) {
    switch (message.type) {
      case "client_connected": {
        this.updateState((prev) => {
          if (prev.repos.some((repo) => repo.path === message.repo_path)) {
            return prev;
          }

          return {
            ...prev,
            repos: [
              ...prev.repos,
              {
                name: message.repo_name,
                path: message.repo_path,
                sessions: [],
              },
            ].sort((a, b) => a.name.localeCompare(b.name)),
          };
        });

        this.sendMessage({
          type: "list_sessions",
          repo_path: message.repo_path,
        });
        break;
      }

      case "client_disconnected": {
        this.updateState((prev) => {
          const repos = prev.repos.filter((repo) => repo.path !== message.repo_path);
          const wasActive = prev.activeRepoPath === message.repo_path;

          return {
            ...prev,
            repos,
            activeRepoPath: wasActive ? null : prev.activeRepoPath,
            currentSessionId: wasActive ? null : prev.currentSessionId,
            messages: wasActive ? [] : prev.messages,
          };
        });
        break;
      }

      case "sessions_list": {
        const sessions = message.sessions ?? [];
        const activeSessionIds = message.active_session_ids ?? [];

        this.updateState((prev) => {
          // Merge active session IDs from message with existing activeStreams
          const activeStreams = new Set(prev.activeStreams);
          activeSessionIds.forEach(id => activeStreams.add(id));

          return {
            ...prev,
            activeStreams,
            repos: prev.repos.map((repo) =>
              repo.path === message.repo_path
                ? {
                    ...repo,
                    sessions: sessions
                      .slice()
                      .sort(
                        (a, b) =>
                          new Date(b.last_active).getTime() -
                          new Date(a.last_active).getTime()
                      )
                      .map((session) => ({
                        ...session,
                        isStreaming: activeStreams.has(session.lychee_id),
                      })),
                  }
                : repo
            ),
          };
        });
        break;
      }

      case "session_created": {
        this.updateState((prev) => ({
          ...prev,
          isCreatingSession: false,
          creatingSessionForRepo: null,
        }));

        this.sendMessage({
          type: "list_sessions",
          repo_path: message.repo_path,
        });

        // Auto-select the newly created session
        this.selectSession(message.repo_path, message.lychee_id);
        break;
      }

      case "session_history": {
        this.updateState((prev) => {
          if (prev.currentSessionId !== message.lychee_id) {
            return prev;
          }

          const loadedMessages = message.messages ?? [];

          // Handle pending messages: User sent a message but refreshed before Claude wrote it to disk
          // We store the message in localStorage so it doesn't disappear on refresh
          const pendingKey = `pending-message-${message.lychee_id}`;
          const pendingMessage = typeof localStorage !== "undefined"
            ? localStorage.getItem(pendingKey)
            : null;

          let finalMessages = loadedMessages;
          if (pendingMessage) {
            // Check if the pending message is already in the file
            const isPendingInFile = loadedMessages.some(msg =>
              msg.role === "user" &&
              (typeof msg.content === "string" ? msg.content : "") === pendingMessage
            );

            if (!isPendingInFile) {
              // Still pending - add it as a temp message so user sees what they sent
              finalMessages = [
                ...loadedMessages,
                {
                  role: "user",
                  content: pendingMessage,
                  uuid: `temp-pending-${message.lychee_id}`
                }
              ];
            } else {
              // It's in the file now - clean up localStorage
              localStorage.removeItem(pendingKey);
            }
          }

          return {
            ...prev,
            messages: finalMessages,
          };
        });
        break;
      }

      case "session_update": {
        this.updateState((prev) => {
          if (prev.currentSessionId !== message.lychee_id) {
            return prev;
          }

          const newEntries = message.new_entries ?? [];
          const hasUserMessage = newEntries.some(e => e.role === "user");

          // Deduplication: Prevent showing the same message twice
          // This happens because:
          // 1. User sends message → we add it optimistically with temp UUID
          // 2. File watcher reads it from disk → sends as real message
          // Solution: Remove all temp user messages when real user message arrives

          const withoutTempDupes = prev.messages.filter(existing => {
            if (!existing.uuid?.startsWith("temp-")) return true;
            if (hasUserMessage && existing.role === "user") return false;
            return true;
          });

          // Clean up localStorage now that message is in the file
          if (hasUserMessage && typeof localStorage !== "undefined") {
            localStorage.removeItem(`pending-message-${message.lychee_id}`);
          }

          // Extra safety: deduplicate incoming entries against existing messages
          // Handles edge case where file watcher might send same entry twice
          const existingContents = new Set(
            withoutTempDupes
              .filter(m => m.role === "user" && !m.uuid?.startsWith("temp-"))
              .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
          );

          const finalEntries = newEntries.filter(entry => {
            if (entry.role !== "user") return true;

            const entryContent = typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);

            return !existingContents.has(entryContent);
          });

          return {
            ...prev,
            messages: [...withoutTempDupes, ...finalEntries],
          };
        });
        break;
      }

      case "stream_start": {
        this.updateState((prev) => {
          const activeStreams = new Set(prev.activeStreams).add(message.lychee_id);

          return {
            ...prev,
            activeStreams,
            repos: this.updateStreamingFlags(prev.repos, activeStreams),
          };
        });
        break;
      }

      case "stream_end": {
        this.updateState((prev) => {
          const activeStreams = new Set(prev.activeStreams);
          activeStreams.delete(message.lychee_id);
          return {
            ...prev,
            activeStreams,
            repos: this.updateStreamingFlags(prev.repos, activeStreams),
          };
        });
        break;
      }

      case "error": {
        const systemMessage: ChatMessage = {
          role: "system",
          content: message.message,
        };

        this.updateState((prev) => ({
          ...prev,
          messages: [...prev.messages, systemMessage],
          isCreatingSession: false,
          creatingSessionForRepo: null,
        }));
        break;
      }

      case "client_count":
      default:
        break;
    }
  }

  private updateStreamingFlags(repos: RepoInfo[], activeStreams: Set<string>) {
    return repos.map((repo) => ({
      ...repo,
      sessions: repo.sessions.map((session) => ({
        ...session,
        isStreaming: activeStreams.has(session.lychee_id),
      })),
    }));
  }

  private sendMessage(message: RelayOutboundMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket not ready, attempting reconnect");
      this.connect();
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error("Failed to send message", message, error);
    }
  }

  private handleDisconnect(status: ConnectionStatus) {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;

    this.updateState(() => ({
      ...INITIAL_STATE,
      connectionStatus: status,
    }));

    if (typeof window !== "undefined") {
      if (this.reconnectTimeout) {
        window.clearTimeout(this.reconnectTimeout);
      }
      this.reconnectTimeout = window.setTimeout(() => this.connect(), 1500);
    }
  }

  private cleanup() {
    if (this.reconnectTimeout && typeof window !== "undefined") {
      window.clearTimeout(this.reconnectTimeout);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private updateState(updater: (prev: SessionsState) => SessionsState) {
    const next = updater(this.state);
    if (next === this.state) {
      return;
    }

    this.state = {
      ...next,
      activeStreams: new Set(next.activeStreams),
    };

    this.listeners.forEach((listener) => listener());
  }
}

let singletonService: SessionsService | null = null;

function getSessionsService() {
  if (!singletonService) {
    singletonService = new SessionsService();
  }
  return singletonService;
}

export function useSessions() {
  const service = getSessionsService();
  const state = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getServerSnapshot
  );

  return useMemo(
    () => ({
      ...state,
      selectSession: service.selectSession,
      createSession: service.createSession,
      createWorktreeSession: service.createWorktreeSession,
      refreshSessions: service.refreshSessions,
      sendChatMessage: service.sendChatMessage,
      setModel: service.setModel,
    }),
    [state, service]
  );
}
