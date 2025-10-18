"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSessionsContext } from "@/components/AppShell";
import ChatComposer from "@/components/ChatComposer";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import WorklogSection from "@/components/WorklogSection";
import { ChatMessage, ClaudeToolUse } from "@/lib/sessions";

interface WorklogItem {
  tool: ClaudeToolUse;
  precedingContext: string | null;
  originalMessage: ChatMessage;
}

interface ProcessedMessage {
  id: string;
  type: 'user' | 'assistant-text' | 'worklog' | 'system';
  content: string;
  worklogItems?: WorklogItem[];
  originalMessage?: ChatMessage;
}

// ============================================================================
// HELPER FUNCTIONS - Extract data from Claude Code message structures
// ============================================================================

/**
 * Extract text from message content (handles both string and block array formats)
 */
function getTextFromContent(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text || "")
    .join("");
}

/**
 * Extract tool_use blocks from message content
 */
function getToolsFromContent(content: unknown): ClaudeToolUse[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && (b as { type?: string }).type === "tool_use") as ClaudeToolUse[];
}

/**
 * Check if a user message is actually a tool result (system-generated, should be hidden)
 * Tool results have role="user" but contain only tool_result blocks, not actual user text
 */
function isToolResultMessage(msg: ChatMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;

  return msg.content.length > 0 &&
    msg.content.every((b: unknown) =>
      b && typeof b === "object" && (b as { type?: string }).type === "tool_result"
    );
}

// ============================================================================
// EXCHANGE PROCESSING - Process assistant message exchanges
// ============================================================================

/**
 * Process an assistant exchange (one or more consecutive assistant messages)
 * With file-based updates, all messages come from disk in the same format:
 * - Each JSONL entry becomes one message
 * - Tool calls create separate message entries
 * - We group them and extract the worklog
 */
function processExchange(msgs: ChatMessage[], exchangeId: string): ProcessedMessage[] {
  const result: ProcessedMessage[] = [];
  const worklog: WorklogItem[] = [];

  const firstText = getTextFromContent(msgs[0].content);
  const lastText = msgs.length > 1 ? getTextFromContent(msgs[msgs.length - 1].content) : "";

  // Show initial text from first message
  if (firstText.trim()) {
    result.push({
      id: `${exchangeId}-initial`,
      type: 'assistant-text',
      content: firstText,
      originalMessage: msgs[0]
    });
  }

  // Collect all tools with their preceding context
  let context = firstText || null;

  for (let j = 0; j < msgs.length; j++) {
    const msgText = getTextFromContent(msgs[j].content);
    const msgTools = getToolsFromContent(msgs[j].content);

    // Update context when we hit intermediate text messages
    if (j > 0 && msgText.trim()) {
      context = msgText;
    }

    // Skip tools from first message if it had display text (already shown above)
    const skipFirstMessageTools = j === 0 && firstText.trim();
    if (!skipFirstMessageTools) {
      msgTools.forEach(tool => {
        worklog.push({
          tool,
          precedingContext: context,
          originalMessage: msgs[j]
        });
      });
    }
  }

  // Add worklog
  if (worklog.length > 0) {
    result.push({
      id: `${exchangeId}-worklog`,
      type: 'worklog',
      content: '',
      worklogItems: worklog
    });
  }

  // Add final text if different from initial
  if (lastText.trim() && lastText !== firstText) {
    result.push({
      id: `${exchangeId}-final`,
      type: 'assistant-text',
      content: lastText,
      originalMessage: msgs[msgs.length - 1]
    });
  }

  return result;
}

// ============================================================================
// MAIN PROCESSING - Convert Claude Code messages to UI display format
// ============================================================================

/**
 * Transform raw Claude Code messages into UI-ready format
 *
 * Filters out:
 * - Sidechain messages (warmup, subagents)
 * - Tool result messages (system-generated user messages)
 *
 * Groups into exchanges:
 * - Each user message starts a new exchange
 * - Consecutive assistant messages form one exchange
 * - Each exchange shows: initial text → worklog → final text
 */
function processMessages(messages: ChatMessage[]): ProcessedMessage[] {
  const result: ProcessedMessage[] = [];

  // Filter out noise: warmup sidechains and tool results
  const cleanMessages = messages.filter(m => !m.isSidechain && !isToolResultMessage(m));

  let i = 0;
  let exchangeNum = 0;

  while (i < cleanMessages.length) {
    const msg = cleanMessages[i];

    // User message - straightforward
    if (msg.role === "user") {
      result.push({
        id: `user-${i}`,
        type: 'user',
        content: getTextFromContent(msg.content),
        originalMessage: msg
      });
      i++;
      continue;
    }

    // System message - straightforward
    if (msg.role === "system") {
      result.push({
        id: `system-${i}`,
        type: 'system',
        content: getTextFromContent(msg.content),
        originalMessage: msg
      });
      i++;
      continue;
    }

    // Assistant exchange - collect consecutive assistant messages
    if (msg.role === "assistant") {
      const exchangeId = `exchange-${exchangeNum++}`;
      const assistantMessages: ChatMessage[] = [];

      while (i < cleanMessages.length && cleanMessages[i].role === "assistant") {
        assistantMessages.push(cleanMessages[i]);
        i++;
      }

      // Process exchange (all messages from disk now - same format)
      const exchangeMessages = processExchange(assistantMessages, exchangeId);
      result.push(...exchangeMessages);
    }
  }

  return result;
}

export default function Home() {
  const { setSelectedToolCall, selectedToolCall, ...sessions } = useSessionsContext();

  const activeRepo = sessions.repos.find((repo) => repo.path === sessions.activeRepoPath) || null;
  const isStreaming = sessions.currentSessionId
    ? sessions.activeStreams.has(sessions.currentSessionId)
    : false;

  const messageContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastMessageCountRef = useRef(0);

  // Process messages to extract tool calls and filter sidechains
  const processedMessages = useMemo(
    () => processMessages(sessions.messages),
    [sessions.messages]
  );

  // Handle scroll position tracking
  useEffect(() => {
    const el = messageContainerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      // Consider user at bottom if within 100px
      shouldAutoScrollRef.current = distanceFromBottom < 100;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Smooth auto-scroll when messages update
  useEffect(() => {
    const el = messageContainerRef.current;
    if (!el) return;

    // Check if new messages were added
    const isNewMessage = processedMessages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = processedMessages.length;

    // Only auto-scroll if user is near bottom or it's a new message
    if (shouldAutoScrollRef.current || isNewMessage) {
      // Use requestAnimationFrame for smoother scrolling
      requestAnimationFrame(() => {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth'
        });
      });
    }
  }, [processedMessages]);

  // Continuous smooth scroll during streaming
  useEffect(() => {
    if (!isStreaming) return;

    const el = messageContainerRef.current;
    if (!el || !shouldAutoScrollRef.current) return;

    const scrollInterval = setInterval(() => {
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;

      // Smooth scroll if not at bottom
      if (distanceFromBottom > 5) {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth'
        });
      }
    }, 100); // Check every 100ms during streaming

    return () => clearInterval(scrollInterval);
  }, [isStreaming]);

  return (
    <div className="relative flex h-full flex-col">
      <div ref={messageContainerRef} className="flex-1 overflow-y-auto scroll-smooth scrollbar-thin">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8 pb-40">
          {processedMessages.length === 0 ? (
            <div className="mt-24 text-center text-muted-foreground">
              {isStreaming ? (
                <div className="thinking-indicator flex items-center justify-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-primary/70" />
                  <span className="animate-pulse">Claude is thinking...</span>
                </div>
              ) : !activeRepo && sessions.repos.length === 0 ? (
                <p className="text-sm">Run `lychee up` in a repository to connect.</p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {processedMessages.map((msg) => {
                if (msg.type === "user") {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[75%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                }

                if (msg.type === "assistant-text") {
                  const isPending = msg.content.trim().length === 0 && isStreaming;
                  return (
                    <div key={msg.id} className="flex justify-start">
                      <div className="w-full">
                        {isPending ? (
                          <div className="thinking-indicator flex items-center gap-2 text-muted-foreground">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-primary/70" />
                            <span className="animate-pulse">Claude is thinking...</span>
                          </div>
                        ) : (
                          <div>
                            <MarkdownRenderer content={msg.content} className="text-sm leading-relaxed" />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                if (msg.type === "worklog" && msg.worklogItems) {
                  return (
                    <div key={msg.id} className="flex justify-start">
                      <div className="w-full max-w-2xl">
                        <WorklogSection
                          items={msg.worklogItems}
                          onToolClick={(tool, context) => setSelectedToolCall({
                            tool,
                            contextMessage: { role: "assistant", content: context || "" }
                          })}
                          selectedToolId={selectedToolCall?.tool.id}
                        />
                      </div>
                    </div>
                  );
                }

                if (msg.type === "system") {
                  return (
                    <div key={msg.id} className="flex justify-center">
                      <div className="max-w-[80%] rounded-2xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm leading-relaxed text-yellow-800 shadow-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                }

                return null;
              })}

              {/* Show thinking indicator at the end if streaming but no assistant response yet */}
              {isStreaming && processedMessages.length > 0 && (
                <div className="flex justify-start">
                  <div className="thinking-indicator flex items-center gap-2 text-muted-foreground">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-primary/70" />
                    <span className="animate-pulse">Claude is thinking...</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex justify-center pb-1 bg-gradient-to-t from-background via-background to-transparent pt-8">
        <div className="pointer-events-auto w-full max-w-4xl px-6">
          <ChatComposer
            onSend={sessions.sendChatMessage}
            disabled={!sessions.currentSessionId || isStreaming}
            placeholder={
              sessions.currentSessionId
                ? isStreaming
                  ? "Claude is thinking..."
                  : "Message Claude..."
                : "Select or create a branch first"
            }
            selectedModel={sessions.selectedModel}
            onModelChange={sessions.setModel}
          />
        </div>
      </div>
    </div>
  );
}
