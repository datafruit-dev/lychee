"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Plus, GitBranch, FolderOpen, FolderClosed } from "lucide-react";
import Image from "next/image";

export interface Session {
  id: string;
  created_at: string;
}

export interface Repo {
  name: string;
  path: string;
  sessions: Session[];
}

interface SidebarProps {
  repos: Repo[];
  activeRepoPath: string | null;
  currentSessionId: string | null;
  creatingSessionForRepo?: string | null;
  onSelectSession: (repoPath: string, sessionId: string) => void;
  onNewSession: (repoPath: string) => void;
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
  creatingSessionForRepo,
  onSelectSession,
  onNewSession,
}: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(
    new Set(repos.map((r) => r.path))
  );

  useEffect(() => {
    try {
      const stored = localStorage.getItem('lychee-sidebar-collapsed');
      if (stored !== null) {
        setIsCollapsed(stored === 'true');
      }
    } catch (error) {
      console.warn('localStorage access failed:', error);
    }
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (hasMounted) {
      localStorage.setItem('lychee-sidebar-collapsed', String(isCollapsed));
    }
  }, [isCollapsed, hasMounted]);

  // Auto-expand new repos
  useEffect(() => {
    setExpandedRepos(new Set(repos.map((r) => r.path)));
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

  const toggleSidebar = () => setIsCollapsed(!isCollapsed);

  return (
    <aside className={`flex-shrink-0 bg-gray-50 flex flex-col pt-[2px] border-r border-gray-200 overflow-hidden ${hasMounted ? 'transition-all duration-150 ease-out' : ''} ${
      isCollapsed ? 'w-12' : 'w-72'
    }`}>
      {/* Header with collapse button */}
      <div className={`flex items-center ${isCollapsed ? 'justify-start' : 'justify-between'} py-2 px-1.5`}>
        <button
          onClick={toggleSidebar}
          className={`${isCollapsed ? 'group' : ''} w-9 h-9 flex-shrink-0 transition-all relative flex items-center justify-center rounded text-gray-600 hover:text-gray-900 hover:bg-gray-100 focus:outline-none`}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <Image
            src="/logo.svg"
            alt="logo"
            width={20}
            height={20}
            className={`relative z-10 flex-shrink-0 ${isCollapsed ? 'block group-hover:hidden' : ''}`}
          />
          {isCollapsed && (
            <svg
              className="w-3.5 h-3.5 relative z-10 flex-shrink-0 hidden group-hover:block"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          )}
        </button>
        {!isCollapsed && (
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 flex-shrink-0 transition-all relative flex items-center justify-center rounded text-gray-600 hover:text-gray-900 hover:bg-gray-100 focus:outline-none"
            title="Collapse sidebar"
          >
            <svg
              className="w-3.5 h-3.5 relative z-10 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Repos and Sessions */}
      <div className="flex-1 overflow-y-auto pb-2 px-1.5 min-h-0">
        {repos.length === 0 ? (
          !isCollapsed && (
            <div className="text-center py-8 px-4">
              <p className="text-sm text-gray-500">No repositories connected</p>
              <p className="text-xs text-gray-400 mt-1">
                Run <code className="bg-gray-100 px-1 rounded">lychee up</code>
              </p>
            </div>
          )
        ) : (
          <div className={`space-y-1 ${isCollapsed ? 'opacity-0' : 'opacity-100'} transition-opacity duration-150`}>
            {repos.map((repo) => {
              const isExpanded = expandedRepos.has(repo.path);
              const isActive = repo.path === activeRepoPath;

              return (
                <div key={repo.path}>
                  {/* Repo Header */}
                  <button
                    onClick={() => toggleRepo(repo.path)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group text-left ${
                      isActive ? 'bg-gray-100' : 'hover:bg-gray-100'
                    }`}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                    )}
                    {isExpanded ? (
                      <FolderOpen className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />
                    ) : (
                      <FolderClosed className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />
                    )}
                    <span className="text-xs font-medium text-gray-900 truncate flex-1">
                      {repo.name}
                    </span>
                  </button>

                  {/* Sessions */}
                  {isExpanded && (
                    <div className="ml-5 mt-0.5 space-y-0.5 overflow-hidden">
                      {/* New Branch Button */}
                      <button
                        onClick={() => onNewSession(repo.path)}
                        disabled={creatingSessionForRepo === repo.path}
                        className="w-full group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors text-left hover:bg-gray-100 text-gray-600 hover:text-gray-900 disabled:opacity-50"
                      >
                        {creatingSessionForRepo === repo.path ? (
                          <svg className="animate-spin w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        ) : (
                          <Plus className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
                        )}
                        <span className="text-xs">New Branch</span>
                      </button>

                      {/* Session List */}
                      {repo.sessions.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-gray-400">
                          No branches yet
                        </div>
                      ) : (
                        [...repo.sessions]
                          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                          .map((session) => {
                          const isActiveSession = session.id === currentSessionId && repo.path === activeRepoPath;

                          return (
                            <button
                              key={session.id}
                              onClick={() => onSelectSession(repo.path, session.id)}
                              className={`w-full group flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-all duration-300 ease-out text-left ${
                                creatingSessionForRepo === repo.path ? 'animate-push-down' : ''
                              } ${
                                isActiveSession
                                  ? "bg-gray-900/10 text-gray-900"
                                  : "hover:bg-gray-100 text-gray-700 hover:text-gray-900"
                              }`}
                            >
                              <GitBranch
                                className={`w-3 h-3 mt-0.5 flex-shrink-0 ${
                                  isActiveSession ? "text-gray-900" : "text-gray-400"
                                }`}
                                strokeWidth={2}
                              />
                              <div className="flex-1 min-w-0">
                                <div
                                  className="text-xs truncate leading-tight"
                                  title={session.id}
                                >
                                  {session.id}
                                </div>
                                <div className="text-xs text-gray-500 mt-0.5 leading-tight opacity-70">
                                  {formatRelativeTime(session.created_at)}
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