import { NextResponse } from 'next/server';
import { normalizeEngineType } from '@/lib/engine-defaults';
import { getCommandsForEngine } from '@/lib/command-registry';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const engineType = normalizeEngineType(searchParams.get('engine_type'));
  const commands = await getCommandsForEngine(engineType);
  return NextResponse.json({ commands });
}
