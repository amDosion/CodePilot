'use client';

import { useRef, useState, useCallback, useEffect, useMemo, type KeyboardEvent, type FormEvent } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AtIcon,
  HelpCircleIcon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  CommandLineIcon,
  PlusSignIcon,
  Cancel01Icon,
  Delete02Icon,
  Coins01Icon,
  FileZipIcon,
  Stethoscope02Icon,
  FileEditIcon,
  SearchList01Icon,
  BrainIcon,
  GlobalIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputApprovalPolicy,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';
import type { FileAttachment, ProviderModelGroup } from '@/types';
import { nanoid } from 'nanoid';
import { ImageGenToggle } from './ImageGenToggle';
import { useImageGen } from '@/hooks/useImageGen';
import { PENDING_KEY, setRefImages, deleteRefImages } from '@/lib/image-ref-store';
import {
  normalizeReasoningEffort,
} from '@/lib/engine-defaults';

const FALLBACK_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

// Display labels for reasoning effort values (API value -> human-readable)
const EFFORT_DISPLAY_LABELS: Record<string, string> = {
  'minimal': 'Minimal',
  'low': 'Low',
  'medium': 'Medium',
  'high': 'High',
  'xhigh': 'Extra High',
  'max': 'Max',
};
function getEffortLabel(effort: string): string {
  return EFFORT_DISPLAY_LABELS[effort] || effort;
}
const FALLBACK_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'];
import { DEFAULT_CODEX_MODEL_OPTIONS } from '@/lib/codex-model-options';
import {
  DEFAULT_GEMINI_MODEL_OPTIONS,
  getGeminiManualMenuLabel,
  getGeminiManualModelOptions,
  isGeminiAutoModel,
} from '@/lib/gemini-model-options';
import { DEFAULT_CLAUDE_MODELS } from '@/lib/claude-model-catalog';
import {
  type RuntimeCommandMetadata,
  findRuntimeCommand,
  getRuntimeCommandDescriptionKey,
} from '@/lib/runtime-command-catalog';
import { useDefaultModel, useDefaultReasoningEffort } from '@/hooks/useCliDefaults';

const IMAGE_AGENT_SYSTEM_PROMPT = `你是一个图像生成助手。当用户请求生成图片时，分析用户意图并以结构化格式输出。

## 单张生成
如果用户只需要生成一张图片，输出：
\`\`\`image-gen-request
{"prompt":"详细的英文描述","aspectRatio":"1:1","resolution":"1K"}
\`\`\`

## 批量生成
如果用户提供了文档/列表/多个需求，需要批量生成多张图片，输出：
\`\`\`batch-plan
{"summary":"计划摘要","items":[{"prompt":"英文描述","aspectRatio":"1:1","resolution":"1K","tags":[]}]}
\`\`\`

## 参考图（垫图）
如果用户上传了图片，这些图片会自动作为参考图传给图片生成模型。你在 prompt 中应该描述如何利用这些参考图，例如：
- 基于参考图的风格/内容进行创作
- 将参考图中的元素融入新图
- 按照参考图的构图生成新图

## 连续编辑（基于上一次生成结果）
如果用户要求修改/编辑/调整之前生成的图片，在 JSON 中加入 "useLastGenerated": true，系统会自动将上次生成的结果图作为参考图传入。
编辑模式下 prompt 要简洁直接，只描述要做的修改，不要重复描述整张图片的内容。例如：
- 用户说"去掉右边的香水" → prompt: "Remove the perfume bottle on the right side of the image"
- 用户说"把背景换成蓝色" → prompt: "Change the background color to blue"
- 用户说"加个太阳" → prompt: "Add a sun in the sky"

\`\`\`image-gen-request
{"prompt":"简洁的英文编辑指令","aspectRatio":"1:1","resolution":"1K","useLastGenerated":true}
\`\`\`

## 规则
- 新图生成时 prompt 必须是详细的英文描述
- 编辑已有图片时 prompt 应该简洁直接，只描述修改内容
- aspectRatio 可选: 1:1, 16:9, 9:16, 3:2, 2:3, 4:3, 3:4
- resolution 可选: 1K, 2K, 4K
- 批量生成时每个 item 都需要独立的详细 prompt
- 如果用户没有特别要求比例和分辨率，使用 1:1 和 1K 作为默认值
- 如果用户上传了参考图，prompt 中要明确说明如何使用这些参考图
- 如果用户要求修改上一张生成的图片，必须加 "useLastGenerated": true
- 在输出结构化块之前，可以先简要说明你的理解和计划`;


interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string) => void;
  onCommand?: (command: string) => void | Promise<void>;
  onUnknownCommand?: (command: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  providerId?: string;
  onProviderModelChange?: (providerId: string, model: string) => void;
  engineType?: string;
  onEngineChange?: (engineType: string) => void;
  reasoningEffort?: string;
  onReasoningEffortChange?: (effort: string) => void;
  workingDirectory?: string;
  mode?: string;
  onModeChange?: (mode: string) => void;
  approvalPolicy?: string;
  onApprovalPolicyChange?: (policy: string) => void;
  runtimeCommands?: RuntimeCommandMetadata[];
  nativeCommandNames?: string[];
}

interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  descriptionKey?: TranslationKey;
  aliases?: string[];
  builtIn?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  statusKey?: TranslationKey;
  immediate?: boolean;
  installedSource?: "agents" | "claude";
  source?: "global" | "project" | "plugin" | "installed";
  icon?: typeof CommandLineIcon;
  /** Argument placeholder hint, e.g. "<model-id>". */
  argsHint?: string;
}

interface CommandBadge {
  command: string;
  label: string;
  description: string;
  isSkill: boolean;
  installedSource?: "agents" | "claude";
}

type PopoverMode = 'file' | 'skill' | null;
type ProviderModelOption = ProviderModelGroup['models'][number];

interface ModeOption {
  value: string;
  label: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code' },
  { value: 'plan', label: 'Plan' },
];

const CLAUDE_APPROVAL_OPTIONS = [
  { value: 'ask', label: 'Ask' },
  { value: 'code', label: 'Auto Edit' },
  { value: 'plan', label: 'Plan' },
];

// Gemini CLI --approval-mode: default, auto_edit, yolo, plan
// Mapped to internal session modes: ask→default, code→auto_edit, yolo→yolo, plan→plan
const GEMINI_APPROVAL_OPTIONS = [
  { value: 'ask', label: 'Ask' },
  { value: 'code', label: 'Auto Edit' },
  { value: 'yolo', label: 'YOLO' },
  { value: 'plan', label: 'Plan' },
];

const DEFAULT_CLAUDE_MODEL_OPTIONS = DEFAULT_CLAUDE_MODELS;

function getCommandIcon(commandName: string): typeof CommandLineIcon {
  if (commandName === 'help') return HelpCircleIcon;
  if (commandName === 'clear') return Delete02Icon;
  if (commandName === 'cost' || commandName === 'stats' || commandName === 'status') return Coins01Icon;
  if (commandName === 'compact' || commandName === 'compress') return FileZipIcon;
  if (commandName === 'doctor') return Stethoscope02Icon;
  if (commandName === 'init') return FileEditIcon;
  if (commandName === 'review') return SearchList01Icon;
  if (commandName === 'memory') return BrainIcon;
  if (commandName === 'terminal-setup') return CommandLineIcon;
  return CommandLineIcon;
}

function buildRuntimeCommandItems(
  engineType: string,
  runtimeCommands: RuntimeCommandMetadata[],
  nativeCommandNames: string[],
): PopoverItem[] {
  const nativeCommandNameSet = new Set(nativeCommandNames);
  return runtimeCommands.map((command) => ({
    // Native-managed commands should stay selectable even if metadata still says CLI-only.
    // This lets frontend route to the backend native controller API first.
    ...(() => {
      const isNativeManaged = nativeCommandNameSet.has(command.name);
      const isCliOnly = command.availability === 'cli-only' && !isNativeManaged;
      return {
        disabled: isCliOnly,
        statusKey: isCliOnly
          ? 'messageInput.cliOnlyTag'
          : command.source === 'codepilot'
            ? 'messageInput.codepilotTag'
            : undefined,
      };
    })(),
    label: command.name,
    value: `/${command.name}`,
    description: command.description,
    descriptionKey: getRuntimeCommandDescriptionKey(engineType, command.name) || undefined,
    aliases: command.aliases,
    builtIn: true,
    immediate: command.execution === 'immediate' || command.execution === 'terminal' || command.execution === 'cli-only',
    icon: getCommandIcon(command.name),
    argsHint: command.argsHint,
  }));
}

function getFallbackGroups(engineType: string): ProviderModelGroup[] {
  if (engineType === 'codex') {
    return [{
      provider_id: 'env',
      provider_name: 'Codex CLI',
      provider_type: 'codex',
      models: DEFAULT_CODEX_MODEL_OPTIONS,
    }];
  }
  if (engineType === 'gemini') {
    return [{
      provider_id: 'env',
      provider_name: 'Gemini CLI',
      provider_type: 'gemini',
      models: DEFAULT_GEMINI_MODEL_OPTIONS,
    }];
  }
  return [{
    provider_id: 'env',
    provider_name: 'Claude Code',
    provider_type: 'anthropic',
    models: DEFAULT_CLAUDE_MODEL_OPTIONS,
  }];
}

function ensureModelOption(
  models: ProviderModelOption[],
  preferredModel?: string | null,
): ProviderModelOption[] {
  const normalizedPreferred = (preferredModel || '').trim();
  if (!normalizedPreferred) {
    return models;
  }

  if (models.some((model) => model.value === normalizedPreferred)) {
    return models;
  }

  return [{ value: normalizedPreferred, label: normalizedPreferred }, ...models];
}

/**
 * Convert a data URL to a FileAttachment object.
 */
async function dataUrlToFileAttachment(
  dataUrl: string,
  filename: string,
  mediaType: string,
): Promise<FileAttachment> {
  // data:image/png;base64,<data>  — extract the base64 part
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

  // Estimate raw size from base64 length
  const size = Math.ceil((base64.length * 3) / 4);

  return {
    id: nanoid(),
    name: filename,
    type: mediaType || 'application/octet-stream',
    size,
    data: base64,
  };
}

/**
 * Submit button that's aware of file attachments. Must be rendered inside PromptInput.
 */
function FileAwareSubmitButton({
  status,
  onStop,
  disabled,
  inputValue,
  hasBadge,
}: {
  status: ChatStatus;
  onStop?: () => void;
  disabled?: boolean;
  inputValue: string;
  hasBadge: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const hasFiles = attachments.files.length > 0;
  const isStreaming = status === 'streaming' || status === 'submitted';

  return (
    <PromptInputSubmit
      status={status}
      onStop={onStop}
      disabled={disabled || (!isStreaming && !inputValue.trim() && !hasBadge && !hasFiles)}
      className="rounded-full"
    >
      {isStreaming ? (
        <HugeiconsIcon icon={StopIcon} className="size-4" />
      ) : (
        <HugeiconsIcon icon={ArrowUp02Icon} className="h-4 w-4" strokeWidth={2} />
      )}
    </PromptInputSubmit>
  );
}

/**
 * Attachment button that opens the file dialog. Must be rendered inside PromptInput.
 */
function AttachFileButton() {
  const attachments = usePromptInputAttachments();
  const { t } = useTranslation();

  return (
    <PromptInputButton
      onClick={() => attachments.openFileDialog()}
      tooltip={t('messageInput.attachFiles')}
    >
      <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
    </PromptInputButton>
  );
}

/**
 * Infer a MIME type from a filename extension so that files added from the
 * file tree pass the PromptInput accept-type validation.  Code / text files
 * are mapped to `text/*` subtypes; images and PDFs get their standard types.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
function mimeFromFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const TEXT_EXTS: Record<string, string> = {
    md: 'text/markdown', mdx: 'text/markdown',
    txt: 'text/plain', csv: 'text/csv',
    json: 'application/json',
    ts: 'text/typescript', tsx: 'text/typescript',
    js: 'text/javascript', jsx: 'text/javascript',
    py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust',
    rb: 'text/x-ruby', java: 'text/x-java', c: 'text/x-c',
    cpp: 'text/x-c++', h: 'text/x-c', hpp: 'text/x-c++',
    cs: 'text/x-csharp', swift: 'text/x-swift', kt: 'text/x-kotlin',
    html: 'text/html', css: 'text/css', scss: 'text/css',
    xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml',
    toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
    sh: 'text/x-shellscript', bash: 'text/x-shellscript', zsh: 'text/x-shellscript',
    sql: 'text/x-sql', graphql: 'text/plain', gql: 'text/plain',
    vue: 'text/plain', svelte: 'text/plain', astro: 'text/plain',
    env: 'text/plain', gitignore: 'text/plain', dockerignore: 'text/plain',
    dockerfile: 'text/plain', makefile: 'text/plain',
    log: 'text/plain', lock: 'text/plain',
  };
  const IMAGE_EXTS: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  };
  if (TEXT_EXTS[ext]) return TEXT_EXTS[ext];
  if (IMAGE_EXTS[ext]) return IMAGE_EXTS[ext];
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * Bridge component that listens for 'attach-file-to-chat' custom events
 * from the file tree and adds files as attachments. Must be rendered inside PromptInput.
 */
function FileTreeAttachmentBridge({
  sessionId,
  workingDirectory,
}: {
  sessionId?: string | null;
  workingDirectory?: string;
}) {
  const attachments = usePromptInputAttachments();
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string }>;
      const filePath = customEvent.detail?.path;
      if (!filePath) return;

      try {
        const params = new URLSearchParams({ path: filePath });
        if (sessionId) {
          params.set('session_id', sessionId);
        } else if (workingDirectory) {
          params.set('baseDir', workingDirectory);
        }
        const res = await fetch(`/api/files/raw?${params.toString()}`);
        if (!res.ok) {
          console.warn(`[FileTreeAttachment] Failed to fetch file: ${res.status} ${res.statusText}`, filePath);
          return;
        }
        const blob = await res.blob();
        // Handle both Unix (/) and Windows (\) path separators
        const filename = filePath.split(/[/\\]/).pop() || 'file';
        // Use a proper MIME type derived from the extension so the file
        // passes PromptInput's accept-type validation (text/* etc.)
        const mime = mimeFromFilename(filename);
        const file = new File([blob], filename, { type: mime });
        attachmentsRef.current.add([file]);
      } catch (err) {
        console.warn('[FileTreeAttachment] Error attaching file:', filePath, err);
      }
    };

    window.addEventListener('attach-file-to-chat', handler);
    return () => window.removeEventListener('attach-file-to-chat', handler);
  }, [sessionId, workingDirectory]);

  return null;
}

/**
 * Capsule display for attached files, rendered inside PromptInput context.
 */
function FileAttachmentsCapsules() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 px-3 pt-2 pb-0 order-first">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith('image/');
        return (
          <span
            key={file.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 pl-2 pr-1 py-0.5 text-xs font-medium border border-emerald-500/20"
          >
            {isImage && file.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={file.url}
                alt={file.filename || 'image'}
                className="h-5 w-5 rounded object-cover"
              />
            )}
            <span className="max-w-[120px] truncate text-[11px]">
              {file.filename || 'file'}
            </span>
            <button
              type="button"
              onClick={() => attachments.remove(file.id)}
              className="ml-0.5 rounded-full p-0.5 hover:bg-emerald-500/20 transition-colors"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function MessageInput({
  onSend,
  onCommand,
  onUnknownCommand,
  onStop,
  disabled,
  isStreaming,
  sessionId,
  modelName,
  onModelChange,
  providerId,
  onProviderModelChange,
  engineType = 'claude',
  onEngineChange,
  reasoningEffort,
  onReasoningEffortChange,
  workingDirectory,
  mode = 'code',
  onModeChange,
  approvalPolicy = 'suggest',
  onApprovalPolicyChange: _onApprovalPolicyChange,
  runtimeCommands = [],
  nativeCommandNames = [],
}: MessageInputProps) {
  const { t } = useTranslation();
  const cliDefaultModel = useDefaultModel(engineType);
  const cliDefaultReasoning = useDefaultReasoningEffort(engineType);
  const imageGen = useImageGen();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const engineMenuRef = useRef<HTMLDivElement>(null);
  const reasoningMenuRef = useRef<HTMLDivElement>(null);
  const providerFetchSeqRef = useRef(0);

  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [geminiModelMenuView, setGeminiModelMenuView] = useState<'main' | 'manual'>('main');
  const [inputValue, setInputValue] = useState('');
  const [badge, setBadge] = useState<CommandBadge | null>(null);
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string>('');
  const [aiSuggestions, setAiSuggestions] = useState<PopoverItem[]>([]);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const aiSearchAbortRef = useRef<AbortController | null>(null);
  const aiSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCodexEngine = engineType === 'codex';
  const isGeminiEngine = engineType === 'gemini';
  const builtInCommands = useMemo(
    () => buildRuntimeCommandItems(engineType, runtimeCommands, nativeCommandNames),
    [engineType, runtimeCommands, nativeCommandNames]
  );
  const promptCommands = useMemo(
    () => new Map(
      runtimeCommands
        .filter((command) => command.execution === 'prompt' && command.prompt)
        .map((command) => [`/${command.name}`, command.prompt as string])
    ),
    [runtimeCommands]
  );
  const fallbackGroups = useMemo(
    () => {
      const groups = getFallbackGroups(engineType);
      const fallbackProviderId = ((engineType === 'codex' || engineType === 'gemini') ? 'env' : '') || groups[0]?.provider_id || '';
      return groups.map((group) => (
        group.provider_id === fallbackProviderId
          ? { ...group, models: ensureModelOption(group.models, modelName) }
          : group
      ));
    },
    [engineType, modelName]
  );
  const engineOptions = useMemo(
    () => [
      { value: 'claude', label: t('cli.engineClaude'), menuLabel: t('chatList.providerClaude') },
      { value: 'codex', label: t('cli.engineCodex'), menuLabel: t('chatList.providerCodex') },
      { value: 'gemini', label: t('cli.engineGemini'), menuLabel: t('chatList.providerGemini') },
    ],
    [t]
  );

  // Fetch provider groups from API
  const fetchProviderModels = useCallback(async () => {
    const requestSeq = ++providerFetchSeqRef.current;
    setProviderGroups(fallbackGroups);
    setDefaultProviderId((engineType === 'codex' || engineType === 'gemini') ? 'env' : '');

    const params = new URLSearchParams({ engine_type: engineType });
    if (workingDirectory) {
      params.set('cwd', workingDirectory);
    }
    try {
      const response = await fetch(`/api/providers/models?${params.toString()}`);
      const data = await response.json().catch(() => ({}));
      if (providerFetchSeqRef.current !== requestSeq) return;

      if (data.groups && data.groups.length > 0) {
        setProviderGroups(data.groups);
      } else {
        setProviderGroups(fallbackGroups);
      }
      setDefaultProviderId(data.default_provider_id || ((engineType === 'codex' || engineType === 'gemini') ? 'env' : ''));
    } catch {
      if (providerFetchSeqRef.current !== requestSeq) return;
      setProviderGroups(fallbackGroups);
      setDefaultProviderId((engineType === 'codex' || engineType === 'gemini') ? 'env' : '');
    }
  }, [engineType, fallbackGroups, workingDirectory]);

  // Load models on mount and listen for provider changes
  useEffect(() => {
    void fetchProviderModels();
    const handler = () => {
      void fetchProviderModels();
    };
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchProviderModels]);

  useEffect(() => {
    setProviderGroups(fallbackGroups);
    setDefaultProviderId((engineType === 'codex' || engineType === 'gemini') ? 'env' : '');
    setModelMenuOpen(false);
    setGeminiModelMenuView('main');
    setEngineMenuOpen(false);
    setReasoningMenuOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineType]);

  // Derive flat model list for current provider (used by currentModelOption lookup)
  const currentProviderIdValue = providerId || defaultProviderId || (providerGroups[0]?.provider_id ?? '');
  const currentGroup = providerGroups.find(g => g.provider_id === currentProviderIdValue) || providerGroups[0];
  const MODEL_OPTIONS = ensureModelOption(
    currentGroup?.models
    || (isCodexEngine
      ? DEFAULT_CODEX_MODEL_OPTIONS
      : isGeminiEngine
        ? DEFAULT_GEMINI_MODEL_OPTIONS
        : DEFAULT_CLAUDE_MODEL_OPTIONS),
    modelName
  );
  const GEMINI_MANUAL_OPTIONS = useMemo(
    () => getGeminiManualModelOptions(MODEL_OPTIONS, modelName),
    [MODEL_OPTIONS, modelName]
  );
  const currentEngineLabel = engineOptions.find((option) => option.value === engineType)?.label
    || (isCodexEngine ? 'Codex' : isGeminiEngine ? 'Gemini' : 'Claude');

  // Keep model/provider aligned with selected engine. If current selection is invalid
  // after engine switch, auto-pick the first valid option for that engine.
  useEffect(() => {
    if (providerGroups.length === 0) return;
    const preferredProviderId = providerId || defaultProviderId || providerGroups[0].provider_id;
    const resolvedGroup = providerGroups.find((g) => g.provider_id === preferredProviderId) || providerGroups[0];
    if (!resolvedGroup || resolvedGroup.models.length === 0) return;

    const validModels = isGeminiEngine
      ? ensureModelOption(resolvedGroup.models, modelName)
      : resolvedGroup.models;
    const hasCurrentModel = !!modelName && validModels.some((m) => m.value === modelName);
    const nextModel = hasCurrentModel
      ? modelName!
      : validModels[0].value;
    const nextProviderId = resolvedGroup.provider_id;

    if (providerId === nextProviderId && modelName === nextModel) return;

    if (onProviderModelChange) {
      onProviderModelChange(nextProviderId, nextModel);
    } else if (onModelChange) {
      onModelChange(nextModel);
    }
  }, [
    providerGroups,
    providerId,
    defaultProviderId,
    isGeminiEngine,
    modelName,
    onModelChange,
    onProviderModelChange,
  ]);

  // Fetch files for @ mention
  const fetchFiles = useCallback(async (filter: string) => {
    try {
      if (!sessionId && !workingDirectory) return [];
      const params = new URLSearchParams();
      if (sessionId) {
        params.set('session_id', sessionId);
      } else if (workingDirectory) {
        params.set('dir', workingDirectory);
        params.set('baseDir', workingDirectory);
      }
      if (filter) params.set('q', filter);
      const res = await fetch(`/api/files?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      const tree = data.tree || [];
      const items: PopoverItem[] = [];
      function flattenTree(nodes: Array<{ name: string; path: string; type: string; children?: unknown[] }>) {
        for (const node of nodes) {
          items.push({ label: node.name, value: node.path });
          if (node.children) flattenTree(node.children as typeof nodes);
        }
      }
      flattenTree(tree);
      return items.slice(0, 20);
    } catch {
      return [];
    }
  }, [sessionId, workingDirectory]);

  // Fetch skills for / command (built-in + API)
  // Returns all items unfiltered — filtering is done by filteredItems
  const fetchSkills = useCallback(async () => {
    let apiSkills: PopoverItem[] = [];
    try {
      const params = new URLSearchParams();
      params.set('engine_type', engineType);
      if (workingDirectory) {
        params.set('cwd', workingDirectory);
      }
      const qs = params.toString();
      const res = await fetch(`/api/skills${qs ? `?${qs}` : ''}`);
      if (res.ok) {
        const data = await res.json();
        const skills = data.skills || [];
        apiSkills = skills
          .map((s: { name: string; description: string; source?: "global" | "project" | "plugin" | "installed"; installedSource?: "agents" | "claude" }) => ({
            label: s.name,
            value: `/${s.name}`,
            description: s.description || "",
            builtIn: false,
            installedSource: s.installedSource,
            source: s.source,
          }));
      }
    } catch {
      // API not available - just use built-in commands
    }

    // Deduplicate: remove API skills that share a name with built-in commands
    const builtInNames = new Set(builtInCommands.map(c => c.label));
    const uniqueSkills = apiSkills.filter(s => !builtInNames.has(s.label));

    return [...builtInCommands, ...uniqueSkills];
  }, [builtInCommands, engineType, workingDirectory]);

  // Close popover
  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
    // Clean up AI search state
    setAiSuggestions([]);
    setAiSearchLoading(false);
    if (aiSearchTimerRef.current) {
      clearTimeout(aiSearchTimerRef.current);
      aiSearchTimerRef.current = null;
    }
    if (aiSearchAbortRef.current) {
      aiSearchAbortRef.current.abort();
      aiSearchAbortRef.current = null;
    }
  }, []);

  // Remove active badge
  const removeBadge = useCallback(() => {
    setBadge(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  // Insert selected item
  const insertItem = useCallback((item: PopoverItem) => {
    if (triggerPos === null) return;
    if (item.disabled) return;

    // Immediate built-in commands: execute right away
    if (item.builtIn && item.immediate && onCommand) {
      setInputValue('');
      closePopover();
      void onCommand(item.value);
      return;
    }

    // Non-immediate commands (prompt-based built-ins and skills): show as badge
    if (popoverMode === 'skill') {
      setBadge({
        command: item.value,
        label: item.label,
        description: item.description || '',
        isSkill: !item.builtIn,
        installedSource: item.installedSource,
      });
      setInputValue('');
      closePopover();
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    // File mention: insert into text
    const currentVal = inputValue;
    const before = currentVal.slice(0, triggerPos);
    const cursorEnd = triggerPos + popoverFilter.length + 1;
    const after = currentVal.slice(cursorEnd);
    const insertText = `@${item.value} `;

    setInputValue(before + insertText + after);
    closePopover();

    // Refocus textarea
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [triggerPos, popoverMode, closePopover, onCommand, inputValue, popoverFilter]);

  // Handle input changes to detect @ and /
  const handleInputChange = useCallback(async (val: string) => {
    setInputValue(val);

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const beforeCursor = val.slice(0, cursorPos);

    // Check for @ trigger
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      const filter = atMatch[1];
      setPopoverMode('file');
      setPopoverFilter(filter);
      setTriggerPos(cursorPos - atMatch[0].length);
      setSelectedIndex(0);
      const items = await fetchFiles(filter);
      setPopoverItems(items);
      return;
    }

    // Check for / trigger (only at start of line or after space)
    const slashMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
    if (slashMatch) {
      const filter = slashMatch[2];
      setPopoverMode('skill');
      setPopoverFilter(filter);
      setTriggerPos(cursorPos - slashMatch[2].length - 1);
      setSelectedIndex(0);
      const items = await fetchSkills();
      setPopoverItems(items);
      return;
    }

    if (popoverMode) {
      closePopover();
    }
  }, [fetchFiles, fetchSkills, popoverMode, closePopover]);

  const handleSubmit = useCallback(async (msg: { text: string; files: Array<{ type: string; url: string; filename?: string; mediaType?: string }> }, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const content = inputValue.trim();

    closePopover();

    // Convert PromptInput FileUIParts (with data URLs) to FileAttachment[]
    const convertFiles = async (): Promise<FileAttachment[]> => {
      if (!msg.files || msg.files.length === 0) return [];

      const attachments: FileAttachment[] = [];
      for (const file of msg.files) {
        if (!file.url) continue;
        try {
          const attachment = await dataUrlToFileAttachment(
            file.url,
            file.filename || 'file',
            file.mediaType || 'application/octet-stream',
          );
          attachments.push(attachment);
        } catch {
          // Skip files that fail conversion
        }
      }
      return attachments;
    };

    // If Image Agent toggle is on and no badge, send via normal LLM with systemPromptAppend
    if (imageGen.state.enabled && !badge && !isStreaming) {
      const files = await convertFiles();
      if (!content && files.length === 0) return;

      // Store uploaded images as pending reference images for ImageGenConfirmation
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        setRefImages(PENDING_KEY, imageFiles.map(f => ({ mimeType: f.type, data: f.data })));
      } else {
        deleteRefImages(PENDING_KEY);
      }

      setInputValue('');
      if (onSend) {
        onSend(content, files.length > 0 ? files : undefined, IMAGE_AGENT_SYSTEM_PROMPT);
      }
      return;
    }

    // If badge is active, expand the command/skill and send
    if (badge && !isStreaming) {
      let expandedPrompt = '';

      if (badge.isSkill) {
        // Fetch skill content from API
        try {
          const detailParams = new URLSearchParams();
          detailParams.set("engine_type", engineType);
          if (badge.installedSource) detailParams.set("source", badge.installedSource);
          if (workingDirectory) detailParams.set("cwd", workingDirectory);
          const qs = detailParams.toString();
          const res = await fetch(
            `/api/skills/${encodeURIComponent(badge.label)}${qs ? `?${qs}` : ""}`
          );
          if (res.ok) {
            const data = await res.json();
            expandedPrompt = data.skill?.prompt || data.skill?.content || '';
          }
        } catch {
          // Fallback: use command name
        }
      } else {
        // Built-in prompt command expansion
        expandedPrompt = promptCommands.get(badge.command) || badge.command;
      }

      const finalPrompt = content
        ? `${expandedPrompt}\n\nUser context: ${content}`
        : expandedPrompt;

      const files = await convertFiles();
      setBadge(null);
      setInputValue('');
      onSend(finalPrompt, files.length > 0 ? files : undefined);
      return;
    }

    const files = await convertFiles();
    const hasFiles = files.length > 0;

    if ((!content && !hasFiles) || disabled || isStreaming) return;

    // Check if it's a direct slash command typed in the input
    if (content.startsWith('/') && !hasFiles) {
      const runtimeCommand = findRuntimeCommand(runtimeCommands, content);
      if (runtimeCommand) {
        const canonicalValue = `/${runtimeCommand.name}`;
        if ((runtimeCommand.execution === 'immediate' || runtimeCommand.execution === 'terminal' || runtimeCommand.execution === 'cli-only') && onCommand) {
          setInputValue('');
          void onCommand(content.trim());
          return;
        }

        setBadge({
          command: canonicalValue,
          label: runtimeCommand.name,
          description: runtimeCommand.description || '',
          isSkill: false,
        });
        setInputValue('');
        return;
      }

      // Not a built-in command — only treat it as a skill if it actually exists.
      const skillName = content.slice(1);
      if (skillName) {
        const items = await fetchSkills();
        const skillItem = items.find((item) => !item.builtIn && item.label === skillName);
        if (skillItem) {
          setBadge({
            command: content,
            label: skillName,
            description: skillItem.description || '',
            isSkill: true,
            installedSource: skillItem.installedSource,
          });
          setInputValue('');
          return;
        }

        if (onUnknownCommand) {
          setInputValue('');
          onUnknownCommand(content);
          return;
        }
      }
    }

    onSend(content || 'Please review the attached file(s).', hasFiles ? files : undefined);
    setInputValue('');
  }, [
    inputValue,
    onSend,
    onCommand,
    disabled,
    isStreaming,
    closePopover,
    badge,
    imageGen,
    runtimeCommands,
    promptCommands,
    engineType,
    workingDirectory,
    fetchSkills,
    onUnknownCommand,
  ]);

  const filteredItems = popoverItems.filter((item) => {
    if (item.hidden) return false;
    const q = popoverFilter.toLowerCase();
    return item.label.toLowerCase().includes(q)
      || (item.aliases || []).some((alias) => alias.toLowerCase().includes(q))
      || (item.description || '').toLowerCase().includes(q);
  });

  // Debounced AI semantic search when substring results are insufficient
  const nonBuiltInFilteredCount = filteredItems.filter(i => !i.builtIn).length;
  useEffect(() => {
    // Only trigger for skill mode with enough input and few substring matches
    if (popoverMode !== 'skill' || popoverFilter.length < 2 || nonBuiltInFilteredCount >= 2) {
      setAiSuggestions([]);
      setAiSearchLoading(false);
      if (aiSearchTimerRef.current) {
        clearTimeout(aiSearchTimerRef.current);
        aiSearchTimerRef.current = null;
      }
      if (aiSearchAbortRef.current) {
        aiSearchAbortRef.current.abort();
        aiSearchAbortRef.current = null;
      }
      return;
    }

    // Cancel previous timer and request
    if (aiSearchTimerRef.current) {
      clearTimeout(aiSearchTimerRef.current);
    }
    if (aiSearchAbortRef.current) {
      aiSearchAbortRef.current.abort();
    }

    setAiSearchLoading(true);

    aiSearchTimerRef.current = setTimeout(async () => {
      const abortController = new AbortController();
      aiSearchAbortRef.current = abortController;

      try {
        // Collect non-built-in skills for AI search
        const skillsPayload = popoverItems
          .filter(i => !i.builtIn)
          .map(i => ({ name: i.label, description: (i.description || '').slice(0, 100) }));

        if (skillsPayload.length === 0) {
          setAiSearchLoading(false);
          return;
        }

        const res = await fetch('/api/skills/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            query: popoverFilter,
            skills: skillsPayload,
            model: engineType === 'codex' ? 'haiku' : 'haiku',
          }),
        });

        if (abortController.signal.aborted) return;

        if (!res.ok) {
          setAiSuggestions([]);
          setAiSearchLoading(false);
          return;
        }

        const data = await res.json();
        const suggestions: string[] = data.suggestions || [];

        // Map suggested names back to PopoverItems, deduplicating against substring results
        const filteredNames = new Set(filteredItems.map(i => i.label));
        const aiItems = suggestions
          .filter(name => !filteredNames.has(name))
          .map(name => popoverItems.find(i => i.label === name))
          .filter((item): item is PopoverItem => !!item);

        setAiSuggestions(aiItems);
      } catch {
        // Silently fail — don't show AI suggestions on error
        if (!abortController.signal.aborted) {
          setAiSuggestions([]);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setAiSearchLoading(false);
        }
      }
    }, 500);

    return () => {
      if (aiSearchTimerRef.current) {
        clearTimeout(aiSearchTimerRef.current);
        aiSearchTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popoverFilter, popoverMode, nonBuiltInFilteredCount]);

  // Combined list for keyboard navigation — must match visual rendering order
  const allDisplayedItems = useMemo(() => {
    if (popoverMode === "file") {
      return filteredItems;
    }
    // Skill mode: reorder to match visual sections (builtIn -> project -> skill -> AI)
    const builtIn = filteredItems.filter(i => i.builtIn);
    const project = filteredItems.filter(i => !i.builtIn && i.source === "project");
    const skill = filteredItems.filter(i => !i.builtIn && i.source !== "project");
    return [...builtIn, ...project, ...skill, ...aiSuggestions];
  }, [filteredItems, aiSuggestions, popoverMode]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Popover navigation
      if (popoverMode && allDisplayedItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % allDisplayedItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + allDisplayedItems.length) % allDisplayedItems.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (allDisplayedItems[selectedIndex]) {
            insertItem(allDisplayedItems[selectedIndex]);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closePopover();
          return;
        }
      }

      // Backspace removes badge when input is empty
      if (e.key === 'Backspace' && badge && !inputValue) {
        e.preventDefault();
        removeBadge();
        return;
      }

      // Escape removes badge
      if (e.key === 'Escape' && badge) {
        e.preventDefault();
        removeBadge();
        return;
      }
    },
    [popoverMode, selectedIndex, insertItem, closePopover, badge, inputValue, removeBadge, allDisplayedItems]
  );

  // Click outside to close popover
  useEffect(() => {
    if (!popoverMode) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverMode, closePopover]);

  // Click outside to close model menu
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
        setGeminiModelMenuView('main');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelMenuOpen]);

  // Click outside to close engine menu
  useEffect(() => {
    if (!engineMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (engineMenuRef.current && !engineMenuRef.current.contains(e.target as Node)) {
        setEngineMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [engineMenuOpen]);

  // Click outside to close reasoning menu
  useEffect(() => {
    if (!reasoningMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (reasoningMenuRef.current && !reasoningMenuRef.current.contains(e.target as Node)) {
        setReasoningMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [reasoningMenuOpen]);


  const currentModelValue = modelName || cliDefaultModel;
  const currentModelOption = MODEL_OPTIONS.find((m) => m.value === currentModelValue) || MODEL_OPTIONS[0];
  const currentModelLabel = isGeminiEngine
    ? (
        isGeminiAutoModel(currentModelValue)
          ? (currentModelOption?.label || cliDefaultModel)
          : getGeminiManualMenuLabel(currentModelValue, MODEL_OPTIONS)
      )
    : currentModelOption.label;
  const currentReasoningOptions = useMemo(
    () => {
      if (engineType === 'codex') {
        return (currentModelOption?.reasoning_efforts || [...FALLBACK_CODEX_EFFORTS])
          .map((effort) => normalizeReasoningEffort(effort, 'codex'))
          .filter((effort) => effort !== '');
      }
      if (engineType === 'claude') {
        return (currentModelOption?.reasoning_efforts || [...FALLBACK_CLAUDE_EFFORTS])
          .map((effort) => normalizeReasoningEffort(effort, 'claude'))
          .filter((effort) => effort !== '');
      }
      return [];
    },
    [engineType, currentModelOption?.reasoning_efforts]
  );
  const currentReasoningValue = (() => {
    if (engineType === 'codex') {
      return normalizeReasoningEffort(reasoningEffort, 'codex')
        || normalizeReasoningEffort(currentModelOption?.default_reasoning_effort, 'codex')
        || cliDefaultReasoning;
    }
    if (engineType === 'claude') {
      return normalizeReasoningEffort(reasoningEffort, 'claude')
        || cliDefaultReasoning;
    }
    return '';
  })();

  // Keep reasoning effort aligned with selected model.
  useEffect(() => {
    if (engineType !== 'codex' && engineType !== 'claude') return;
    if (!onReasoningEffortChange) return;
    if (currentReasoningOptions.length === 0) return;

    const normalizedCurrent = normalizeReasoningEffort(reasoningEffort, engineType);
    if (normalizedCurrent && currentReasoningOptions.includes(normalizedCurrent)) return;

    const fallback =
      normalizeReasoningEffort(currentModelOption?.default_reasoning_effort, engineType)
      || currentReasoningOptions[0]
      || cliDefaultReasoning;
    if (!fallback) return;

    onReasoningEffortChange(fallback);
    localStorage.setItem('codepilot:last-reasoning-effort', fallback);
  }, [
    engineType,
    onReasoningEffortChange,
    reasoningEffort,
    currentReasoningOptions,
    currentModelOption?.default_reasoning_effort,
  ]);

  // Map isStreaming to ChatStatus for PromptInputSubmit
  const chatStatus: ChatStatus = isStreaming ? 'streaming' : 'ready';

  return (
    <div className="bg-background/80 backdrop-blur-lg px-2 py-2 sm:px-4 sm:py-3">
      <div className="mx-auto">
        <div className="relative">
          {/* Popover */}
          {popoverMode && (allDisplayedItems.length > 0 || aiSearchLoading) && (() => {
            const builtInItems = filteredItems.filter(item => item.builtIn);
            const projectItems = filteredItems.filter(item => !item.builtIn && item.source === 'project');
            const skillItems = filteredItems.filter(item => !item.builtIn && item.source !== 'project');
            let globalIdx = 0;

            const renderItem = (item: PopoverItem, idx: number) => (
              <button
                key={`${idx}-${item.value}`}
                ref={idx === selectedIndex ? (el) => { el?.scrollIntoView({ block: 'nearest' }); } : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                  item.disabled
                    ? "cursor-not-allowed opacity-60"
                    : idx === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                )}
                onClick={() => {
                  if (!item.disabled) {
                    insertItem(item);
                  }
                }}
                onMouseEnter={() => {
                  if (!item.disabled) {
                    setSelectedIndex(idx);
                  }
                }}
              >
                {popoverMode === 'file' ? (
                  <HugeiconsIcon icon={AtIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : item.builtIn && item.icon ? (
                  <HugeiconsIcon icon={item.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : !item.builtIn && item.source === 'project' ? (
                  <HugeiconsIcon icon={FileEditIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : !item.builtIn ? (
                  <HugeiconsIcon icon={GlobalIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <HugeiconsIcon icon={CommandLineIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="font-mono text-xs truncate">{item.label}</span>
                {item.argsHint && (
                  <span className="font-mono text-[10px] text-muted-foreground/60 shrink-0">{item.argsHint}</span>
                )}
                {(item.descriptionKey || item.description) && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {item.descriptionKey ? t(item.descriptionKey) : item.description}
                  </span>
                )}
                {item.statusKey && (
                  <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
                    {t(item.statusKey)}
                  </span>
                )}
                {!item.builtIn && item.installedSource && (
                  <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                    {item.installedSource === 'claude'
                      ? t('messageInput.personalTag')
                      : t('messageInput.agentsTag')}
                  </span>
                )}
              </button>
            );

            return (
              <div
                ref={popoverRef}
                className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border bg-popover shadow-lg overflow-hidden z-50"
              >
                {popoverMode === 'skill' ? (
                  <div className="px-3 py-2 border-b">
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder={t('messageInput.searchPlaceholder')}
                      value={popoverFilter}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPopoverFilter(val);
                        setSelectedIndex(0);
                        // Sync textarea: replace the filter portion after /
                        if (triggerPos !== null) {
                          const before = inputValue.slice(0, triggerPos + 1);
                          setInputValue(before + val);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev + 1) % allDisplayedItems.length);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev - 1 + allDisplayedItems.length) % allDisplayedItems.length);
                        } else if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          if (allDisplayedItems[selectedIndex]) {
                            insertItem(allDisplayedItems[selectedIndex]);
                          }
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          closePopover();
                          textareaRef.current?.focus();
                        }
                      }}
                      className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                    {t('messageInput.filesSection')}
                  </div>
                )}
                <div className="max-h-80 overflow-y-auto py-1">
                  {popoverMode === 'file' ? (
                    filteredItems.map((item, i) => renderItem(item, i))
                  ) : (
                    <>
                      {builtInItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            {t('messageInput.commandsSection')}
                          </div>
                          {builtInItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                      {projectItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            {t('messageInput.projectCommandsSection')}
                          </div>
                          {projectItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                      {skillItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            {engineType === 'gemini'
                              ? t('messageInput.customCommandsSection')
                              : t('messageInput.skillsSection')}
                          </div>
                          {skillItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                      {/* AI Suggested section */}
                      {(aiSuggestions.length > 0 || aiSearchLoading) && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                            <HugeiconsIcon icon={BrainIcon} className="h-3.5 w-3.5" />
                            {t('messageInput.aiSuggested')}
                            {aiSearchLoading && (
                              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            )}
                          </div>
                          {aiSuggestions.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* PromptInput replaces the old input area */}
          <PromptInput
            onSubmit={handleSubmit}
            accept=""
            multiple
          >
            {/* Bridge: listens for file tree "+" button events */}
            <FileTreeAttachmentBridge sessionId={sessionId} workingDirectory={workingDirectory} />
            {/* Command badge */}
            {badge && (
              <div className="flex w-full items-center gap-1.5 px-3 pt-2.5 pb-0 order-first">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 pl-2.5 pr-1.5 py-1 text-xs font-medium border border-blue-500/20">
                  <span className="font-mono">{badge.command}</span>
                  {badge.description && (
                    <span className="text-blue-500/60 dark:text-blue-400/60 text-[10px]">{badge.description}</span>
                  )}
                  <button
                    type="button"
                    onClick={removeBadge}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-blue-500/20 transition-colors"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </span>
              </div>
            )}
            {/* File attachment capsules */}
            <FileAttachmentsCapsules />
            <PromptInputTextarea
              ref={textareaRef}
              placeholder={badge
                ? t('messageInput.badgePlaceholder')
                : t('messageInput.messagePlaceholder', { engine: currentEngineLabel })}
              value={inputValue}
              onChange={(e) => handleInputChange(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="min-h-10"
            />
            <PromptInputFooter>
              <PromptInputTools>
                {/* Attach file button */}
                <AttachFileButton />

                {/* Mode capsule toggle */}
                <div className="flex items-center rounded-full border border-border/60 overflow-hidden h-6 sm:h-7">
                  {MODE_OPTIONS.map((opt) => {
                    const isActive = opt.value === mode;
                    return (
                      <button
                        key={opt.value}
                        className={cn(
                          "px-2.5 py-1 text-xs font-medium transition-colors",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => onModeChange?.(opt.value)}
                      >
                        {opt.value === 'code' ? t('messageInput.modeCode') : opt.value === 'plan' ? t('messageInput.modePlan') : opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* Engine selector */}
                <div className="relative" ref={engineMenuRef}>
                  <PromptInputButton
                    onClick={() => {
                      setEngineMenuOpen((prev) => !prev);
                      setModelMenuOpen(false);
                      setReasoningMenuOpen(false);
                    }}
                  >
                    <span className="text-xs font-mono">{currentEngineLabel}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 transition-transform duration-200", engineMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {engineMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-44 rounded-lg border bg-popover shadow-lg overflow-hidden z-50">
                      <div className="py-0.5">
                        {engineOptions.map((option) => {
                          const isActive = option.value === engineType;
                          return (
                            <button
                              key={option.value}
                              className={cn(
                                "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                              )}
                                  onClick={() => {
                                if (!isActive) {
                                  onEngineChange?.(option.value);
                                }
                                setEngineMenuOpen(false);
                              }}
                            >
                              <span className="text-xs">{option.menuLabel}</span>
                              {isActive && <span className="text-xs">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Model selector */}
                <div className="relative" ref={modelMenuRef}>
                  <PromptInputButton
                    onClick={() => {
                      setModelMenuOpen((prev) => {
                        const next = !prev;
                        if (next && isGeminiEngine) {
                          setGeminiModelMenuView('main');
                        }
                        return next;
                      });
                      setEngineMenuOpen(false);
                      setReasoningMenuOpen(false);
                    }}
                  >
                    <span className="text-xs font-mono">{currentModelLabel}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 transition-transform duration-200", modelMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {modelMenuOpen && (
                    <div className={cn(
                      "absolute bottom-full left-0 mb-1.5 rounded-lg border bg-popover shadow-lg overflow-hidden z-50 max-h-80 overflow-y-auto",
                      isGeminiEngine ? "w-72" : "w-52"
                    )}>
                      {isGeminiEngine ? (
                        <div>
                          <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
                            {currentGroup?.provider_name || 'Gemini CLI'}
                          </div>
                          {geminiModelMenuView === 'main' ? (
                            <div className="py-0.5">
                              {[
                                { value: 'auto-gemini-3', label: '1: Auto (Gemini 3)' },
                                { value: 'auto-gemini-2.5', label: '2: Auto (Gemini 2.5)' },
                                { value: 'manual', label: `3: ${getGeminiManualMenuLabel(currentModelValue, MODEL_OPTIONS)}` },
                              ].map((opt) => {
                                const isActive = opt.value === 'manual'
                                  ? !isGeminiAutoModel(currentModelValue)
                                  : opt.value === currentModelValue;
                                return (
                                  <button
                                    key={opt.value}
                                    className={cn(
                                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                                      isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                                    )}
                                    onClick={() => {
                                      if (opt.value === 'manual') {
                                        setGeminiModelMenuView('manual');
                                        return;
                                      }
                                      if (currentGroup) {
                                        if (onProviderModelChange) {
                                          onProviderModelChange(currentGroup.provider_id, opt.value);
                                        } else {
                                          onModelChange?.(opt.value);
                                        }
                                      }
                                      setModelMenuOpen(false);
                                      setGeminiModelMenuView('main');
                                    }}
                                  >
                                    <span className="font-mono text-xs">{opt.label}</span>
                                    {isActive && <span className="text-xs">✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div>
                              <div className="border-b px-3 py-1.5">
                                <button
                                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                                  onClick={() => setGeminiModelMenuView('main')}
                                >
                                  {'<'} Back
                                </button>
                              </div>
                              <div className="py-0.5">
                                {GEMINI_MANUAL_OPTIONS.map((opt) => {
                                  const isActive = opt.value === currentModelValue;
                                  return (
                                    <button
                                      key={opt.value}
                                      className={cn(
                                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                                        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                                      )}
                                      onClick={() => {
                                        if (currentGroup) {
                                          if (onProviderModelChange) {
                                            onProviderModelChange(currentGroup.provider_id, opt.value);
                                          } else {
                                            onModelChange?.(opt.value);
                                          }
                                        }
                                        setModelMenuOpen(false);
                                        setGeminiModelMenuView('main');
                                      }}
                                    >
                                      <span className="font-mono text-xs">{opt.label}</span>
                                      {isActive && <span className="text-xs">✓</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        providerGroups.map((group, groupIdx) => (
                          <div key={group.provider_id}>
                            <div className={cn(
                              "px-3 py-1.5 text-[10px] font-medium text-muted-foreground",
                              groupIdx > 0 && "border-t"
                            )}>
                              {group.provider_name}
                            </div>
                            <div className="py-0.5">
                              {ensureModelOption(
                                group.models,
                                group.provider_id === currentProviderIdValue ? modelName : undefined
                              ).map((opt) => {
                                const isActive = opt.value === currentModelValue && group.provider_id === currentProviderIdValue;
                                return (
                                  <button
                                    key={`${group.provider_id}-${opt.value}`}
                                    className={cn(
                                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                                      isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                                    )}
                                    onClick={() => {
                                      if (onProviderModelChange) {
                                        onProviderModelChange(group.provider_id, opt.value);
                                      } else {
                                        onModelChange?.(opt.value);
                                      }
                                      if (engineType === 'codex' && onReasoningEffortChange) {
                                        const supported = (opt.reasoning_efforts || [...FALLBACK_CODEX_EFFORTS])
                                          .map((effort) => normalizeReasoningEffort(effort))
                                          .filter((effort) => effort !== '');
                                        const current = normalizeReasoningEffort(reasoningEffort);
                                        if (!current || !supported.includes(current)) {
                                          const nextReasoning =
                                            normalizeReasoningEffort(opt.default_reasoning_effort)
                                            || supported[0]
                                            || cliDefaultReasoning;
                                          if (nextReasoning) {
                                            onReasoningEffortChange(nextReasoning);
                                          }
                                        }
                                      }
                                      setModelMenuOpen(false);
                                    }}
                                  >
                                    <span className="font-mono text-xs">{opt.label}</span>
                                    {isActive && <span className="text-xs">✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Reasoning effort selector (Codex + Claude) */}
                {(engineType === 'codex' || engineType === 'claude') && currentReasoningOptions.length > 0 && (
                  <div className="relative" ref={reasoningMenuRef}>
                    <PromptInputButton
                      onClick={() => {
                        setReasoningMenuOpen((prev) => !prev);
                        setEngineMenuOpen(false);
                      }}
                    >
                      <span className="text-xs font-mono">
                        {`${t('messageInput.reasoningEffort')}: ${getEffortLabel(currentReasoningValue || cliDefaultReasoning)}`}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        className={cn("h-2.5 w-2.5 transition-transform duration-200", reasoningMenuOpen && "rotate-180")}
                      />
                    </PromptInputButton>

                    {reasoningMenuOpen && (
                      <div className="absolute bottom-full left-0 mb-1.5 w-44 rounded-lg border bg-popover shadow-lg overflow-hidden z-50">
                        <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
                          {t('messageInput.reasoningEffort')}
                        </div>
                        <div className="py-0.5 border-t">
                          {currentReasoningOptions.map((effort) => {
                            const isActive = effort === currentReasoningValue;
                            return (
                              <button
                                key={effort}
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                                  isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                                )}
                                onClick={() => {
                                  onReasoningEffortChange?.(effort);
                                  setReasoningMenuOpen(false);
                                }}
                              >
                                <span className="font-mono text-xs">{getEffortLabel(effort)}</span>
                                {isActive && <span className="text-xs">✓</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Approval policy selector (Codex + Claude + Gemini) */}
                {(engineType === 'codex' || engineType === 'claude' || engineType === 'gemini') && (
                  <PromptInputApprovalPolicy
                    value={
                      (engineType === 'claude' || engineType === 'gemini') ? (mode || 'code')
                      : approvalPolicy
                    }
                    label={t('messageInput.approvalPolicy')}
                    options={
                      engineType === 'claude' ? CLAUDE_APPROVAL_OPTIONS
                      : engineType === 'gemini' ? GEMINI_APPROVAL_OPTIONS
                      : undefined
                    }
                    onSelect={(policy) => {
                      if (engineType === 'claude' || engineType === 'gemini') {
                        onModeChange?.(policy);
                      } else {
                        window.dispatchEvent(new CustomEvent('command-rerun', { detail: { command: `/permissions ${policy}` } }));
                      }
                    }}
                  />
                )}

                {/* Image Agent toggle */}
                <ImageGenToggle />
              </PromptInputTools>

              <FileAwareSubmitButton
                status={chatStatus}
                onStop={onStop}
                disabled={disabled}
                inputValue={inputValue}
                hasBadge={!!badge}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

    </div>
  );
}
