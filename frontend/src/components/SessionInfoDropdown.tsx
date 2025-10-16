"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";

interface SessionInfoDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  repoName: string;
  sessionId: string;
  branchOrigin?: string;
}

export default function SessionInfoDropdown({
  isOpen,
  onClose,
  repoName,
  sessionId,
  branchOrigin = "origin/main",
}: SessionInfoDropdownProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      // Trigger fade in after mount
      requestAnimationFrame(() => {
        setIsAnimating(true);
      });
    } else {
      // Trigger fade out
      setIsAnimating(false);
      // Keep mounted during fade out animation
      const timer = setTimeout(() => {
        setShouldRender(false);
      }, 300); // Match animation duration
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Click outside detection
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contentRef.current && !contentRef.current.contains(event.target as Node)) {
        // Check if click was on the trigger button
        const target = event.target as HTMLElement;
        if (!target.closest('[data-session-trigger]')) {
          onClose();
        }
      }
    };

    if (isOpen) {
      // Small delay to prevent immediate close on open
      const timer = setTimeout(() => {
        document.addEventListener("mousedown", handleClickOutside);
      }, 100);

      return () => {
        clearTimeout(timer);
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isOpen, onClose]);

  if (!shouldRender) return null;

  return (
    <div
      ref={contentRef}
      className={`bg-background transition-opacity duration-300 ease-in-out ${
        isAnimating ? "opacity-100" : "opacity-0"
      }`}
      style={{
        height: "33vh",
        minHeight: "280px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="h-full relative flex items-center px-8 py-12">
        {/* Background pattern - subtle geometric design */}
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none">
          <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
        </div>

        {/* Content container */}
        <div className="relative max-w-4xl w-full space-y-6">
          {/* Welcome section */}
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">
              Welcome to workspace
            </h1>
            <h2 className="text-3xl font-semibold text-primary tracking-tight">
              {sessionId}
            </h2>
          </div>

          {/* Session details */}
          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="flex items-center gap-2">
              <span className="inline-block w-1 h-1 rounded-full bg-primary/40"></span>
              Branched <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">{sessionId}</code> from <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">{branchOrigin}</code>
            </p>
            <p className="flex items-center gap-2">
              <span className="inline-block w-1 h-1 rounded-full bg-primary/40"></span>
              Created <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">.lychee/{sessionId}</code>
            </p>
          </div>

          {/* Repository name badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/5 border border-primary/10 rounded-full">
            <div className="w-2 h-2 rounded-full bg-primary/60 animate-pulse"></div>
            <span className="text-sm font-medium text-foreground/80">{repoName}</span>
          </div>
        </div>

        {/* Close button with chevron */}
        <button
          onClick={onClose}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close session info"
        >
          <ChevronUp className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}