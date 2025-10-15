"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSessionsContext } from "@/components/AppShell";
import ChatComposer from "@/components/ChatComposer";
import MarkdownRenderer from "@/components/MarkdownRenderer";

function extractMessageContent(content: string | any[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text")
      .map((block) => block.text || "")
      .join("");
  }
  return "";
}

export default function Home() {
  const sessions = useSessionsContext();

  const activeRepo = sessions.repos.find((repo) => repo.path === sessions.activeRepoPath) || null;
  const isStreaming = sessions.currentSessionId
    ? sessions.activeStreams.has(sessions.currentSessionId)
    : false;

  const messageContainerRef = useRef<HTMLDivElement>(null);

  const messageItems = useMemo(
    () =>
      sessions.messages
        .map((message, index) => {
          const text = extractMessageContent(message.content);
          return {
            message,
            text,
            trimmed: text.trim(),
            index,
          };
        })
        .filter(({ message, trimmed }, idx, arr) => {
          if (trimmed.length > 0) {
            return true;
          }
          if (message.role === "assistant" && isStreaming && idx === arr.length - 1) {
            return true;
          }
          return false;
        }),
    [sessions.messages, isStreaming]
  );

  useEffect(() => {
    const el = messageContainerRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    const behavior = distanceFromBottom < 160 ? "smooth" : "auto";

    el.scrollTo({
      top: el.scrollHeight,
      behavior,
    });
  }, [sessions.messages, isStreaming]);

  return (
    <div className="relative flex h-full flex-col">
      <div ref={messageContainerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8 pb-40">
          {sessions.messages.length === 0 ? (
            <div className="mt-24 text-center text-muted-foreground">
              <p className="mb-2 text-lg">Select or create a branch to start chatting.</p>
              {!activeRepo && sessions.repos.length === 0 && (
                <p className="text-sm">Run `lychee up` in a repository to connect.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {messageItems.map(({ message, text }, index) => {
                if (message.role === "user") {
                  return (
                    <div key={`user-${index}`} className="flex justify-end">
                      <div className="max-w-[75%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm whitespace-pre-wrap">
                        {text}
                      </div>
                    </div>
                  );
                }

                if (message.role === "assistant") {
                  const isPending = text.trim().length === 0;
                  return (
                    <div key={`assistant-${index}`} className="flex justify-start">
                      <div className="w-full">
                        {isPending ? (
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-primary/70" />
                            <span className="animate-pulse">Claude is thinking...</span>
                          </div>
                        ) : (
                          <MarkdownRenderer content={text} className="text-sm leading-relaxed" />
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={`system-${index}`} className="flex justify-center">
                    <div className="max-w-[80%] rounded-2xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm leading-relaxed text-yellow-800 shadow-sm whitespace-pre-wrap">
                      {text}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex justify-center pb-1 bg-gradient-to-t from-background via-background to-transparent pt-8">
        <div className="pointer-events-auto w-full max-w-5xl px-6">
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
