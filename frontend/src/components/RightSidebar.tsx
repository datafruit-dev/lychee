"use client";

import { useRef, useEffect, useState, useCallback } from "react";

interface RightSidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onResizingChange: (isResizing: boolean) => void;
}

export default function RightSidebar({
  isOpen,
  onToggle,
  width,
  onWidthChange,
  onResizingChange,
}: RightSidebarProps) {
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const onWidthChangeRef = useRef(onWidthChange);
  const onResizingChangeRef = useRef(onResizingChange);

  // Keep refs up to date
  useEffect(() => {
    onWidthChangeRef.current = onWidthChange;
    onResizingChangeRef.current = onResizingChange;
  });

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return;
      
      const sidebarRect = sidebarRef.current.getBoundingClientRect();
      const newWidth = sidebarRect.right - e.clientX;
      
      // Constrain width between 200px and 800px
      const constrainedWidth = Math.min(Math.max(newWidth, 200), 800);
      onWidthChangeRef.current(constrainedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      onResizingChangeRef.current(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    onResizingChange(true);
  };

  return (
    <aside
      ref={sidebarRef}
      className="flex-shrink-0 bg-sidebar flex flex-col border-l border-border overflow-hidden transition-all duration-150 ease-out relative"
      style={{
        width: isOpen ? `${width}px` : '0px',
        transition: isResizing ? 'none' : undefined,
      }}
    >
      {/* Resize Handle */}
      {isOpen && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-10"
          style={{
            marginLeft: '-2px',
          }}
        />
      )}

      {/* Content */}
      <div className={`flex-1 overflow-y-auto pb-2 px-1.5 pt-1.5 min-h-0 ${isOpen ? 'opacity-100' : 'opacity-0'} transition-opacity duration-150`}>
        <div className="p-4">
          <h3 className="text-sm font-medium text-sidebar-foreground mb-2">Tool Call Details</h3>
          <p className="text-xs text-sidebar-foreground/70">
            Click on a tool call to view details here.
          </p>
        </div>
      </div>
    </aside>
  );
}
