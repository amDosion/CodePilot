import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand, quoteShellArg } from '@/lib/remote-ssh';
import { normalizeEngineType } from '@/lib/engine-defaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RemoteSkillInfo {
  name: string;
  description: string;
  content: string;
  source: 'global' | 'project';
  filePath: string;
  format?: 'markdown' | 'toml';
}

function getSkillsDirs(engine: string, cwd?: string): { global: string; project?: string } {
  const resolved = normalizeEngineType(engine);
  if (resolved === 'codex') {
    return {
      global: '~/.codex/skills',
      project: cwd ? `${cwd}/.codex/skills` : undefined,
    };
  }
  if (resolved === 'gemini') {
    return {
      global: '~/.gemini/commands',
      project: cwd ? `${cwd}/.gemini/commands` : undefined,
    };
  }
  return {
    global: '~/.claude/commands',
    project: cwd ? `${cwd}/.claude/commands` : undefined,
  };
}

/**
 * POST /api/remote/skills
 * Manage skills/commands on a remote host.
 *
 * Body: { connection_id, engine_type?, action, cwd?, skill_name?, skill_content?, scope? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      engine_type?: string;
      action?: string;
      cwd?: string;
      skill_name?: string;
      skill_content?: string;
      scope?: 'global' | 'project';
    };

    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const engine = normalizeEngineType(body.engine_type);
    const action = (body.action || 'list').trim();
    const dirs = getSkillsDirs(engine, body.cwd);
    const isCodex = engine === 'codex';
    const isGemini = engine === 'gemini';

    if (action === 'list') {
      const skills: RemoteSkillInfo[] = [];

      if (isCodex) {
        // Codex: structured skills with SKILL.md
        skills.push(...await discoverStructuredSkills(connection, dirs.global, 'global'));
        if (dirs.project) {
          skills.push(...await discoverStructuredSkills(connection, dirs.project, 'project'));
        }
      } else if (isGemini) {
        // Gemini: .toml files
        skills.push(...await discoverGeminiCommands(connection, dirs.global, 'global'));
        if (dirs.project) {
          skills.push(...await discoverGeminiCommands(connection, dirs.project, 'project'));
        }
      } else {
        // Claude: .md files
        skills.push(...await discoverMarkdownSkills(connection, dirs.global, 'global'));
        if (dirs.project) {
          skills.push(...await discoverMarkdownSkills(connection, dirs.project, 'project'));
        }
      }

      return NextResponse.json({ skills });
    }

    if (action === 'read') {
      const { skill_name } = body;
      if (!skill_name) {
        return NextResponse.json({ error: 'skill_name is required' }, { status: 400 });
      }
      const scope = body.scope || 'global';
      const dir = scope === 'project' && dirs.project ? dirs.project : dirs.global;
      const filePath = resolveSkillPath(engine, dir, skill_name);

      const result = await runRemoteCommand(
        connection,
        `cat ${quoteShellArg(filePath)} 2>/dev/null`,
        { timeoutMs: 10000 },
      );
      return NextResponse.json({ content: result.stdout, filePath });
    }

    if (action === 'install') {
      const { skill_name, skill_content } = body;
      if (!skill_name || skill_content === undefined) {
        return NextResponse.json({ error: 'skill_name and skill_content are required' }, { status: 400 });
      }
      const scope = body.scope || 'global';
      const dir = scope === 'project' && dirs.project ? dirs.project : dirs.global;
      const filePath = resolveSkillPath(engine, dir, skill_name);
      const dirPath = filePath.replace(/\/[^/]+$/, '');

      await runRemoteCommand(
        connection,
        `mkdir -p ${quoteShellArg(dirPath)} && cat > ${quoteShellArg(filePath)} << 'CODEPILOT_EOF'\n${skill_content}\nCODEPILOT_EOF`,
        { timeoutMs: 10000 },
      );

      return NextResponse.json({ success: true }, { status: 201 });
    }

    if (action === 'uninstall') {
      const { skill_name } = body;
      if (!skill_name) {
        return NextResponse.json({ error: 'skill_name is required' }, { status: 400 });
      }
      const scope = body.scope || 'global';
      const dir = scope === 'project' && dirs.project ? dirs.project : dirs.global;
      const filePath = resolveSkillPath(engine, dir, skill_name);

      await runRemoteCommand(
        connection,
        `rm -f ${quoteShellArg(filePath)}`,
        { timeoutMs: 10000 },
      );

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to manage remote skills';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function resolveSkillPath(engine: string, dir: string, name: string): string {
  const resolved = normalizeEngineType(engine);
  if (resolved === 'codex') {
    return `${dir}/${name}/SKILL.md`;
  }
  if (resolved === 'gemini') {
    // Gemini commands can have ":" separator → subdirectories
    const parts = name.split(':');
    return `${dir}/${parts.join('/')}.toml`;
  }
  // Claude: support ":" in name as subdirectory separator
  const parts = name.split(':');
  if (parts.length > 1) {
    return `${dir}/${parts.slice(0, -1).join('/')}/${parts[parts.length - 1]}.md`;
  }
  return `${dir}/${name}.md`;
}

async function discoverMarkdownSkills(
  connection: Parameters<typeof runRemoteCommand>[0],
  dir: string,
  source: 'global' | 'project',
): Promise<RemoteSkillInfo[]> {
  const script = `
[ -d ${quoteShellArg(dir)} ] || exit 0
find ${quoteShellArg(dir)} -name '*.md' -type f 2>/dev/null | head -100 | while IFS= read -r f; do
  relpath=$(echo "$f" | sed "s|^${dir.replace(/[|\\&]/g, '\\$&')}/||")
  echo "===SK=== $relpath"
  head -5 "$f" 2>/dev/null
  echo "===SE==="
done
`.trim();

  const result = await runRemoteCommand(connection, script, { timeoutMs: 15000 });
  return parseMarkdownSkillsOutput(result.stdout, dir, source);
}

function parseMarkdownSkillsOutput(output: string, dir: string, source: 'global' | 'project'): RemoteSkillInfo[] {
  const skills: RemoteSkillInfo[] = [];
  const sections = output.split('===SK=== ');

  for (const section of sections) {
    if (!section.trim()) continue;
    const endIdx = section.indexOf('\n');
    if (endIdx < 0) continue;

    const relPath = section.slice(0, endIdx).trim();
    const seIdx = section.indexOf('===SE===');
    const preview = seIdx > 0 ? section.slice(endIdx + 1, seIdx).trim() : '';

    // Convert path to name: remove .md extension, replace / with :
    const name = relPath.replace(/\.md$/, '').replace(/\//g, ':');
    const firstLine = preview.split('\n')[0] || '';
    const description = firstLine.startsWith('#')
      ? firstLine.replace(/^#+\s*/, '')
      : firstLine || `Skill: /${name}`;

    skills.push({
      name,
      description,
      content: preview,
      source,
      filePath: `${dir}/${relPath}`,
    });
  }
  return skills;
}

async function discoverStructuredSkills(
  connection: Parameters<typeof runRemoteCommand>[0],
  dir: string,
  source: 'global' | 'project',
): Promise<RemoteSkillInfo[]> {
  const script = `
[ -d ${quoteShellArg(dir)} ] || exit 0
find ${quoteShellArg(dir)} -name 'SKILL.md' -type f 2>/dev/null | head -100 | while IFS= read -r f; do
  skill_dir=$(dirname "$f")
  skill_name=$(basename "$skill_dir")
  echo "===SK=== $skill_name"
  head -10 "$f" 2>/dev/null
  echo "===SE==="
done
`.trim();

  const result = await runRemoteCommand(connection, script, { timeoutMs: 15000 });
  const skills: RemoteSkillInfo[] = [];
  const sections = result.stdout.split('===SK=== ');

  for (const section of sections) {
    if (!section.trim()) continue;
    const endIdx = section.indexOf('\n');
    if (endIdx < 0) continue;

    const skillName = section.slice(0, endIdx).trim();
    const seIdx = section.indexOf('===SE===');
    const preview = seIdx > 0 ? section.slice(endIdx + 1, seIdx).trim() : '';

    // Parse front matter for description
    let description = `Skill: /${skillName}`;
    const descMatch = preview.match(/description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();

    skills.push({
      name: skillName,
      description,
      content: preview,
      source,
      filePath: `${dir}/${skillName}/SKILL.md`,
    });
  }
  return skills;
}

async function discoverGeminiCommands(
  connection: Parameters<typeof runRemoteCommand>[0],
  dir: string,
  source: 'global' | 'project',
): Promise<RemoteSkillInfo[]> {
  const script = `
[ -d ${quoteShellArg(dir)} ] || exit 0
find ${quoteShellArg(dir)} -name '*.toml' -type f 2>/dev/null | head -100 | while IFS= read -r f; do
  relpath=$(echo "$f" | sed "s|^${dir.replace(/[|\\&]/g, '\\$&')}/||")
  echo "===SK=== $relpath"
  head -10 "$f" 2>/dev/null
  echo "===SE==="
done
`.trim();

  const result = await runRemoteCommand(connection, script, { timeoutMs: 15000 });
  const skills: RemoteSkillInfo[] = [];
  const sections = result.stdout.split('===SK=== ');

  for (const section of sections) {
    if (!section.trim()) continue;
    const endIdx = section.indexOf('\n');
    if (endIdx < 0) continue;

    const relPath = section.slice(0, endIdx).trim();
    const seIdx = section.indexOf('===SE===');
    const preview = seIdx > 0 ? section.slice(endIdx + 1, seIdx).trim() : '';

    const name = relPath.replace(/\.toml$/, '').replace(/\//g, ':');
    const descMatch = preview.match(/description\s*=\s*"([^"]+)"/);
    const description = descMatch ? descMatch[1] : `Command: /${name}`;

    skills.push({
      name,
      description,
      content: preview,
      source,
      filePath: `${dir}/${relPath}`,
      format: 'toml',
    });
  }
  return skills;
}
