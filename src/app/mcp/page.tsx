"use client";

import { McpManager } from "@/components/plugins/McpManager";
import { usePanel } from "@/hooks/usePanel";

export default function McpPage() {
  const { workspaceMode, remoteConnectionId } = usePanel();

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden p-6 flex flex-col min-h-0">
        <McpManager workspaceMode={workspaceMode} remoteConnectionId={remoteConnectionId} />
      </div>
    </div>
  );
}
