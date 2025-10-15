"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Plus, GitBranch, FolderOpen, FolderClosed } from "lucide-react";
import Image from "next/image";

export interface Session {
  lychee_id: string;
  claude_session_id: string | null;
  created_at: string;
  last_active: string;
  isStreaming?: boolean;
}

export interface Repo {
  name: string;
  path: string;
  sessions: Session[];
  checked_out_session: string | null;
  main_dir_uncommitted: boolean;
}

interface SidebarProps {
  repos: Repo[];
  activeRepoPath: string | null;
  currentSessionId: string | null;
  creatingSessionForRepo: string | null;
  onSelectSession: (repoPath: string, sessionId: string) => void;
  onNewSession: (repoPath: string) => void;
}

export default function Sidebar({
  repos,
  activeRepoPath,
  currentSessionId,
  creatingSessionForRepo,
  onSelectSession,
  onNewSession,
}: SidebarProps) {
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Auto-expand all repos by default
    setExpandedRepos(new Set(repos.map(r => r.path)));
  }, [repos]);

  const toggleRepo = (repoPath: string) => {
    setExpandedRepos(prev => {
      const newSet = new Set(prev);
      if (newSet.has(repoPath)) {
        newSet.delete(repoPath);
      } else {
        newSet.add(repoPath);
      }
      return newSet;
    });
  };

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  return (
    <div className="w-80 bg-white border-r border-gray-200 flex flex-col h-full">
      {/* Repos and Sessions */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {repos.length === 0 ? (
          <div className="text-center py-12 px-6">
            <div className="text-gray-400 mb-4">
              <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">No repositories connected</p>
            </div>
            <div className="text-xs text-gray-500 space-y-2">
              <p>Run in your project directory:</p>
              <code className="block bg-gray-100 rounded px-2 py-1 text-gray-700">
                lychee up
              </code>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {repos.map((repo) => {
              const isExpanded = expandedRepos.has(repo.path);
              const isCreating = creatingSessionForRepo === repo.path;

              return (
                <div key={repo.path} className="rounded-lg overflow-hidden">
                  {/* Repo Header */}
                  <button
                    onClick={() => toggleRepo(repo.path)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-200 ${
                      repo.path === activeRepoPath
                        ? "bg-gray-100 text-gray-900"
                        : "hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    <ChevronRight
                      className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    />
                    {isExpanded ? (
                      <FolderOpen className="w-4 h-4 text-gray-600" />
                    ) : (
                      <FolderClosed className="w-4 h-4 text-gray-400" />
                    )}
                    <span className="flex-1 text-left text-sm font-medium truncate">
                      {repo.name}
                    </span>
                    {repo.sessions.length > 0 && (
                      <span className="text-xs text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded">
                        {repo.sessions.length}
                      </span>
                    )}
                  </button>

                  {/* Session List */}
                  {isExpanded && (
                    <div className="mt-1 ml-4 space-y-1">
                      {/* New Session Button */}
                      <button
                        onClick={() => onNewSession(repo.path)}
                        disabled={isCreating}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                          isCreating
                            ? "bg-gray-100 text-gray-700 cursor-wait"
                            : "text-gray-600 hover:text-gray-800 hover:bg-gray-50"
                        }`}
                      >
                        <Plus className={`w-3 h-3 ${isCreating ? "animate-spin" : ""}`} />
                        <span>{isCreating ? "Creating session..." : "New Session"}</span>
                      </button>

                      {/* Session Items */}
                      {repo.sessions.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-gray-500">
                          No branches yet
                        </div>
                      ) : (
                        [...repo.sessions]
                          .sort((a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime())
                          .map((session) => {
                            const isActiveSession = session.lychee_id === currentSessionId && repo.path === activeRepoPath;

                            return (
                              <button
                                key={session.lychee_id}
                                onClick={() => onSelectSession(repo.path, session.lychee_id)}
                                className={`w-full group flex items-start gap-2 px-3 py-1.5 rounded-md cursor-pointer transition-all duration-200 text-left ${
                                  isActiveSession
                                    ? "bg-gray-100 text-gray-900 font-medium"
                                    : "text-gray-600 hover:text-gray-800 hover:bg-gray-50"
                                }`}
                              >
                                <GitBranch
                                  className={`w-3 h-3 mt-0.5 flex-shrink-0 transition-colors ${
                                    session.isStreaming
                                      ? "text-orange-500 animate-pulse"
                                      : isActiveSession
                                      ? "text-gray-700"
                                      : "text-gray-400"
                                  }`}
                                />
                                <div className="flex-1 min-w-0">
                                  <div
                                    className="text-xs truncate leading-tight font-medium"
                                    title={session.lychee_id}
                                  >
                                    {session.lychee_id}
                                  </div>
                                  <div className="text-xs text-gray-500 mt-0.5 leading-tight">
                                    {formatRelativeTime(session.last_active)}
                                  </div>
                                </div>
                              </button>
                            );
                          })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}