"use client";

import { ClaudeToolUse, ChatMessage } from "@/lib/sessions";
import { X } from "lucide-react";

interface ToolDetailPanelProps {
  toolCall: ClaudeToolUse;
  contextMessage?: ChatMessage;
  precedingContext?: string | null;
  onClose: () => void;
}

export default function ToolDetailPanel({
  toolCall,
  contextMessage,
  precedingContext,
  onClose
}: ToolDetailPanelProps) {
  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <h3 className="font-semibold text-sm">Tool Call Details</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{toolCall.name}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-muted rounded-md transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Preceding Context (from worklog) */}
        {precedingContext && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Context
            </h4>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-sm whitespace-pre-wrap">{precedingContext}</p>
            </div>
          </div>
        )}

        {/* Context Message (legacy - for non-worklog tools) */}
        {!precedingContext && contextMessage && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Context
            </h4>
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-sm">
                {typeof contextMessage.content === "string"
                  ? contextMessage.content
                  : contextMessage.content
                      ?.filter((block: unknown) => (block as {type?: string}).type === "text")
                      .map((block: unknown) => (block as {text?: string}).text)
                      .join("")}
              </p>
            </div>
          </div>
        )}

        {/* Tool Information */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Tool
          </h4>
          <div className="bg-muted/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">{toolCall.name}</span>
              <span className="text-xs text-muted-foreground">#{toolCall.id.slice(0, 8)}</span>
            </div>
          </div>
        </div>

        {/* Input Parameters */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Input
          </h4>
          <div className="bg-muted/50 rounded-lg p-3">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
        </div>

        {/* Tool-specific rendering */}
        {renderToolSpecificContent(toolCall)}
      </div>
    </div>
  );
}

function renderToolSpecificContent(toolCall: ClaudeToolUse) {
  const { name, input } = toolCall;

  switch (name) {
    case "Bash":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Command
          </h4>
          <div className="bg-gray-900 text-gray-100 rounded-lg p-3 font-mono text-sm">
            <code>{input.command as string}</code>
          </div>
        </div>
      );

    case "Read":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            File Path
          </h4>
          <div className="bg-muted rounded-lg p-3">
            <code className="text-sm">{input.file_path as string}</code>
            {input.offset ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Starting at line {input.offset as number}
                {input.limit ? `, reading ${input.limit as number} lines` : ''}
              </div>
            ) : null}
          </div>
        </div>
      );

    case "Write":
    case "Edit":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            File Path
          </h4>
          <div className="bg-muted rounded-lg p-3">
            <code className="text-sm">{input.file_path as string}</code>
          </div>
          {name === "Edit" && input.old_string ? (
            <>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Changes
              </h4>
              <div className="space-y-2">
                <div className="bg-red-50 border border-red-200 rounded-lg p-2">
                  <p className="text-xs text-red-600 font-medium mb-1">- Remove</p>
                  <pre className="text-xs font-mono whitespace-pre-wrap">
                    {input.old_string as string}
                  </pre>
                </div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-2">
                  <p className="text-xs text-green-600 font-medium mb-1">+ Add</p>
                  <pre className="text-xs font-mono whitespace-pre-wrap">
                    {input.new_string as string}
                  </pre>
                </div>
              </div>
            </>
          ) : null}
        </div>
      );

    case "Glob":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Pattern
          </h4>
          <div className="bg-muted rounded-lg p-3">
            <code className="text-sm">{input.pattern as string}</code>
            {input.path ? (
              <div className="mt-2 text-xs text-muted-foreground">
                In directory: {input.path as string}
              </div>
            ) : null}
          </div>
        </div>
      );

    case "Grep":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Search Pattern
          </h4>
          <div className="bg-muted rounded-lg p-3">
            <code className="text-sm">{input.pattern as string}</code>
            {input.path ? (
              <div className="mt-2 text-xs text-muted-foreground">
                In: {input.path as string}
              </div>
            ) : null}
            {input.glob ? (
              <div className="text-xs text-muted-foreground">
                Files matching: {input.glob as string}
              </div>
            ) : null}
          </div>
        </div>
      );

    case "Task":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Agent Task
          </h4>
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
            <p className="text-sm font-medium text-purple-700 mb-1">
              {input.subagent_type as string}
            </p>
            <p className="text-xs text-purple-600">{input.description as string}</p>
          </div>
          {input.prompt ? (
            <>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Prompt
              </h4>
              <div className="bg-muted rounded-lg p-3">
                <p className="text-sm whitespace-pre-wrap">{input.prompt as string}</p>
              </div>
            </>
          ) : null}
        </div>
      );

    case "WebFetch":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            URL
          </h4>
          <div className="bg-muted rounded-lg p-3">
            <a
              href={input.url as string}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              {input.url as string}
            </a>
            {input.prompt ? (
              <div className="mt-2 pt-2 border-t">
                <p className="text-xs text-muted-foreground mb-1">Analysis prompt:</p>
                <p className="text-sm">{input.prompt as string}</p>
              </div>
            ) : null}
          </div>
        </div>
      );

    case "WebSearch":
      return (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Search Query
          </h4>
          <div className="bg-muted rounded-lg p-3">
            <p className="text-sm font-medium">{input.query as string}</p>
            {input.allowed_domains ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Limited to: {(input.allowed_domains as string[]).join(", ")}
              </div>
            ) : null}
          </div>
        </div>
      );

    default:
      return null;
  }
}