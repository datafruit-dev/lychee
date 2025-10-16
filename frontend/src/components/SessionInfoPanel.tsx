"use client";

import { useRef } from "react";
import { ChevronUp } from "lucide-react";

interface SessionInfoPanelProps {
  isOpen: boolean;
  onClose: () => void;
  repoName: string;
  sessionId: string;
  branchOrigin?: string;
}

export default function SessionInfoPanel({
  isOpen,
  onClose,
  repoName,
  sessionId,
  branchOrigin = "origin/main",
}: SessionInfoPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // No click-outside detection - panel stays open until explicitly closed
  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className="session-info-panel bg-background border-b border-border"
      style={{
        height: '33vh',
        minHeight: '280px',
      }}
    >
      <div className="h-full relative flex items-center px-8 py-12">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none">
          <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid-pattern)" />
          </svg>
        </div>

        {/* Content */}
        <div className="relative max-w-4xl w-full space-y-6">
          {/* Title */}
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">
              Welcome to workspace
            </h1>
            <h2 className="text-3xl font-semibold text-primary tracking-tight">
              {sessionId}
            </h2>
          </div>

          {/* Details */}
          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-primary/40" />
              Branched <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">{sessionId}</code> from{' '}
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">{branchOrigin}</code>
            </p>
            <p className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-primary/40" />
              Created <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">.lychee/{sessionId}</code>
            </p>
          </div>

          {/* Repo badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 border border-primary/10 rounded-full">
            <div className="w-2 h-2 rounded-full bg-primary/60 animate-pulse" />
            <span className="text-sm font-medium text-foreground/80">{repoName}</span>
          </div>
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 text-muted-foreground hover:text-foreground transition-colors p-2 rounded hover:bg-muted z-10 cursor-pointer"
          aria-label="Close session info"
          type="button"
        >
          <ChevronUp className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}