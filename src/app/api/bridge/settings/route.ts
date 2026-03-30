import { NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const BRIDGE_SETTING_KEYS = [
  'remote_bridge_enabled',
  'bridge_telegram_enabled',
  'telegram_bridge_allowed_users',
  'bridge_auto_start',
  'bridge_default_work_dir',
  'bridge_default_engine_type',
  'bridge_default_model',
  'bridge_default_provider_id',
  'bridge_default_reasoning_effort',
  'bridge_telegram_stream_enabled',
  'bridge_telegram_stream_interval_ms',
  'bridge_telegram_stream_min_delta_chars',
  'bridge_telegram_stream_max_chars',
  'bridge_telegram_stream_private_only',
  'bridge_feishu_enabled',
  'bridge_feishu_app_id',
  'bridge_feishu_app_secret',
  'bridge_feishu_domain',
  'bridge_feishu_allowed_users',
  'bridge_feishu_group_policy',
  'bridge_feishu_group_allow_from',
  'bridge_feishu_require_mention',
  'bridge_discord_enabled',
  'bridge_discord_bot_token',
  'bridge_discord_allowed_users',
  'bridge_discord_allowed_channels',
  'bridge_discord_allowed_guilds',
  'bridge_discord_group_policy',
  'bridge_discord_require_mention',
  'bridge_discord_stream_enabled',
  'bridge_discord_stream_interval_ms',
  'bridge_discord_stream_min_delta_chars',
  'bridge_discord_stream_max_chars',
  'bridge_discord_max_attachment_size',
  'bridge_discord_image_enabled',
] as const;

const SECRET_BRIDGE_KEYS = new Set<string>([
  'bridge_feishu_app_secret',
  'bridge_discord_bot_token',
]);

function maskBridgeValue(key: string, value: string): string {
  if (!SECRET_BRIDGE_KEYS.has(key) || value.length <= 8) {
    return value;
  }
  return '***' + value.slice(-8);
}

export async function GET() {
  try {
    const settings: Record<string, string> = {};
    for (const key of BRIDGE_SETTING_KEYS) {
      settings[key] = maskBridgeValue(key, getSetting(key) ?? '');
    }
    return NextResponse.json({ settings });
  } catch {
    return NextResponse.json(
      { error: 'Failed to read bridge settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { settings } = body;

    if (!settings || typeof settings !== 'object') {
      return NextResponse.json(
        { error: 'Invalid settings data' },
        { status: 400 },
      );
    }

    for (const [key, value] of Object.entries(settings)) {
      if (BRIDGE_SETTING_KEYS.includes(key as typeof BRIDGE_SETTING_KEYS[number])) {
        const strValue = String(value ?? '').trim();
        if (SECRET_BRIDGE_KEYS.has(key) && strValue.startsWith('***')) {
          continue;
        }
        setSetting(key, strValue);
      }
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Failed to save bridge settings' },
      { status: 500 },
    );
  }
}
