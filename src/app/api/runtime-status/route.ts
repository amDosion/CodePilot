import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { findClaudeBinary, getClaudeVersion } from '@/lib/platform';
import { getGeminiCliVersion, resolveGeminiCliPath } from '@/lib/gemini-cli';

interface EngineStatus {
  available: boolean;
  ready: boolean;
  version: string | null;
  detail: string;
}

type GeminiSettings = {
  security?: {
    auth?: {
      selectedType?: unknown;
    };
  };
  auth?: {
    selectedType?: unknown;
  };
};

async function getCodexSdkVersion(): Promise<string | null> {
  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const version =
      pkg.dependencies?.['@openai/codex-sdk']
      || pkg.devDependencies?.['@openai/codex-sdk']
      || null;
    return version ? version.replace(/^[~^]/, '') : null;
  } catch {
    return null;
  }
}

async function getGeminiSettingsAuthType(): Promise<string | null> {
  try {
    const filePath = path.join(process.env.HOME || process.cwd(), '.gemini', 'settings.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as GeminiSettings;
    const nested = parsed.security?.auth?.selectedType;
    const direct = parsed.auth?.selectedType;
    const value = typeof nested === 'string'
      ? nested
      : (typeof direct === 'string' ? direct : null);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function hasGeminiEnvAuth(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.GOOGLE_GENAI_USE_VERTEXAI
    || process.env.GOOGLE_GENAI_USE_GCA
  );
}

export async function GET() {
  try {
    const claudePath = findClaudeBinary();
    const claudeVersion = claudePath ? await getClaudeVersion(claudePath) : null;
    const claudeReady = !!claudeVersion;

    const codexVersion = await getCodexSdkVersion();
    const codexInstalled = !!codexVersion;
    // Codex SDK can run with ChatGPT login (`codex login`) and does not require
    // OPENAI_API_KEY to be considered ready.
    const codexReady = codexInstalled;

    const geminiInstalled = !!resolveGeminiCliPath();
    const geminiVersion = geminiInstalled ? await getGeminiCliVersion() : null;
    const geminiAuthType = await getGeminiSettingsAuthType();
    const geminiReady = geminiInstalled && (hasGeminiEnvAuth() || !!geminiAuthType);

    const claude: EngineStatus = {
      available: claudeReady,
      ready: claudeReady,
      version: claudeVersion,
      detail: claudeReady ? 'Claude CLI detected.' : 'Claude CLI not detected.',
    };

    const codex: EngineStatus = {
      available: codexInstalled,
      ready: codexReady,
      version: codexVersion,
      detail: !codexInstalled
        ? 'Codex SDK is not installed.'
        : 'Codex SDK is available. Use `codex login` (ChatGPT) or API key credentials.',
    };

    const gemini: EngineStatus = {
      available: geminiInstalled,
      ready: geminiReady,
      version: geminiVersion,
      detail: !geminiInstalled
        ? 'Gemini CLI is not installed.'
        : geminiReady
          ? `Gemini CLI is available${geminiAuthType ? ` (${geminiAuthType})` : ''}.`
          : 'Gemini CLI is installed but authentication is not configured. Run `gemini` once or set GEMINI_API_KEY / security.auth.selectedType.',
    };

    return NextResponse.json({
      connected: claude.ready || codex.ready || gemini.ready,
      engines: { claude, codex, gemini },
    });
  } catch {
    return NextResponse.json({
      connected: false,
      engines: {
        claude: {
          available: false,
          ready: false,
          version: null,
          detail: 'Failed to detect Claude runtime.',
        },
        codex: {
          available: false,
          ready: false,
          version: null,
          detail: 'Failed to detect Codex runtime.',
        },
        gemini: {
          available: false,
          ready: false,
          version: null,
          detail: 'Failed to detect Gemini runtime.',
        },
      },
    });
  }
}
