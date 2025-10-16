"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import type { RepoInfo } from "@/lib/sessions";
import SessionInfoPanel from "./SessionInfoPanel";

interface TopBarProps {
  isCollapsed: boolean;
  onToggleSidebar: () => void;
  activeRepo: RepoInfo | null;
  currentSessionId: string | null;
  isStreaming: boolean;
  isRightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  rightSidebarWidth: number;
  isResizingRightSidebar: boolean;
}

export default function TopBar({
  isCollapsed,
  onToggleSidebar,
  activeRepo,
  currentSessionId,
  isStreaming,
  isRightSidebarOpen,
  onToggleRightSidebar,
  rightSidebarWidth,
  isResizingRightSidebar,
}: TopBarProps) {
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  return (
    <div className="flex-shrink-0 flex h-12">
      {/* Sidebar section - fixed height */}
      <div
        className={`flex-shrink-0 h-12 bg-sidebar transition-all duration-150 ease-out ${
          isCollapsed ? "w-12" : "w-72"
        } flex items-center ${isCollapsed ? "justify-start" : "justify-between"} px-1.5 border-r border-b border-border`}
      >
        {isCollapsed ? (
          <button
            onClick={onToggleSidebar}
            className="group w-9 h-9 flex-shrink-0 transition-all relative flex items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent focus:outline-none"
            title="Expand sidebar"
          >
            <Image
              src="/logo.svg"
              alt="logo"
              width={20}
              height={20}
              className="relative z-10 flex-shrink-0 block group-hover:hidden"
            />
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
          </button>
        ) : (
          <>
            <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center">
              <Image
                src="/logo.svg"
                alt="logo"
                width={20}
                height={20}
                className="relative z-10 flex-shrink-0"
              />
            </div>
            <button
              onClick={onToggleSidebar}
              className="w-9 h-9 flex-shrink-0 transition-all relative flex items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent focus:outline-none"
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
          </>
        )}
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col bg-background">
        <div className="h-12 flex items-center justify-between px-4 border-b border-border">
          {activeRepo && currentSessionId ? (
            <div className="flex items-center gap-3 text-sm">
              {!isPanelOpen && (
                <>
                  <div className="font-medium text-foreground">{activeRepo.name}</div>
                  <div className="text-muted-foreground">/</div>
                  <div className="text-muted-foreground">{currentSessionId}</div>
                  <button
                    data-dropdown-trigger
                    onClick={() => setIsPanelOpen(true)}
                    className="ml-1 p-1 rounded hover:bg-muted transition-colors"
                    aria-label="Show session info"
                  >
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {activeRepo ? "Select a branch" : "No repository selected"}
            </div>
          )}
        </div>

        {/* Session info panel - only in main content area */}
        {activeRepo && currentSessionId && (
          <SessionInfoPanel
            isOpen={isPanelOpen}
            onClose={() => setIsPanelOpen(false)}
            repoName={activeRepo.name}
            sessionId={currentSessionId}
            branchOrigin="origin/main"
          />
        )}

        {/* Temporary toggle button */}
        <button
          onClick={onToggleRightSidebar}
          className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent border border-border"
          title={isRightSidebarOpen ? "Close tool calls" : "Open tool calls"}
        >
          Tool Calls
        </button>
      </div>

      {/* Right sidebar section of top bar */}
      <div
        className="flex-shrink-0 h-12 bg-sidebar border-l border-b border-border overflow-hidden"
        style={{
          width: isRightSidebarOpen ? `${rightSidebarWidth}px` : '0px',
          transition: isResizingRightSidebar ? 'none' : 'all 150ms ease-out',
        }}
      />
    </div>
  );
}