"use client";

import Image from "next/image";

interface TopBarProps {
  isCollapsed: boolean;
  onToggleSidebar: () => void;
}

export default function TopBar({ isCollapsed, onToggleSidebar }: TopBarProps) {
  return (
    <div className="flex-shrink-0 flex items-center h-12 border-b border-sidebar-border bg-sidebar">
      {/* Sidebar section of top bar */}
      <div className={`flex-shrink-0 transition-all duration-150 ease-out h-12 ${
        isCollapsed ? 'w-12' : 'w-72'
      } flex items-center ${isCollapsed ? 'justify-start' : 'justify-between'} px-1.5 border-r border-sidebar-border`}>
        {isCollapsed ? (
          <button
            onClick={onToggleSidebar}
            className="group w-9 h-9 flex-shrink-0 transition-all relative flex items-center justify-center rounded text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent focus:outline-none"
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
              className="w-9 h-9 flex-shrink-0 transition-all relative flex items-center justify-center rounded text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent focus:outline-none"
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

      {/* Main content section of top bar */}
      <div className="flex-1 h-12 flex items-center px-4 bg-background">
        {/* You can add top bar content here like breadcrumbs, title, etc. */}
      </div>
    </div>
  );
}
