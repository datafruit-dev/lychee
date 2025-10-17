"use client";

import { ReactNode, useState, useEffect, createContext, useContext } from "react";
import Sidebar from "./Sidebar";
import RightSidebar from "./RightSidebar";
import TopBar from "./TopBar";
import SessionInfoPanel from "./SessionInfoPanel";
import { useSessions, ChatMessage, ClaudeToolUse } from "@/lib/sessions";

interface AppShellProps {
  children: ReactNode;
}

interface AppShellContextValue extends ReturnType<typeof useSessions> {
  selectedToolCall: {
    tool: ClaudeToolUse;
    contextMessage?: ChatMessage;
    precedingContext?: string | null;
  } | null;
  setSelectedToolCall: (toolCall: {
    tool: ClaudeToolUse;
    contextMessage?: ChatMessage;
    precedingContext?: string | null;
  } | null) => void;
  isRightSidebarOpen: boolean;
  toggleRightSidebar: () => void;
}

const SessionsContext = createContext<AppShellContextValue | null>(null);

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
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(288); // Default 288px (w-72)
  const [isResizingRightSidebar, setIsResizingRightSidebar] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [selectedToolCall, setSelectedToolCall] = useState<{
    tool: ClaudeToolUse;
    contextMessage?: ChatMessage;
    precedingContext?: string | null;
  } | null>(null);

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
  const toggleRightSidebar = () => setIsRightSidebarOpen(!isRightSidebarOpen);

  // Automatically open right sidebar when tool is selected
  useEffect(() => {
    if (selectedToolCall && !isRightSidebarOpen) {
      setIsRightSidebarOpen(true);
    }
  }, [selectedToolCall]);

  const contextValue: AppShellContextValue = {
    ...sessions,
    selectedToolCall,
    setSelectedToolCall,
    isRightSidebarOpen,
    toggleRightSidebar,
  };

  return (
    <SessionsContext.Provider value={contextValue}>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
        <TopBar
          isCollapsed={isCollapsed}
          onToggleSidebar={toggleSidebar}
          activeRepo={activeRepo}
          currentSessionId={sessions.currentSessionId}
          isStreaming={isStreaming}
          isRightSidebarOpen={isRightSidebarOpen}
          onToggleRightSidebar={toggleRightSidebar}
          rightSidebarWidth={rightSidebarWidth}
          isResizingRightSidebar={isResizingRightSidebar}
          isPanelOpen={isPanelOpen}
          onTogglePanel={() => setIsPanelOpen(!isPanelOpen)}
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
            isStreaming={isStreaming}
          />

          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* Session info panel - pushes content down when open */}
            {activeRepo && sessions.currentSessionId && (
              <SessionInfoPanel
                isOpen={isPanelOpen}
                onClose={() => setIsPanelOpen(false)}
                repoName={activeRepo.name}
                sessionId={sessions.currentSessionId}
                branchOrigin="origin/main"
              />
            )}

            {/* Main content area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {children}
            </div>
          </div>

          <RightSidebar
            isOpen={isRightSidebarOpen}
            onToggle={toggleRightSidebar}
            width={rightSidebarWidth}
            onWidthChange={setRightSidebarWidth}
            onResizingChange={setIsResizingRightSidebar}
            selectedToolCall={selectedToolCall}
            onToolCallClose={() => {
              setSelectedToolCall(null);
              setIsRightSidebarOpen(false);
            }}
          />
        </div>
      </div>
    </SessionsContext.Provider>
  );
}

