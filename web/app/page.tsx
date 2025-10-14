"use client";

import { useState, useRef, useEffect } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import StatusBar from "./components/StatusBar";
import Sidebar, { Repo } from "./components/Sidebar";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [creatingSessionForRepo, setCreatingSessionForRepo] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentAssistantContent = useRef("");

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("Connected to relay server");

      // Register as browser client
      ws.send(JSON.stringify({ type: "register_browser" }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log("WebSocket message received:", message.type, message);

        // Handle session_created FIRST before any other message type
        if (message.type === "session_created") {
          console.log("🎯 SESSION CREATED RECEIVED:", message);
          console.log("  Session ID:", message.session?.id);
          console.log("  Repo Path:", message.repo_path);

          // Just add the session to the list, don't switch to it
          if (message.session && message.session.id) {
            setIsCreatingSession(false);
            setCreatingSessionForRepo(null);

            // Update repos with new session (add to beginning for newest first)
            setRepos((prev) => {
              const updated = prev.map((r) =>
                r.path === message.repo_path
                  ? { ...r, sessions: [message.session, ...r.sessions] }
                  : r
              );
              console.log("Updated repos:", updated);
              return updated;
            });

            console.log("✅ Session created and added to list");
          } else {
            console.error("❌ Invalid session_created message - missing session or id");
          }
          return; // Stop processing other handlers
        }

        if (message.type === "repo_added") {
          console.log("Repo added:", message.repo);
          setRepos((prev) => [...prev, message.repo]);
        } else if (message.type === "repo_removed") {
          console.log("Repo removed:", message.repo_path);
          setRepos((prev) => prev.filter((r) => r.path !== message.repo_path));
          // Clear active repo if it was removed
          if (activeRepoPath === message.repo_path) {
            setActiveRepoPath(null);
            setMessages([]);
            setSessionId(null);
          }
        } else if (message.type === "sessions_updated") {
          console.log("📋 SESSIONS_UPDATED received:", message);

          // Check if this is for a repo we're creating a session for
          // We need to access the state value directly here
          setCreatingSessionForRepo((currentRepo) => {
            if (currentRepo === message.repo_path) {
              console.log("  Session creation complete for repo:", currentRepo);
              setIsCreatingSession(false);
              return null;
            }
            return currentRepo;
          });

          setRepos((prev) =>
            prev.map((r) =>
              r.path === message.repo_path
                ? { ...r, sessions: message.sessions }
                : r
            )
          );
        } else if (message.type === "session_history") {
          console.log("Received session history:", message.messages);
          setMessages(message.messages || []);
        } else if (message.type === "claude_stream") {
          handleClaudeStream(message.payload);
        } else if (message.type === "error") {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: message.message },
          ]);
        } else {
          console.warn("Unknown message type:", message.type, message);
        }
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      console.log("Disconnected from relay server");
      setRepos([]);
    };

    wsRef.current = ws;

    return () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleClaudeStream = (stream: Record<string, any>) => {
    const streamType = stream.type;

    if (streamType === "init") {
      // Session initialized
      console.log("🚀 Claude session started");
      setIsStreaming(true);
      currentAssistantContent.current = "";

    } else if (streamType === "assistant") {
      // Claude's response chunk
      const content = stream.message?.content || [];

      // Extract text from content blocks
      const text = content
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("");

      // Accumulate content
      currentAssistantContent.current += text;

      // Update or add assistant message
      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          // Update existing message
          return [
            ...prev.slice(0, -1),
            { ...lastMessage, content: currentAssistantContent.current },
          ];
        } else {
          // Add new message
          return [
            ...prev,
            { role: "assistant", content: currentAssistantContent.current },
          ];
        }
      });

    } else if (streamType === "result") {
      // Final stats message
      // Don't overwrite the Lychee session ID with Claude's session ID
      setIsStreaming(false);
      currentAssistantContent.current = "";

      console.log("✓ Response complete");
      console.log(`💰 Cost: $${stream.total_cost_usd}`);
      console.log(`⏱️  Duration: ${stream.duration_ms}ms`);

    } else if (streamType === "error") {
      // Error message
      setIsStreaming(false);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Error: ${stream.message}` },
      ]);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    // Check if a repo is selected
    if (!activeRepoPath) {
      return;
    }

    // Add user message to UI immediately
    const userMessage: Message = {
      role: "user",
      content: input.trim(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // Send to relay
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "message",
          repo_path: activeRepoPath,
          payload: input.trim(),
          session_id: sessionId,
        })
      );
      setIsStreaming(true);
    }

    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Allow default behavior for shift+enter (new line)
        return;
      } else {
        // Prevent default and submit on enter
        e.preventDefault();
        handleSubmit(e);
      }
    }
  };

  const handleSelectSession = (repoPath: string, sessionId: string) => {
    console.log("Selected session:", sessionId, "in repo:", repoPath);

    setActiveRepoPath(repoPath);
    setSessionId(sessionId);
    setIsCreatingSession(false);

    // Request session history from relay
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "load_session",
          session_id: sessionId,
          repo_path: repoPath,
        })
      );
    }
  };

  const handleNewSession = (repoPath: string) => {
    console.log("🔵 handleNewSession called for repo:", repoPath);
    console.log("  Current activeRepoPath:", activeRepoPath);
    console.log("  Current sessionId:", sessionId);

    // Mark that we're creating a session for this specific repo (without switching to it)
    setCreatingSessionForRepo(repoPath);
    setIsCreatingSession(true);

    console.log("  Set isCreatingSession: true for repo:", repoPath);

    // Request new worktree creation
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg = {
        type: "create_session",
        repo_path: repoPath,
      };
      console.log("  Sending create_session:", msg);
      wsRef.current.send(JSON.stringify(msg));
    } else {
      console.error("  WebSocket not ready!");
    }
  };

  const activeRepo = repos.find((r) => r.path === activeRepoPath);
  const isConnected = activeRepoPath && repos.some((r) => r.path === activeRepoPath);

  return (
    <div className="flex h-screen bg-gradient-to-b from-gray-50 to-white text-gray-900">
      {/* Sidebar */}
      <Sidebar
        repos={repos}
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
          <div className="max-w-4xl mx-auto w-full h-full flex flex-col p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-6 pt-4">
              <div className="text-sm text-gray-600">
                {activeRepo?.name || "Unknown Repo"}
                {sessionId && ` / ${sessionId}`}
              </div>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full ${
                    isConnected ? "bg-green-500" : "bg-red-500"
                  } animate-pulse`}
                />
                <span className="text-sm text-gray-600">
                  {isConnected ? "Connected" : "Disconnected"}
                </span>
              </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto mb-4 space-y-4 px-2">
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
                          <MarkdownRenderer content={msg.content} />
                          {isStreaming && idx === messages.length - 1 && (
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
                          {msg.content}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="pb-4 pt-4">
              <div
                className={`border rounded-lg bg-white shadow-sm ${
                  !isStreaming ? "awaiting-border" : "border-gray-200"
                }`}
              >
                <div className="overflow-hidden rounded-t-lg">
                  <StatusBar status={null} isStreaming={isStreaming} />
                </div>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isStreaming || !isConnected || isCreatingSession || !sessionId}
                  className="w-full p-4 bg-transparent text-gray-900 focus:outline-none placeholder:text-gray-400 resize-none border-0"
                  placeholder={
                    isStreaming
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
                    disabled={isStreaming || !isConnected || !input.trim() || isCreatingSession || !sessionId}
                    onClick={handleSubmit}
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                      !input.trim() || isStreaming || !isConnected || isCreatingSession || !sessionId
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