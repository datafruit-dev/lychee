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
  // For streaming: length of text when tools first appeared
  textLengthAtTools?: number;
};

export interface SessionInfo {
  lychee_id: string;
  claude_session_id: string | null;
  created_at: string;
  last_active: string;
  isStreaming?: boolean;
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
  | { type: "sessions_list"; repo_path: string; sessions?: SessionInfo[] }
  | { type: "session_created"; repo_path: string; lychee_id: string }
  | { type: "session_history"; repo_path: string; lychee_id: string; messages?: ChatMessage[] }
  | { type: "claude_stream"; repo_path: string; lychee_id: string; data: unknown }
  | { type: "client_count"; count: number }
  | { type: "error"; repo_path?: string | null; message: string };

type RelayOutboundMessage =
  | { type: "register_browser" }
  | { type: "list_sessions"; repo_path: string }
  | { type: "create_session"; repo_path: string }
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
  private streamBuffers: Record<string, string> = {};
  // Track text length when first tool appears for each session
  private textSnapshotAtTools: Record<string, number> = {};

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

    const userMessage: ChatMessage = { role: "user", content: trimmed };

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
        this.updateState((prev) => ({
          ...prev,
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
                      isStreaming: prev.activeStreams.has(session.lychee_id),
                    })),
                }
              : repo
          ),
        }));
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
        break;
      }

      case "session_history": {
        this.updateState((prev) => {
          if (prev.currentSessionId !== message.lychee_id) {
            return prev;
          }

          return {
            ...prev,
            messages: message.messages ?? [],
          };
        });
        break;
      }

      case "claude_stream": {
        this.handleClaudeStream(message.lychee_id, message.data);
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

  private handleClaudeStream(lycheeId: string, data: unknown) {
    const streamType = (data as {type?: string})?.type;
    if (!streamType) return;

    if (streamType === "init" || streamType === "system") {
      this.streamBuffers[lycheeId] = "";
      delete this.textSnapshotAtTools[lycheeId]; // Reset snapshot for new stream
      this.updateState((prev) => {
        const activeStreams = new Set(prev.activeStreams).add(lycheeId);
        return {
          ...prev,
          activeStreams,
          repos: this.updateStreamingFlags(prev.repos, activeStreams),
        };
      });
      return;
    }

    if (streamType === "assistant") {
      const dataObj = data as {message?: {content?: unknown}};
      const contentBlocks = Array.isArray(dataObj?.message?.content)
        ? dataObj.message.content
        : [];

      this.updateState((prev) => {
        if (prev.currentSessionId !== lycheeId) {
          return prev;
        }

        const messages = [...prev.messages];
        const last = messages[messages.length - 1];

        // Check if we should update existing message or create new one
        if (last && last.role === "assistant") {
          // Update existing assistant message with new content blocks
          const existingContent = Array.isArray(last.content) ? last.content : [];

          // Merge content blocks - combine text, append tool_use
          const mergedContent = [...existingContent];

          contentBlocks.forEach((newBlock: unknown) => {
            const block = newBlock as {type?: string; text?: string; id?: string};
            if (block.type === "text") {
              // Find existing text block and update it, or append
              const textIndex = mergedContent.findIndex((b: unknown) => (b as {type?: string}).type === "text");
              if (textIndex >= 0) {
                const existingText = (mergedContent[textIndex] as {text?: string}).text || "";
                mergedContent[textIndex] = {
                  type: "text",
                  text: existingText + (block.text || "")
                } as ClaudeTextBlock;
              } else {
                mergedContent.push(block as ClaudeTextBlock);
              }
            } else if (block.type === "tool_use") {
              // Capture text length when first tool appears
              if (!last.textLengthAtTools && mergedContent.some((b: unknown) => (b as {type?: string}).type === "text")) {
                const textBlock = mergedContent.find((b: unknown) => (b as {type?: string}).type === "text") as {text?: string};
                const currentTextLength = textBlock?.text?.length || 0;
                // Will set this on the message below
                this.textSnapshotAtTools[lycheeId] = currentTextLength;
              }

              // Only add tool_use if not already present (check by id)
              const exists = mergedContent.some((b: unknown) =>
                (b as {type?: string; id?: string}).type === "tool_use" && (b as {id?: string}).id === block.id
              );
              if (!exists) {
                mergedContent.push(block as ClaudeToolUse);
              }
            } else {
              // Other block types - just append if not duplicate
              mergedContent.push(block as ClaudeTextBlock);
            }
          });

          messages[messages.length - 1] = {
            ...last,
            content: mergedContent,
            textLengthAtTools: this.textSnapshotAtTools[lycheeId]
          };
        } else {
          // Create new assistant message
          messages.push({ role: "assistant", content: contentBlocks });
        }

        return {
          ...prev,
          messages,
        };
      });
      return;
    }

    if (streamType === "result" || streamType === "error") {
      delete this.streamBuffers[lycheeId];
      delete this.textSnapshotAtTools[lycheeId]; // Clean up snapshot
      this.updateState((prev) => {
        const activeStreams = new Set(prev.activeStreams);
        activeStreams.delete(lycheeId);
        return {
          ...prev,
          activeStreams,
          repos: this.updateStreamingFlags(prev.repos, activeStreams),
        };
      });

      if (streamType === "error") {
        const errorMessage = (data as {message?: string})?.message;
        if (errorMessage && this.state.currentSessionId === lycheeId) {
          const systemMessage: ChatMessage = {
            role: "system",
            content: `Error: ${errorMessage}`,
          };
          this.updateState((prev) => ({
            ...prev,
            messages: [...prev.messages, systemMessage],
          }));
        }
      }
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
      refreshSessions: service.refreshSessions,
      sendChatMessage: service.sendChatMessage,
      setModel: service.setModel,
    }),
    [state, service]
  );
}
