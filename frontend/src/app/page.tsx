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

function extractMessageContent(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && (block as {type?: string}).type === "text")
      .map((block) => (block as {text?: string}).text || "")
      .join("");
  }
  return "";
}

function extractToolCalls(content: unknown): ClaudeToolUse[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((block) => block && (block as {type?: string}).type === "tool_use") as ClaudeToolUse[];
}

function isToolResultMessage(msg: ChatMessage): boolean {
  if (msg.role !== "user") return false;

  if (Array.isArray(msg.content)) {
    // Check if all content blocks are tool_result
    const hasOnlyToolResults = msg.content.length > 0 &&
      msg.content.every((block: unknown) => block && typeof block === "object" && (block as {type?: string}).type === "tool_result");
    return hasOnlyToolResults;
  }

  return false;
}

function processMessages(messages: ChatMessage[]): ProcessedMessage[] {
  const processed: ProcessedMessage[] = [];

  // Filter out sidechain messages and tool result messages
  const mainMessages = messages.filter(msg =>
    !msg.isSidechain && !isToolResultMessage(msg)
  );

  let i = 0;
  let exchangeCounter = 0;

  while (i < mainMessages.length) {
    const msg = mainMessages[i];

    if (msg.role === "user") {
      processed.push({
        id: `user-${i}`,
        type: 'user',
        content: extractMessageContent(msg.content),
        originalMessage: msg
      });
      i++;
    } else if (msg.role === "assistant") {
      // Collect all consecutive assistant messages (one exchange)
      const exchangeMessages: ChatMessage[] = [];
      const exchangeStartIdx = i;
      while (i < mainMessages.length && mainMessages[i].role === "assistant") {
        exchangeMessages.push(mainMessages[i]);
        i++;
      }

      console.log(`[Exchange] Found ${exchangeMessages.length} assistant messages in exchange`);

      // Process this exchange - use stable IDs based on exchange number
      const exchangeId = `exchange-${exchangeCounter++}`;
      const worklogItems: WorklogItem[] = [];

      // Special case: Single message with multiple content blocks (STREAMING)
      if (exchangeMessages.length === 1) {
        const singleMsg = exchangeMessages[0];
        const content = singleMsg.content;

        if (Array.isArray(content)) {
          const hasTools = content.some((b: unknown) => (b as {type?: string}).type === "tool_use");

          if (!hasTools) {
            // No tools - just show all text
            const allText = content
              .filter((b: unknown) => (b as {type?: string}).type === "text")
              .map((b: unknown) => (b as {text?: string}).text || "")
              .join("");

            if (allText.trim()) {
              processed.push({
                id: `${exchangeId}-text`,
                type: 'assistant-text',
                content: allText,
                originalMessage: singleMsg
              });
            }
          } else {
            // Has tools - split text using snapshot
            const allText = content
              .filter((b: unknown) => (b as {type?: string}).type === "text")
              .map((b: unknown) => (b as {text?: string}).text || "")
              .join("");

            const toolBlocks = content.filter((b: unknown) => (b as {type?: string}).type === "tool_use") as ClaudeToolUse[];

            // Use snapshot to split text
            const splitPoint = singleMsg.textLengthAtTools || 0;
            const textBeforeTools = splitPoint > 0 ? allText.slice(0, splitPoint) : allText;
            const textAfterTools = splitPoint > 0 ? allText.slice(splitPoint) : "";

            // Show initial text
            if (textBeforeTools.trim()) {
              processed.push({
                id: `${exchangeId}-initial`,
                type: 'assistant-text',
                content: textBeforeTools,
                originalMessage: singleMsg
              });
            }

            // Show worklog
            if (toolBlocks.length > 0) {
              processed.push({
                id: `${exchangeId}-worklog`,
                type: 'worklog',
                content: '',
                worklogItems: toolBlocks.map(tool => ({
                  tool,
                  precedingContext: textBeforeTools || null,
                  originalMessage: singleMsg
                }))
              });
            }

            // Show final text (text that comes after tools)
            if (textAfterTools.trim()) {
              processed.push({
                id: `${exchangeId}-final`,
                type: 'assistant-text',
                content: textAfterTools,
                originalMessage: singleMsg
              });
            }
          }
        } else {
          // Plain string content (no tools)
          const text = extractMessageContent(singleMsg.content);
          if (text.trim()) {
            processed.push({
              id: `${exchangeId}-text`,
              type: 'assistant-text',
              content: text,
              originalMessage: singleMsg
            });
          }
        }
      } else {
        // Multiple messages (LOADED FROM DISK)
        const firstMsg = exchangeMessages[0];
        const lastMsg = exchangeMessages[exchangeMessages.length - 1];

        const firstText = extractMessageContent(firstMsg.content);
        const lastText = extractMessageContent(lastMsg.content);

        // Show first text if present
        if (firstText.trim()) {
          processed.push({
            id: `${exchangeId}-initial`,
            type: 'assistant-text',
            content: firstText,
            originalMessage: firstMsg
          });
        }

        // Build worklog from all messages
        let currentContext: string | null = firstText || null;

        for (let j = 0; j < exchangeMessages.length; j++) {
          const exMsg = exchangeMessages[j];
          const msgText = extractMessageContent(exMsg.content);
          const tools = extractToolCalls(exMsg.content);

          // Update context from any message with text
          if (j > 0 && msgText.trim()) {
            currentContext = msgText;
          }

          // Add tools from all but first message (if first had text)
          if (j > 0 || !firstText.trim()) {
            tools.forEach(tool => {
              worklogItems.push({
                tool,
                precedingContext: currentContext,
                originalMessage: exMsg
              });
            });
          }
        }

        // Show final text if different from first
        const finalText = lastText.trim() && exchangeMessages.length > 1 && lastText !== firstText ? lastText : null;

        // Add worklog first
        if (worklogItems.length > 0) {
          processed.push({
            id: `${exchangeId}-worklog`,
            type: 'worklog',
            content: '',
            worklogItems
          });
        }

        // Then add final text
        if (finalText) {
          processed.push({
            id: `${exchangeId}-final`,
            type: 'assistant-text',
            content: finalText,
            originalMessage: lastMsg
          });
        }
      }

      // Note: Worklog for single message case is already handled above in the streaming branch
    } else if (msg.role === "system") {
      processed.push({
        id: `system-${i}`,
        type: 'system',
        content: extractMessageContent(msg.content),
        originalMessage: msg
      });
      i++;
    } else {
      i++;
    }
  }

  return processed;
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
              {!activeRepo && sessions.repos.length === 0 && (
                <p className="text-sm">Run `lychee up` in a repository to connect.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {processedMessages.map((msg) => {
                if (msg.type === "user") {
                  return (
                    <div key={msg.id} className="flex justify-end message-fade-in">
                      <div className="max-w-[75%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                }

                if (msg.type === "assistant-text") {
                  const isPending = msg.content.trim().length === 0 && isStreaming;
                  const hasStartedStreaming = msg.content.length > 0 && msg.content.length < 50;
                  return (
                    <div key={msg.id} className="flex justify-start">
                      <div className="w-full">
                        {isPending ? (
                          <div className="thinking-indicator flex items-center gap-2 text-muted-foreground">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-primary/70" />
                            <span className="animate-pulse">Claude is thinking...</span>
                          </div>
                        ) : (
                          <div className={hasStartedStreaming ? "message-fade-in" : ""}>
                            <MarkdownRenderer content={msg.content} className="text-sm leading-relaxed" />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                if (msg.type === "worklog" && msg.worklogItems) {
                  return (
                    <div key={msg.id} className="flex justify-start message-fade-in">
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
                    <div key={msg.id} className="flex justify-center message-fade-in">
                      <div className="max-w-[80%] rounded-2xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm leading-relaxed text-yellow-800 shadow-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                }

                return null;
              })}
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
