# 斜杠命令系统改造 — 架构设计文档

> **状态**: 规划中  
> **关联文档**:
> - [需求文档](./slash-commands-requirements.md)
> - [任务拆解文档](./slash-commands-tasks.md)
> **日期**: 2026-03-29

---

## 1. 目标架构概述

### 1.1 现状问题

当前命令处理流程存在四层判断逻辑，执行路径复杂且不可预测：

```
用户输入 /command
  ├─ (1) 是否是 compact/review？ → Stream 层直接处理
  ├─ (2) 是否在 nativeCommandNames 中？ → POST /api/chat/native-command → 后端 controller
  │     ├─ 处理成功 → 返回结果 + statePatch
  │     └─ 处理失败 → 返回错误但 matched=true, handled=false → 显示错误
  ├─ (3) 是否标记为 cli-only？ → 显示 cli-only 提示
  ├─ (4) 是否标记为 terminal？ → CLI 二进制执行
  └─ (5) ChatView switch/case → ~28 个硬编码分支
        └─ default → sendMessage（当作普通消息发送）
```

问题：第(2)步的 `nativeCommandNames` 包含所有 `source=official` 的命令名称，但后端 controller 只处理其中一个子集。当后端返回 `handled: false` 时，前端显示错误消息并停止——**不会 fallback 到 ChatView switch/case**。这意味着在 nativeCommandNames 中但后端不处理的命令（如 Claude 的 `/about`）会直接报错。

### 1.2 目标

建立**统一命令分派器（Unified Command Dispatcher）**，替代当前多层判断逻辑。分派器根据命令元数据中的 `execution` 字段直接决定执行路径，不存在 fallback 链。

```
用户输入 /command
  └─ Unified Command Dispatcher
       ├─ 查询 command-registry 获取命令元数据
       ├─ 根据 execution 字段路由到对应执行层
       └─ 未找到命令 → 显示 "未知命令"
```

---

## 2. 命令执行层定义

### Layer 1: Stream 命令

**触发条件**: `execution === 'stream'`  
**处理方式**: 通过 `startStream()` 以 `nativeCommand` payload 调用流式 API  
**适用引擎**: Claude（compact, review）、Codex（compact, review）  
**输出**: 流式 Markdown 响应  

**注意**: Gemini 当前无 stream 支持。Gemini 的 `/compress`（等同 compact）暂时降级到 Layer 5（prompt 命令）。

```typescript
// 路由条件
if (metadata.execution === 'stream') {
  startStream({
    sessionId,
    content: rawCommand,
    nativeCommand: { commandName, args },
    // ...
  });
}
```

### Layer 2: Native Controller 命令

**触发条件**: `execution === 'immediate' && metadata.commandMode !== 'local'`  
（更精确地：命令名在对应引擎的 NATIVE_COMMAND_NAMES 集合中）  
**处理方式**: POST `/api/chat/native-command`  
**适用命令**:
- Claude: `model`, `permissions`, `status`, `mcp`, `doctor`, `memory`, `agents`, `pr_comments`, `diff`
- Codex: `model`, `status`, `mcp`, `fork`, `permissions`, `diff`, `agent`, `experimental`, `personality`, `ps`, `debug-config`, `skills`, `apps`
- Gemini: `about`, `mcp`, `permissions`, `settings`, `auth`, `memory`, `agents`, `extensions`, `hooks`, `skills`, `tools`, `doctor`, `diff`, `model`, `init`

**输出**: `NativeCommandControllerResponse` (message + optional statePatch + optional data)

**重要**: 后端 controller 返回的 `statePatch` 由 dispatcher 统一应用到前端状态（model、mode、reasoningEffort、approvalPolicy）。

### Layer 3: Local UI 命令

**触发条件**: `execution === 'immediate' && metadata.commandMode === 'local'`  
（或命令名在 LOCAL_COMMANDS 集合中）  
**处理方式**: 纯前端执行，不调用后端  
**适用命令**: `clear`, `help`, `cost`, `stats`, `copy`, `exit`, `quit`, `new`, `plan`, `resume`, `chat`, `about`(部分引擎), `docs`, `privacy`, `feedback`, `bug`, `add-dir`, `version`, `history`, `shortcuts`, `commands`

**实现**: 集中在 `src/lib/local-command-handlers.ts` 中（新文件），每个命令是一个纯函数：

```typescript
interface LocalCommandContext {
  sessionId: string;
  engineType: EngineType;
  messages: Message[];
  currentModel: string;
  currentMode: string;
  // ...
}

interface LocalCommandResult {
  message?: string;       // 展示给用户的消息
  action?: 'navigate' | 'clearMessages' | 'openPanel' | 'switchMode' | 'openExternal';
  actionPayload?: unknown;
}

type LocalCommandHandler = (args: string, context: LocalCommandContext) => LocalCommandResult | Promise<LocalCommandResult>;
```

### Layer 4: CLI Passthrough 命令

**触发条件**: `execution === 'terminal'`  
**处理方式**: POST `/api/chat/cli-exec` 执行 CLI 二进制并捕获输出  
**适用命令**: 动态加载中标记为 `execution: 'terminal'` 的命令  
**输出**: CLI stdout/stderr 包裹在代码块中展示

**注意**: 当前只有通过 fallbacks.ts 中 `cliCommand` 字段标记的命令才走此路径。未来可扩展到所有无 native 实现的命令。

### Layer 5: Prompt 命令

**触发条件**: `execution === 'prompt'`  
**处理方式**: 将斜杠命令原文作为用户消息发送到 LLM  
**适用命令**: `init`(Claude/Codex), `compact`(无 stream 引擎), `compress`(Gemini), `review`(无 stream 引擎)  
**输出**: LLM 流式响应

```typescript
if (metadata.execution === 'prompt') {
  sendMessage(rawCommand);
}
```

### Layer 6: CLI-only 提示

**触发条件**: `availability === 'cli-only'` 或 `execution === 'cli-only'`  
**处理方式**: 显示标准化的 "此命令仅在终端 CLI 中可用" 消息  
**适用命令**: `login`, `logout`, `config`, `bug`(Claude), `vim`, `terminal-setup`, `search`, `theme`, `editor`, `ide`, `shells`, `copy`(Claude)

---

## 3. 统一命令分派器设计

### 3.1 Dispatcher 接口

```typescript
// src/lib/command-dispatcher.ts

interface CommandDispatcherOptions {
  sessionId: string;
  engineType: EngineType;
  rawCommand: string;
  // 当前前端状态
  currentModel: string;
  currentMode: string;
  currentReasoningEffort?: string;
  currentProviderId: string;
  currentApprovalPolicy?: string;
  workingDirectory?: string;
  messages: Message[];
  runtimeCommands: RuntimeCommandMetadata[];
  isStreaming: boolean;
  // 回调
  onStartStream: (opts: StreamOptions) => void;
  onSendMessage: (msg: string) => void;
  onAppendAssistantMessage: (content: string) => void;
  onSetMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  onApplyStatePatch: (patch: NativeCommandStatePatch) => void;
  onNavigate: (path: string) => void;
  onOpenPanel: () => void;
  t: TFunction;
}

interface CommandDispatchResult {
  handled: boolean;
  error?: string;
}

async function dispatchCommand(options: CommandDispatcherOptions): Promise<CommandDispatchResult>;
```

### 3.2 路由决策流程

```
dispatchCommand(options)
  │
  ├─ 1. 解析命令: parseSlashCommand(rawCommand) → { commandName, args }
  │
  ├─ 2. 查找命令: findRuntimeCommand(runtimeCommands, rawCommand)
  │     └─ 未找到 → return { handled: false }
  │
  ├─ 3. 根据 execution 字段路由:
  │     ├─ 'stream'    → Layer 1: streamCommandHandler
  │     ├─ 'immediate' → 判断是否在 NATIVE_COMMAND_NAMES 中
  │     │     ├─ 是 → Layer 2: nativeCommandHandler (POST /api/chat/native-command)
  │     │     └─ 否 → Layer 3: localCommandHandler
  │     ├─ 'terminal'  → Layer 4: cliPassthroughHandler (POST /api/chat/cli-exec)
  │     ├─ 'prompt'    → Layer 5: promptCommandHandler (sendMessage)
  │     └─ 'cli-only'  → Layer 6: cliOnlyHandler (显示提示)
  │
  └─ 4. 处理结果:
        ├─ 成功 → 应用 statePatch, 展示 message
        └─ 失败 → 展示错误消息
```

### 3.3 Native Command Names 注册

为了精确判断 Layer 2 vs Layer 3，每个引擎的 native controller 必须导出自己的 `NATIVE_COMMAND_NAMES` 集合：

```typescript
// 已存在于各 controller 中
// claude-native-controller.ts
const NATIVE_COMMAND_NAMES = new Set([
  'model', 'permissions', 'status', 'mcp',
  'doctor', 'memory', 'agents', 'pr_comments', 'diff',
]);

// codex-native-controller.ts
const NATIVE_COMMAND_NAMES = new Set([
  'model', 'status', 'mcp', 'fork',
  'permissions', 'diff', 'agent', 'experimental', 'personality', 'ps', 'debug-config',
  'skills', 'apps',
]);

// gemini-native-controller.ts
const NATIVE_COMMAND_NAMES = new Set([
  'about', 'mcp', 'permissions', 'settings', 'auth',
  'memory', 'agents', 'extensions', 'hooks', 'skills', 'tools',
  'doctor', 'diff', 'model', 'init',
]);
```

前端通过 `/api/chat/native-command-names?engine_type=xxx` 获取这些名称集合（或复用已有的 `useNativeCommandController` hook 中的 `nativeCommandNames`）。

---

## 4. 完整命令路由表

### 4.1 Claude 路由表

| 命令 | Layer | 说明 |
|------|-------|------|
| `compact` | 1 (Stream) | 流式压缩对话 |
| `review` | 1 (Stream) | 流式代码审查 |
| `model` | 2 (Native) | SDK setModel / supportedModels |
| `permissions` | 2 (Native) | SDK setPermissionMode |
| `status` | 2 (Native) | SDK initializationResult + accountInfo |
| `mcp` | 2 (Native) | SDK mcpServerStatus |
| `doctor` | 2 (Native) | 健康检查 |
| `memory` | 2 (Native) | 读取 CLAUDE.md |
| `agents` | 2 (Native) | 列出 .claude/agents/ |
| `pr_comments` | 2 (Native) | gh pr view |
| `diff` | 2 (Native) | git diff --stat |
| `clear` | 3 (Local) | 清空消息 |
| `help` | 3 (Local) | 显示帮助 |
| `cost` / `stats` | 3 (Local) | 显示 token 统计 |
| `copy` | 3 (Local) | 复制最后响应到剪贴板 |
| `exit` / `quit` | 3 (Local) | 返回聊天列表 |
| `new` | 3 (Local) | 新建对话 |
| `plan` | 3 (Local) | 切换 plan/code 模式 |
| `resume` | 3 (Local) | 打开侧边栏 |
| `chat` | 3 (Local) | 打开侧边栏 |
| `about` | 3 (Local) | 显示版本信息（通过 runtime-status API） |
| `docs` | 3 (Local) | 打开文档链接 |
| `feedback` | 3 (Local) | 显示反馈指引 |
| `add-dir` | 3 (Local) | 添加工作目录 |
| `fast` | 3 (Local) | 切换输出模式（待实现） |
| `version` | 3 (Local) | 显示版本（通过 runtime-status API） |
| `history` | 3 (Local) | 导航到历史页面 |
| `undo` | 2 (Native) | SDK rewindFiles（需新增实现） |
| `fork` | 2 (Native) | 对话分叉（需新增实现，参考 Codex） |
| `apps` | 2 (Native) | SDK apps（需新增实现） |
| `init` | 5 (Prompt) | 作为 prompt 发送 |
| `login` | 6 (CLI-only) | 跳转设置页面 + 提示 |
| `logout` | 6 (CLI-only) | 跳转设置页面 + 提示 |
| `config` | 6 (CLI-only) | 跳转设置页面 |
| `bug` | 6 (CLI-only) | 显示 bug 报告链接 |
| `vim` | 6 (CLI-only) | 提示终端专用 |
| `terminal-setup` | 6 (CLI-only) | 提示终端专用 |
| `search` | 6 (CLI-only) | 提示终端专用 |
| `theme` | 6 (CLI-only) | 提示终端专用 |

### 4.2 Codex 路由表

| 命令 | Layer | 说明 |
|------|-------|------|
| `compact` | 1 (Stream) | 流式压缩对话 |
| `review` | 1 (Stream) | 流式代码审查 |
| `model` | 2 (Native) | app-server listModels / writeConfigValue |
| `permissions` | 2 (Native) | app-server readConfig / writeConfigValue |
| `status` | 2 (Native) | app-server readConfig + readAccount + listMcpServerStatus |
| `mcp` | 2 (Native) | app-server listMcpServerStatus |
| `fork` | 2 (Native) | app-server forkThread |
| `diff` | 2 (Native) | git diff --stat |
| `agent` | 2 (Native) | app-server readThread + listThreads |
| `experimental` | 2 (Native) | app-server listExperimentalFeatures |
| `personality` | 2 (Native) | app-server listCollaborationModes |
| `ps` | 2 (Native) | app-server readThread (进程状态) |
| `debug-config` | 2 (Native) | app-server readConfig (含 layers) |
| `skills` | 2 (Native) | app-server listSkills |
| `apps` | 2 (Native) | app-server listApps |
| `clear` | 3 (Local) | 清空消息 |
| `help` | 3 (Local) | 显示帮助 |
| `cost` / `stats` | 3 (Local) | 显示 token 统计 |
| `exit` / `quit` | 3 (Local) | 返回聊天列表 |
| `new` | 3 (Local) | 新建对话 |
| `plan` | 3 (Local) | 切换 plan/code 模式 |
| `resume` | 3 (Local) | 打开侧边栏 |
| `fast` | 3 (Local) | 切换输出模式（待实现） |
| `feedback` | 3 (Local) | 显示反馈指引 |
| `version` | 3 (Local) | 显示版本 |
| `history` | 3 (Local) | 导航到历史页面 |
| `undo` | 2 (Native) | app-server（需新增实现） |
| `init` | 5 (Prompt) | 作为 prompt 发送 |
| `search` | 6 (CLI-only) | 提示终端专用 |
| `config` | 6 (CLI-only) | 跳转设置页面 |
| `theme` | 6 (CLI-only) | 提示终端专用 |

### 4.3 Gemini 路由表

| 命令 | Layer | 说明 |
|------|-------|------|
| `about` | 2 (Native) | Gemini CLI --version |
| `mcp` | 2 (Native) | 读取 settings.json MCP 配置 |
| `permissions` | 2 (Native) | 读取/设置权限 |
| `settings` | 2 (Native) | 显示 settings.json |
| `auth` | 2 (Native) | 显示认证状态 |
| `memory` | 2 (Native) | 读取 GEMINI.md |
| `agents` | 2 (Native) | 列出 agents/ 目录 |
| `extensions` | 2 (Native) | 显示扩展配置 |
| `hooks` | 2 (Native) | 列出 hooks/ 目录 |
| `skills` | 2 (Native) | 列出 skills/ 目录 |
| `tools` | 2 (Native) | 列出 MCP servers/tools |
| `doctor` | 2 (Native) | 健康检查 |
| `diff` | 2 (Native) | git diff --stat |
| `model` | 2 (Native) | 读取/设置模型 |
| `init` | 2 (Native) | 创建 GEMINI.md |
| `clear` | 3 (Local) | 清空消息 |
| `help` | 3 (Local) | 显示帮助 |
| `commands` | 3 (Local) | 等同 /help |
| `stats` | 3 (Local) | 显示 token 统计 |
| `copy` | 3 (Local) | 复制最后响应到剪贴板 |
| `quit` | 3 (Local) | 返回聊天列表 |
| `plan` | 3 (Local) | 切换 plan/code 模式 |
| `resume` | 3 (Local) | 打开侧边栏 |
| `chat` | 3 (Local) | 打开侧边栏 |
| `docs` | 3 (Local) | 打开 Gemini 文档 |
| `privacy` | 3 (Local) | 显示隐私声明 |
| `bug` | 3 (Local) | 显示 bug 报告信息 |
| `feedback` | 3 (Local) | 显示反馈指引（待实现） |
| `shortcuts` | 3 (Local) | 显示快捷键（待实现） |
| `directory` | 3 (Local) | 显示/设置工作目录（待实现） |
| `setup-github` | 3 (Local) | 显示 GitHub 设置指引 |
| `profile` | 2 (Native) | 读取 profile 信息（需新增实现） |
| `policies` | 2 (Native) | 等同 /permissions（需别名路由） |
| `rewind` | 2 (Native) | 类似 undo（需新增实现） |
| `compress` | 5 (Prompt) | 作为 prompt 发送（类似 compact） |
| `corgi` | 3 (Local) | 彩蛋（待实现） |
| `vim` | 6 (CLI-only) | 提示终端专用 |
| `terminal-setup` | 6 (CLI-only) | 提示终端专用 |
| `editor` | 6 (CLI-only) | 提示终端专用 |
| `ide` | 6 (CLI-only) | 提示终端专用 |
| `shells` | 6 (CLI-only) | 提示终端专用 |
| `theme` | 6 (CLI-only) | 提示终端专用 |

---

## 5. Config 同步

以下命令在执行时需要将变更持久化到配置文件：

| 命令 | 引擎 | 配置文件 | 同步内容 |
|------|------|---------|---------|
| `/model <name>` | Claude | `~/.claude/settings.json` | model |
| `/model <name>` | Codex | `~/.codex/config.toml` | model, reasoning_effort |
| `/model <name>` | Gemini | `~/.gemini/settings.json` | model |
| `/permissions <mode>` | Claude | `~/.claude/settings.json` | permission_mode |
| `/permissions <mode>` | Codex | `~/.codex/config.toml` | approval_policy |
| `/permissions <mode>` | Gemini | `~/.gemini/settings.json` | permissions.defaultMode |

Config 同步通过已有的 `syncConfigToFile()` 函数完成，在 native controller 中调用。

---

## 6. 数据流图

### 6.1 Stream 命令流

```
用户输入 "/compact"
  │
  ├─ Dispatcher 识别 execution='stream'
  │
  ├─ 调用 startStream({
  │     sessionId,
  │     content: "/compact",
  │     nativeCommand: { commandName: "compact" },
  │     engineType: "claude",
  │   })
  │
  ├─ POST /api/chat/stream
  │     ├─ claude-native-stream.ts: isStreamNativeCommand("compact") → true
  │     ├─ 调用 streamClaudePersistent() with literal "/compact" as prompt
  │     └─ 返回 SSE 流
  │
  └─ 前端渲染流式 Markdown 响应
```

### 6.2 Native Controller 命令流

```
用户输入 "/model gpt-4o"
  │
  ├─ Dispatcher 识别 execution='immediate', 命令在 NATIVE_COMMAND_NAMES 中
  │
  ├─ POST /api/chat/native-command {
  │     engine_type: "codex",
  │     command_name: "model",
  │     args: "gpt-4o",
  │     session_id: "...",
  │     context: { model: "gpt-4o-mini", ... }
  │   }
  │
  ├─ native-command route.ts → runCodexNativeCommand()
  │     ├─ codex-native-controller.ts
  │     ├─ withCodexAppServer(client => client.listModels())
  │     ├─ parseModelArgs("gpt-4o", models)
  │     ├─ syncConfigToFile('codex', { model: 'gpt-4o' })
  │     └─ return { handled: true, message: "...", state_patch: { model: "gpt-4o" } }
  │
  ├─ Dispatcher 应用 statePatch:
  │     ├─ setCurrentModel("gpt-4o")
  │     ├─ persistEnginePreferences(...)
  │     └─ PATCH /api/chat/sessions/{id} { model: "gpt-4o" }
  │
  └─ appendAssistantMessage("Codex model switched to `gpt-4o`.")
```

### 6.3 Local UI 命令流

```
用户输入 "/clear"
  │
  ├─ Dispatcher 识别 execution='immediate', commandMode='local'
  │
  ├─ 调用 localCommandHandlers.clear(args, context)
  │     └─ return { action: 'clearMessages' }
  │
  ├─ Dispatcher 执行 action:
  │     ├─ setMessages([])
  │     └─ PATCH /api/chat/sessions/{id} { clear_messages: true }
  │
  └─ 无消息展示（清空后界面空白）
```

### 6.4 CLI-only 提示流

```
用户输入 "/vim"
  │
  ├─ Dispatcher 识别 availability='cli-only'
  │
  ├─ 生成标准化 cli-only 消息:
  │     "## 此命令仅在终端中可用
  │      /vim 仅在 Claude CLI 终端中可用。"
  │
  └─ appendAssistantMessage(message)
```

---

## 7. 新增文件与修改文件

### 7.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/lib/command-dispatcher.ts` | 统一命令分派器 |
| `src/lib/local-command-handlers.ts` | 所有 Local UI 命令的处理函数 |

### 7.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/components/chat/ChatView.tsx` | 删除 switch/case，改为调用 `dispatchCommand()` |
| `src/app/chat/page.tsx` | 同上 |
| `src/hooks/useNativeCommandController.ts` | 导出 `NATIVE_COMMANDS_FALLBACK` 供 dispatcher 使用，或将判断逻辑迁入 dispatcher |
| `src/lib/command-registry/fallbacks.ts` | 更新 `execution` 字段使其精确反映每个命令的执行层 |
| `src/lib/command-registry/types.ts` | 扩展 `execution` 类型，增加 `'stream'` 值 |
| `src/lib/agent/gemini-native-controller.ts` | 新增缺失命令的处理（profile, policies, rewind） |
| `src/lib/agent/claude-native-controller.ts` | 新增缺失命令的处理（fork, undo, about, apps, version） |

### 7.3 不修改的文件

| 文件 | 原因 |
|------|------|
| `src/lib/agent/claude-native-stream.ts` | Stream 层逻辑正确，无需改动 |
| `src/lib/agent/codex-native-stream.ts` | 同上 |
| `src/app/api/chat/native-command/route.ts` | API 路由层无需改动 |
| `src/app/api/chat/runtime-control/route.ts` | 保持向后兼容，不改动 |

---

## 8. 迁移策略

### 8.1 渐进式迁移

不采用一次性重写，而是分阶段迁移：

1. **Phase 1**: 创建 `command-dispatcher.ts` 和 `local-command-handlers.ts`，但暂不替换 ChatView。
2. **Phase 2**: 逐个将 ChatView switch/case 迁移到 dispatcher，每迁移一批命令后验证。
3. **Phase 3**: 完全移除 ChatView 中的 switch/case，dispatcher 成为唯一入口。
4. **Phase 4**: 删除 page.tsx 中的重复逻辑。

### 8.2 风险控制

- 每个阶段完成后运行完整的命令矩阵验证
- dispatcher 中保留临时的 `LEGACY_SWITCH_CASE_FALLBACK` 开关，出问题时可回退
- 对于标记为 `supported` 但实际无处理的命令，改为正确的 `availability` 值，而非实现空壳
