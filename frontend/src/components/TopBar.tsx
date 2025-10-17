"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import type { RepoInfo } from "@/lib/sessions";

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
  isPanelOpen: boolean;
  onTogglePanel: () => void;
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
  isPanelOpen,
  onTogglePanel,
}: TopBarProps) {
  const [showHeaderContent, setShowHeaderContent] = useState(true);

  // Handle fade in/out of header content
  useEffect(() => {
    if (isPanelOpen) {
      setShowHeaderContent(false);
    } else {
      // Delay showing header content to create fade-in effect
      const timer = setTimeout(() => {
        setShowHeaderContent(true);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isPanelOpen]);

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
        <div className={`h-12 flex items-center justify-between px-4 border-border ${
          isPanelOpen ? '' : 'border-b'
        }`}>
          <div className="flex items-center gap-3">
            {activeRepo && currentSessionId ? (
              <div className="flex items-center gap-3 text-sm">
                <div
                  className={`flex items-center gap-3 transition-opacity duration-300 ${
                    showHeaderContent ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <div className="font-medium text-foreground">{activeRepo.name}</div>
                  <div className="text-muted-foreground">/</div>
                  <div className="text-muted-foreground">{currentSessionId}</div>
                  <button
                    data-dropdown-trigger
                    onClick={onTogglePanel}
                    className="ml-1 p-1 rounded hover:bg-muted transition-colors"
                    aria-label="Show session info"
                  >
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {activeRepo ? "Select a branch" : "No repository selected"}
              </div>
            )}
          </div>

          {/* Tool Calls toggle button - fade in/out with panel */}
          <button
            onClick={onToggleRightSidebar}
            className={`px-3 py-1.5 text-xs font-medium rounded-md bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent border border-border transition-opacity duration-300 ${
              showHeaderContent ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            title={isRightSidebarOpen ? "Close tool calls" : "Open tool calls"}
          >
            Tool Calls
          </button>
        </div>
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