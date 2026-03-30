import type {
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  RewindFilesResult,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

export type ConversationPermissionMode = PermissionMode;

export interface ConversationHandle {
  setPermissionMode(mode: ConversationPermissionMode): Promise<void>;
  setModel?(model?: string): Promise<void>;
  supportedCommands?(): Promise<SlashCommand[]>;
  supportedModels?(): Promise<ModelInfo[]>;
  mcpServerStatus?(): Promise<McpServerStatus[]>;
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  initializationResult?(): Promise<unknown>;
}

const globalKey = '__activeConversations__' as const;

function getMap(): Map<string, ConversationHandle> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, ConversationHandle>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, ConversationHandle>;
}

export function registerConversation(sessionId: string, conversation: ConversationHandle): void {
  getMap().set(sessionId, conversation);
}

export function unregisterConversation(sessionId: string): void {
  getMap().delete(sessionId);
}

export function getConversation(sessionId: string): ConversationHandle | undefined {
  return getMap().get(sessionId);
}
