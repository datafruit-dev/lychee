"use client";

import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ChatComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  selectedModel?: string;
  onModelChange?: (model: string) => void;
}

const CLAUDE_MODELS = [
  { value: "claude-sonnet-4-5-20250929", label: "Default (Sonnet 4.5)" },
  { value: "claude-opus-4-1-20250805", label: "Opus 4.1" },
  { value: "claude-sonnet-4-5-20250929 + context beta", label: "Sonnet 4.5 (1M context)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export default function ChatComposer({
  onSend,
  disabled = false,
  placeholder = "Message Claude...",
  selectedModel = "claude-sonnet-4-5-20250929",
  onModelChange,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setValue("");

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [value]);

  return (
    <div className="w-full flex justify-center pb-4">
      <div className="w-full max-w-4xl px-6">
        <InputGroup className="rounded-lg shadow-lg border border-border bg-background">
          <InputGroupTextarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="min-h-[52px] max-h-[200px] py-4 px-4 text-sm resize-none"
          />
          <InputGroupAddon align="block-end" className="border-t px-3 py-2">
            <div className="flex items-center justify-between w-full gap-2">
              <Select value={selectedModel} onValueChange={onModelChange}>
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {CLAUDE_MODELS.map((model) => (
                    <SelectItem key={model.value} value={model.value} className="text-xs">
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <InputGroupButton
                size="sm"
                variant="default"
                onClick={handleSubmit}
                disabled={disabled || !value.trim()}
                className="gap-1.5"
              >
                <Send className="size-3.5" />
                Send
              </InputGroupButton>
            </div>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}
