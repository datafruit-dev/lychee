"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Plus, GitBranch, FolderOpen, FolderClosed } from "lucide-react";
import type { RepoInfo } from "@/lib/sessions";

interface SidebarProps {
  repos: RepoInfo[];
  activeRepoPath: string | null;
  currentSessionId: string | null;
  onSelectSession: (repoPath: string, sessionId: string) => void;
  onNewSession: (repoPath: string) => void;
  isCollapsed: boolean;
  onToggleSidebar: () => void;
  creatingSessionForRepo: string | null;
  isCreatingSession: boolean;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function Sidebar({
  repos,
  activeRepoPath,
  currentSessionId,
  onSelectSession,
  onNewSession,
  isCollapsed,
  onToggleSidebar,
  creatingSessionForRepo,
  isCreatingSession,
}: SidebarProps) {
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(
    new Set()
  );

  // Auto-expand new repos only when they are first added
  useEffect(() => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      repos.forEach((repo) => {
        if (!prev.has(repo.path)) {
          next.add(repo.path);
        }
      });
      return next;
    });
  }, [repos]);

  const toggleRepo = (repoPath: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoPath)) {
        next.delete(repoPath);
      } else {
        next.add(repoPath);
      }
      return next;
    });
  };

  return (
    <aside className={`flex-shrink-0 bg-sidebar flex flex-col border-r border-border overflow-hidden transition-all duration-150 ease-out ${
      isCollapsed ? 'w-12' : 'w-72'
    }`}>

      {/* Repos and Sessions */}
      <div className="flex-1 overflow-y-auto pb-2 px-1.5 pt-1.5 min-h-0">
        {repos.length === 0 ? (
          !isCollapsed && (
            <div className="text-center py-8 px-4">
              <p className="text-sm text-sidebar-foreground/70">No repositories connected</p>
              <p className="text-xs text-sidebar-foreground/50 mt-1">
                Run <code className="bg-sidebar-accent px-1 rounded-sm">lychee up</code>
              </p>
            </div>
          )
        ) : (
          <div className={`space-y-1 ${isCollapsed ? 'opacity-0' : 'opacity-100'} transition-opacity duration-150`}>
            {repos.map((repo) => {
              const isExpanded = expandedRepos.has(repo.path);
              const isActive = repo.path === activeRepoPath;
              const isCreating = isCreatingSession && creatingSessionForRepo === repo.path;

              return (
                <div key={repo.path}>
                  {/* Repo Header */}
                  <button
                    onClick={() => toggleRepo(repo.path)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer group text-left hover:bg-sidebar-accent"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-sidebar-foreground/50 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-sidebar-foreground/50 flex-shrink-0" />
                    )}
                    {isExpanded ? (
                      <FolderOpen className="w-3.5 h-3.5 text-sidebar-foreground/70 flex-shrink-0" />
                    ) : (
                      <FolderClosed className="w-3.5 h-3.5 text-sidebar-foreground/70 flex-shrink-0" />
                    )}
                    <span className="text-xs font-medium text-sidebar-foreground truncate flex-1">
                      {repo.name}
                    </span>
                  </button>

                  {/* Sessions */}
                  {isExpanded && (
                    <div className="ml-5 mt-0.5 space-y-0.5">
                      {/* New Branch Button */}
                      <button
                        onClick={() => onNewSession(repo.path)}
                        disabled={isCreating}
                        className={`w-full group flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer transition-colors text-left ${
                          isCreating
                            ? "text-sidebar-foreground/40"
                            : "hover:bg-sidebar-accent text-sidebar-foreground/60 hover:text-sidebar-foreground"
                        } ${isCreating ? "pointer-events-none" : ""}`}
                      >
                        <Plus className={`w-3 h-3 flex-shrink-0 ${isCreating ? "animate-spin" : ""}`} strokeWidth={2} />
                        <span className="text-xs">{isCreating ? "Creating..." : "New Branch"}</span>
                      </button>

                      {/* Session List */}
                      {repo.sessions.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-sidebar-foreground/40">
                          No branches yet
                        </div>
                      ) : (
                        repo.sessions.map((session) => {
                          const isActiveSession = session.lychee_id === currentSessionId && repo.path === activeRepoPath;
                          // Check the session's own isStreaming flag, not the global one
                          const isSessionStreaming = session.isStreaming || false;

                          return (
                            <button
                              key={session.lychee_id}
                              onClick={() => onSelectSession(repo.path, session.lychee_id)}
                              className={`w-full group flex items-start gap-2 px-2 py-1.5 rounded-sm cursor-pointer transition-colors text-left ${
                                isActiveSession
                                  ? "bg-sidebar-accent text-sidebar-foreground"
                                  : "hover:bg-sidebar-accent text-sidebar-foreground/70 hover:text-sidebar-foreground"
                              }`}
                            >
                              <GitBranch
                                className={`w-3 h-3 mt-0.5 flex-shrink-0 transition-colors ${
                                  isSessionStreaming
                                    ? "text-orange-500"
                                    : isActiveSession
                                      ? "text-sidebar-foreground"
                                      : "text-sidebar-foreground/40"
                                }`}
                                strokeWidth={2}
                              />
                              <div className="flex-1 min-w-0">
                                <div
                                  className="text-xs truncate leading-tight"
                                  title={session.lychee_id}
                                >
                                  {session.lychee_id}
                                </div>
                                <div className="text-xs text-sidebar-foreground/50 mt-0.5 leading-tight opacity-70">
                                  {formatRelativeTime(session.last_active || session.created_at)}
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
    </aside>
  );
}
