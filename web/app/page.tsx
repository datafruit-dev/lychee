"use client";

import { useState, useRef, useEffect } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import StatusBar from "./components/StatusBar";
import Sidebar, { Repo, Session } from "./components/Sidebar";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws";

interface Message {
  role: "user" | "assistant" | "system";
  content: string | Array<{type: string; text?: string}>;
}

// Helper to extract text content from Claude's message format
function extractMessageContent(content: string | Array<{type: string; text?: string}>): string {
  if (typeof content === "string") {
    return content;
  }
  // If it's an array of blocks, extract text from text blocks
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text || "")
    .join("");
}

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [creatingSessionForRepo, setCreatingSessionForRepo] = useState<string | null>(null);
  const [activeStreams, setActiveStreams] = useState<Set<string>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentStreamContent = useRef<{ [key: string]: string }>({});
  const sessionIdRef = useRef<string | null>(null);
  const activeRepoPathRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    activeRepoPathRef.current = activeRepoPath;
  }, [activeRepoPath]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "register_browser" }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "client_connected") {

          // Add or update repo
          setRepos((prev) => {
            const existing = prev.find(r => r.path === message.repo_path);
            if (existing) {
              return prev;
            }
            const newRepo: Repo = {
              name: message.repo_name,
              path: message.repo_path,
              sessions: []
            };
            return [...prev, newRepo];
          });

          // Request sessions for this repo
          ws.send(JSON.stringify({
            type: "list_sessions",
            repo_path: message.repo_path
          }));

        } else if (message.type === "client_disconnected") {
          // Remove the repo from the list first
          setRepos((prev) => prev.filter((r) => r.path !== message.repo_path));

          // Clear state if this was the active repo
          if (activeRepoPathRef.current === message.repo_path) {
            setActiveRepoPath(null);
            setSessionId(null);
            setMessages([]);
          }

        } else if (message.type === "sessions_list") {
          setRepos((prev) =>
            prev.map((r) =>
              r.path === message.repo_path
                ? { ...r, sessions: message.sessions || [] }
                : r
            )
          );

        } else if (message.type === "session_created") {
          setIsCreatingSession(false);
          setCreatingSessionForRepo(null);

          // Request updated sessions list
          ws.send(JSON.stringify({
            type: "list_sessions",
            repo_path: message.repo_path
          }));

        } else if (message.type === "session_history") {
          setMessages(message.messages || []);

        } else if (message.type === "claude_stream") {
          handleClaudeStream(message.lychee_id, message.data);

        } else if (message.type === "error") {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: message.message },
          ]);
          setIsCreatingSession(false);
          setCreatingSessionForRepo(null);
        }
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      setRepos([]);
    };

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, []);

  const handleClaudeStream = (lycheeId: string, data: any) => {
    const streamType = data.type;

    if (streamType === "init" || streamType === "system") {
      setActiveStreams(prev => new Set(prev).add(lycheeId));
      currentStreamContent.current[lycheeId] = "";

    } else if (streamType === "assistant") {
      const content = data.message?.content || [];
      const text = content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");

      currentStreamContent.current[lycheeId] =
        (currentStreamContent.current[lycheeId] || "") + text;

      if (lycheeId === sessionIdRef.current) {
        setMessages(prev => {
          const lastMessage = prev[prev.length - 1];
          if (lastMessage && lastMessage.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...lastMessage, content: currentStreamContent.current[lycheeId] },
            ];
          } else {
            return [
              ...prev,
              { role: "assistant", content: currentStreamContent.current[lycheeId] },
            ];
          }
        });
      }

    } else if (streamType === "result") {
      setActiveStreams(prev => {
        const newSet = new Set(prev);
        newSet.delete(lycheeId);
        return newSet;
      });
      delete currentStreamContent.current[lycheeId];


    } else if (streamType === "error") {
      setActiveStreams(prev => {
        const newSet = new Set(prev);
        newSet.delete(lycheeId);
        return newSet;
      });
      delete currentStreamContent.current[lycheeId];

      if (lycheeId === sessionIdRef.current) {
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Error: ${data.message}` },
        ]);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || (sessionId && activeStreams.has(sessionId))) return;

    if (!activeRepoPath) {
      return;
    }

    const userMessage: Message = {
      role: "user",
      content: input.trim(),
    };
    setMessages((prev) => [...prev, userMessage]);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "send_message",
          repo_path: activeRepoPath,
          lychee_id: sessionId,
          content: input.trim(),
        })
      );
    }

    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        return;
      } else {
        e.preventDefault();
        handleSubmit(e);
      }
    }
  };

  const handleSelectSession = (repoPath: string, lycheeId: string) => {
    setActiveRepoPath(repoPath);
    setSessionId(lycheeId);
    setIsCreatingSession(false);

    // Request session history from relay
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "load_session",
          lychee_id: lycheeId,
          repo_path: repoPath,
        })
      );
    }
  };

  const handleNewSession = (repoPath: string) => {
    setCreatingSessionForRepo(repoPath);
    setIsCreatingSession(true);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "create_session",
          repo_path: repoPath,
        })
      );
    }
  };

  const activeRepo = repos.find((r) => r.path === activeRepoPath);
  const isConnected = activeRepoPath && repos.some((r) => r.path === activeRepoPath);

  // Update repos to show active streams
  const reposWithActiveStreams = repos.map(repo => ({
    ...repo,
    sessions: repo.sessions.map(session => ({
      ...session,
      isStreaming: activeStreams.has(session.lychee_id)
    }))
  }));

  return (
    <div className="flex h-screen bg-gradient-to-b from-gray-50 to-white text-gray-900">
      {/* Sidebar */}
      <Sidebar
        repos={reposWithActiveStreams}
        activeRepoPath={activeRepoPath}
        currentSessionId={sessionId}
        creatingSessionForRepo={creatingSessionForRepo}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {!activeRepoPath ? (
          /* No repo selected */
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <h1 className="text-3xl font-semibold text-gray-900 mb-2">
                Welcome to Lychee
              </h1>
              {repos.length === 0 ? (
                <p className="text-gray-600">
                  Run <code className="bg-gray-100 px-2 py-1 rounded">lychee up</code> in your project directory
                </p>
              ) : (
                <p className="text-gray-600">
                  Select a repository from the sidebar
                </p>
              )}
            </div>
          </div>
        ) : (
          /* Chat View */
          <div className="flex-1 flex flex-col">
            {/* Top Menu Bar */}
            <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="text-sm font-medium text-gray-900">
                  {activeRepo?.name || "Unknown Repo"}
                </div>
                <div className="text-gray-300">/</div>
                <div className="text-sm text-gray-600">
                  {sessionId || "No session"}
                </div>
              </div>
              <div>
                <button
                  className="px-3 py-1.5 text-xs font-medium bg-gray-900 text-white rounded hover:bg-gray-800 transition-colors"
                  onClick={() => {
                    // TODO: Implement checkout
                    console.log("Checkout clicked");
                  }}
                >
                  Checkout Branch
                </button>
              </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto mb-4 space-y-4 px-2 max-w-4xl mx-auto w-full pt-4">
              {messages.length === 0 ? (
                <div className="text-center text-gray-500 mt-20">
                  <p className="text-lg mb-2">Start chatting with Claude Code</p>
                  <p className="text-sm">
                    {sessionId
                      ? `Working in branch: ${sessionId}`
                      : "Create a new branch to get started"}
                  </p>
                </div>
              ) : (
                messages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`${
                      msg.role === "user" ? "flex justify-end" : ""
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="max-w-3xl mx-auto px-4 py-3">
                        <div className="text-xs text-gray-500 mb-2">Claude</div>
                        <div className="text-gray-900">
                          <MarkdownRenderer content={extractMessageContent(msg.content)} />
                          {sessionId && activeStreams.has(sessionId) && idx === messages.length - 1 && (
                            <span className="inline-block w-2 h-4 ml-1 bg-gray-600 animate-pulse" />
                          )}
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`max-w-[80%] rounded px-4 py-3 ${
                          msg.role === "user"
                            ? "bg-gray-100 text-gray-900"
                            : "bg-yellow-50 text-yellow-800 text-sm border border-yellow-200"
                        }`}
                      >
                        {msg.role === "system" && (
                          <div className="text-xs text-gray-500 mb-1">System</div>
                        )}
                        <div className="whitespace-pre-wrap break-words">
                          {extractMessageContent(msg.content)}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="pb-4 pt-4 max-w-4xl mx-auto w-full">
              <div className="border border-gray-200 rounded-lg bg-white shadow-sm">
                <div className="overflow-hidden rounded-t-lg">
                  <StatusBar status={null} isStreaming={sessionId ? activeStreams.has(sessionId) : false} />
                </div>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={!isConnected || isCreatingSession || !sessionId || (sessionId && activeStreams.has(sessionId))}
                  className="w-full p-4 bg-transparent text-gray-900 focus:outline-none placeholder:text-gray-400 resize-none border-0"
                  placeholder={
                    sessionId && activeStreams.has(sessionId)
                      ? "Claude is thinking..."
                      : !sessionId
                      ? "Select or create a session..."
                      : isConnected
                      ? "Message Claude..."
                      : "Repository disconnected..."
                  }
                  rows={1}
                  style={{
                    lineHeight: "1.5",
                    overflowY: "auto",
                    minHeight: "3rem",
                    maxHeight: "8rem",
                  }}
                  autoFocus
                />
                <div className="flex items-center justify-end px-4 pb-3 pt-0">
                  <button
                    type="button"
                    disabled={!isConnected || !input.trim() || isCreatingSession || !sessionId || (sessionId && activeStreams.has(sessionId))}
                    onClick={handleSubmit}
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                      !input.trim() || !isConnected || isCreatingSession || !sessionId || (sessionId && activeStreams.has(sessionId))
                        ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                        : "bg-gray-900 text-white hover:bg-gray-800"
                    }`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="22" y1="2" x2="11" y2="13"></line>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}