"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import ToolCallDisplay from "./ToolCallDisplay";
import { ClaudeToolUse, ChatMessage } from "@/lib/sessions";

interface WorklogItem {
  tool: ClaudeToolUse;
  precedingContext: string | null;
  originalMessage: ChatMessage;
}

interface WorklogSectionProps {
  items: WorklogItem[];
  onToolClick: (tool: ClaudeToolUse, context: string | null) => void;
  selectedToolId?: string;
}

export default function WorklogSection({
  items,
  onToolClick,
  selectedToolId
}: WorklogSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (items.length === 0) return null;

  return (
    <div className="border border-border rounded-lg bg-muted/30 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">
            Worklog
          </span>
          <span className="text-xs text-muted-foreground">
            ({items.length} tool call{items.length !== 1 ? 's' : ''})
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {isExpanded ? 'Collapse' : 'Expand to see details'}
        </span>
      </button>

      {/* Tool List */}
      {isExpanded && (
        <div className="px-4 py-3 space-y-2 border-t border-border bg-background/50">
          {items.map((item, idx) => (
            <div key={`worklog-item-${idx}`}>
              <ToolCallDisplay
                toolCall={item.tool}
                onClick={() => onToolClick(item.tool, item.precedingContext)}
                isExpanded={selectedToolId === item.tool.id}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
