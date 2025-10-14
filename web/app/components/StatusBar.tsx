"use client";

import Image from "next/image";
import ShinyText from "./ShinyText";

interface StatusBarProps {
  status: string | null;
  isStreaming?: boolean;
}

export default function StatusBar({ status, isStreaming = false }: StatusBarProps) {
  const displayStatus = status || (isStreaming ? "Thinking..." : "Awaiting instructions");
  const isAnimating = !!(status || isStreaming);

  return (
    <div className="border-b border-gray-200 bg-gray-50/50 px-4 py-2 flex items-center gap-2 text-xs">
      <Image
        src="/logo.svg"
        alt="Logo"
        width={12}
        height={12}
        className={`flex-shrink-0 ${isAnimating ? 'animate-pulse' : ''}`}
      />
      <div className="truncate">
        {isAnimating ? (
          <ShinyText
            text={displayStatus}
            disabled={false}
            speed={3}
            className="font-medium"
          />
        ) : (
          <span className="text-gray-600 font-medium">
            {displayStatus}
          </span>
        )}
      </div>
    </div>
  );
}