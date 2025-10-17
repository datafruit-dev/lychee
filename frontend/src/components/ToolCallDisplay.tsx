"use client";

import { ClaudeToolUse } from "@/lib/sessions";

interface ToolCallDisplayProps {
  toolCall: ClaudeToolUse;
  onClick?: () => void;
  isExpanded?: boolean;
}

// Map Claude Code tool names to user-friendly display names
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // File operations
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Glob: "Finding files",
  Grep: "Searching code",

  // Execution
  Bash: "Running command",
  Task: "Running agent",
  SlashCommand: "Running command",

  // Web operations
  WebFetch: "Fetching webpage",
  WebSearch: "Searching web",

  // Notebook operations
  NotebookRead: "Reading notebook",
  NotebookEdit: "Editing notebook",

  // Task management
  TodoWrite: "Updating todos",
};

// Map tools to colors (using Tailwind CSS classes)
const TOOL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  // File operations - green theme
  Read: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" },
  Write: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" },
  Edit: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" },

  // Search operations - blue theme
  Glob: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },
  Grep: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },
  WebSearch: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },

  // Execution - purple theme
  Bash: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200" },
  Task: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200" },
  SlashCommand: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200" },

  // Web operations - amber theme
  WebFetch: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },

  // Default
  default: { bg: "bg-gray-50", text: "text-gray-700", border: "border-gray-200" },
};

function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] || toolName.replace(/_/g, " ");
}

function getToolColors(toolName: string) {
  return TOOL_COLORS[toolName] || TOOL_COLORS.default;
}

function formatToolArgs(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Read":
      return args.file_path as string || null;
    case "Write":
    case "Edit":
      return args.file_path as string || null;
    case "Bash":
      return args.command as string || null;
    case "Glob":
      return args.pattern as string || null;
    case "Grep":
      return args.pattern as string || null;
    case "WebFetch":
      return args.url as string || null;
    case "WebSearch":
      return args.query as string || null;
    case "Task":
      return args.description as string || null;
    default:
      return null;
  }
}

export default function ToolCallDisplay({
  toolCall,
  onClick,
  isExpanded = false
}: ToolCallDisplayProps) {
  const displayName = getToolDisplayName(toolCall.name);
  const colors = getToolColors(toolCall.name);
  const argDisplay = formatToolArgs(toolCall.name, toolCall.input);

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border transition-all ${colors.bg} ${colors.text} ${colors.border} ${
        onClick ? "cursor-pointer hover:shadow-sm" : ""
      } ${isExpanded ? "ring-2 ring-offset-2 ring-primary/20" : ""}`}
      onClick={onClick}
    >
      {/* Status indicator */}
      <span className="flex-shrink-0">
        <svg
          className="w-3.5 h-3.5"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
      </span>

      {/* Tool name */}
      <span className="font-medium">{displayName}</span>

      {/* Optional argument display */}
      {argDisplay && (
        <span className="text-xs opacity-70 truncate max-w-[200px]">
          {argDisplay}
        </span>
      )}
    </div>
  );
}