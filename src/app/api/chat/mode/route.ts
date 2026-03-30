import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';
import type { ConversationPermissionMode } from '@/lib/conversation-registry';
import { getSession, updateSessionMode } from '@/lib/db';
import { createAgentEngine } from '@/lib/agent/engine-factory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, mode } = await request.json();

    if (!sessionId || !mode) {
      return NextResponse.json({ error: 'sessionId and mode are required' }, { status: 400 });
    }

    const session = getSession(sessionId);
    const engine = createAgentEngine({ session: session ?? null });
    if (!engine.capabilities.includes('permission_mode')) {
      return NextResponse.json({ applied: false });
    }

    const conversation = getConversation(sessionId);
    if (!conversation || typeof conversation.setPermissionMode !== 'function') {
      return NextResponse.json({ applied: false });
    }

    const normalizedMode = (mode || '').trim().toLowerCase();
    const permissionMode: ConversationPermissionMode = normalizedMode === 'code'
      ? 'acceptEdits'
      : normalizedMode === 'ask'
        ? 'default'
        : 'plan';
    await conversation.setPermissionMode(permissionMode);
    if (normalizedMode === 'code' || normalizedMode === 'plan' || normalizedMode === 'ask') {
      updateSessionMode(sessionId, normalizedMode);
    }

    return NextResponse.json({ applied: true });
  } catch (error) {
    console.error('[mode] Failed to switch mode:', error);
    return NextResponse.json({ applied: false });
  }
}
