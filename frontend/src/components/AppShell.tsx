"use client";

import { ReactNode, useState, useEffect, useMemo, createContext, useContext } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import { useSessions } from "@/lib/sessions";

interface AppShellProps {
  children: ReactNode;
}

type SessionsContextValue = ReturnType<typeof useSessions>;

const SessionsContext = createContext<SessionsContextValue | null>(null);

export function useSessionsContext() {
  const ctx = useContext(SessionsContext);
  if (!ctx) {
    throw new Error("useSessionsContext must be used within AppShell");
  }
  return ctx;
}

export default function AppShell({ children }: AppShellProps) {
  const sessions = useSessions();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  const activeRepo = sessions.repos.find((repo) => repo.path === sessions.activeRepoPath) || null;
  const isStreaming = sessions.currentSessionId
    ? sessions.activeStreams.has(sessions.currentSessionId)
    : false;


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

  const toggleSidebar = () => setIsCollapsed(!isCollapsed);

  return (
    <SessionsContext.Provider value={sessions}>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
        <TopBar
          isCollapsed={isCollapsed}
          onToggleSidebar={toggleSidebar}
          activeRepo={activeRepo}
          currentSessionId={sessions.currentSessionId}
          isStreaming={isStreaming}
        />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar
            repos={sessions.repos}
            activeRepoPath={sessions.activeRepoPath}
            currentSessionId={sessions.currentSessionId}
            onSelectSession={sessions.selectSession}
            onNewSession={sessions.createSession}
            creatingSessionForRepo={sessions.creatingSessionForRepo}
            isCreatingSession={sessions.isCreatingSession}
            isCollapsed={isCollapsed}
            onToggleSidebar={toggleSidebar}
          />
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {children}
          </div>
        </div>
      </div>
    </SessionsContext.Provider>
  );
}

