# 斜杠命令系统改造 — 需求文档

> **状态**: 规划中  
> **关联文档**:
> - [架构设计文档](./slash-commands-architecture.md)
> - [任务拆解文档](./slash-commands-tasks.md)
> **日期**: 2026-03-29

---

## 1. 背景

### 1.1 当前状态

CodePilot 支持三个 AI 引擎（Claude、Codex、Gemini），每个引擎拥有各自的斜杠命令集。当前命令处理散布在**四个不同层级**中：

| 层级 | 位置 | 职责 |
|------|------|------|
| **Stream 层** | `claude-native-stream.ts` / `codex-native-stream.ts` | 处理 `compact`、`review` 两个流式命令 |
| **Native Controller 层** | `claude-native-controller.ts` / `codex-native-controller.ts` / `gemini-native-controller.ts` | 通过 `/api/chat/native-command` API 处理后端命令 |
| **Runtime Control 层** | `/api/chat/runtime-control/route.ts` | Claude 专用的 SDK 控制 API（legacy + 新命令路由） |
| **ChatView switch/case 层** | `ChatView.tsx` / `page.tsx` | 前端硬编码的 ~28 个 switch/case 分支 |

### 1.2 已识别的问题

1. **多层重复处理**: 同一命令可能在多个层被处理。例如 `/model` 先经过 native controller 后端 API，如果后端处理成功就返回，否则 fallback 到 ChatView 的 switch/case。
2. **ChatView switch/case 膨胀**: `ChatView.tsx` 包含 ~28 个硬编码的 case 分支，与引擎无关的通用命令和引擎特定命令混杂。
3. **page.tsx 与 ChatView.tsx 重复**: 两个文件各自维护一套几乎相同的 switch/case 命令处理逻辑。
4. **Gemini 缺少 stream 层**: Gemini 没有 native stream 文件，`compact` 和 `review` 无法通过 stream 执行。
5. **命令可用性标记不准确**: 某些命令在 fallbacks.ts 中标记为 `supported` 但实际并无后端实现（如 `/fast`、`/version`、`/history`）。
6. **动态加载的命令缺少处理器**: Gemini 动态加载 38 个命令，但 native controller 只处理 15 个。剩余 23 个命令在菜单中可见但执行时无对应处理逻辑。
7. **"cli-only" 命令处理不一致**: cli-only 命令有的显示提示消息、有的跳转设置页面、有的直接忽略，没有统一策略。

---

## 2. 目标

**核心目标**: 每个引擎 CLI 支持的斜杠命令都必须在 CodePilot GUI 中可用——要么原生执行，要么降级为 CLI 二进制调用或友好提示。

具体目标：
- 消除 ChatView 中的硬编码 switch/case 命令处理
- 建立单一命令分派器（Command Dispatcher），统一所有引擎的命令路由
- 确保命令注册表（command-registry）与实际处理能力精确匹配
- 动态加载的命令如果没有 native 实现，能自动降级到合理的处理方式
- 提供一致的错误消息和用户反馈

---

## 3. 设计原则

| 原则 | 说明 |
|------|------|
| **单一职责源** | 每个命令只在一个确定的层级处理，不存在 fallback 链 |
| **注册表驱动** | 命令的路由行为由 command-registry 中的元数据决定，不靠代码中的 switch/case |
| **API 优先** | 所有后端命令通过 `/api/chat/native-command` 统一入口，不再使用 `/api/chat/runtime-control` 的新式命令路由 |
| **动态加载** | 优先从 SDK / app-server / CLI 动态发现命令，fallback 列表仅用于兜底 |
| **渐进降级** | 没有 native 实现的命令按优先级依次尝试：CLI 二进制执行 → prompt 发送 → 友好提示 |
| **类型安全** | 命令路由表完全类型化，新增命令时编译器提示 |

---

## 4. 命令矩阵

### 4.1 Claude 命令矩阵

> 来源: Claude SDK `supportedCommands()` + fallbacks.ts  
> 动态加载: 39 个命令（含 codepilot 的 clear/help）  
> Native Controller 处理: 9 个（`model`, `permissions`, `status`, `mcp`, `doctor`, `memory`, `agents`, `pr_comments`, `diff`）  
> Stream 处理: 2 个（`compact`, `review`）

| 命令 | 来源 | 当前处理位置 | 可用性标记 | 应有处理方式 | 状态 |
|------|------|-------------|-----------|-------------|------|
| `/model` | SDK | Native Controller → ChatView fallback | supported | Native Controller | ✅ 可用 |
| `/permissions` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/status` | SDK | Native Controller + ChatView (cost/stats) | supported | Native Controller | ⚠️ 部分（/status 走 native，/cost /stats 走 ChatView） |
| `/mcp` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/compact` | SDK | Stream 层 | supported | Stream 层 | ✅ 可用 |
| `/review` | SDK | Stream 层 | supported | Stream 层 | ✅ 可用 |
| `/init` | SDK | ChatView default → sendMessage | supported | Prompt 命令 | ⚠️ 部分（默认 fallthrough 发送） |
| `/cost` | SDK | ChatView switch/case | cli-only | Local UI | ⚠️ 实际可用但标记为 cli-only |
| `/doctor` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/memory` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/agents` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/pr_comments` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/diff` | SDK | Native Controller | supported | Native Controller | ✅ 可用 |
| `/about` | SDK | ChatView switch/case | supported | Native Controller 或 Local UI | ⚠️ 未经 native controller |
| `/add-dir` | SDK | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/apps` | SDK | ChatView switch/case (提示文字) | supported | Native Controller | ⚠️ 仅显示提示文字 |
| `/chat` | SDK | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/docs` | SDK | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/exit` | SDK | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/quit` | SDK | ChatView switch/case（exit 别名） | supported | Local UI | ✅ 可用 |
| `/fast` | fallback | 无处理 | supported | 待定义 | 🔇 菜单可见但无处理 |
| `/feedback` | SDK | ChatView switch/case (提示文字) | supported | Local UI | ⚠️ 仅显示提示 |
| `/fork` | SDK | 无处理 | supported | Native Controller | 🔇 菜单可见但无处理 |
| `/plan` | SDK | ChatView switch/case | supported | Local UI（模式切换） | ✅ 可用 |
| `/resume` | SDK | ChatView switch/case | supported | Local UI | ⚠️ 仅打开侧边栏 |
| `/new` | SDK | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/copy` | SDK | ChatView switch/case | cli-only | Local UI（剪贴板） | ⚠️ 实际可用但标记为 cli-only |
| `/help` | codepilot | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/clear` | codepilot | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/login` | SDK | ChatView switch/case | cli-only | Local UI（跳转设置） | ⚠️ 部分可用 |
| `/logout` | SDK | ChatView switch/case | cli-only | Local UI（跳转设置） | ⚠️ 部分可用 |
| `/config` | SDK | ChatView switch/case | cli-only | Local UI（跳转设置） | ⚠️ 部分可用 |
| `/bug` | SDK | ChatView switch/case | cli-only | Local UI（显示链接） | ⚠️ 部分可用 |
| `/vim` | SDK | ChatView switch/case | cli-only | CLI-only 提示 | ✅ 提示正确 |
| `/terminal-setup` | SDK | ChatView switch/case | cli-only | CLI-only 提示 | ✅ 提示正确 |
| `/search` | fallback | 无处理 | cli-only | CLI-only 提示 | 🔇 被 cli-only 拦截但无专属消息 |
| `/version` | fallback | 无处理 | supported | Native Controller 或 Local UI | 🔇 菜单可见但无处理 |
| `/history` | fallback | 无处理 | supported | Local UI（跳转历史） | 🔇 菜单可见但无处理 |
| `/undo` | fallback | 无处理 | supported | Native Controller (rewindFiles) | 🔇 菜单可见但无处理 |
| `/theme` | fallback | 无处理 | cli-only | CLI-only 提示 | 🔇 被 cli-only 拦截但无专属消息 |

### 4.2 Codex 命令矩阵

> 来源: Codex app-server + fallbacks.ts  
> 动态加载: 29 个命令  
> Native Controller 处理: 13 个（`model`, `status`, `mcp`, `fork`, `permissions`, `diff`, `agent`, `experimental`, `personality`, `ps`, `debug-config`, `skills`, `apps`）  
> Stream 处理: 2 个（`compact`, `review`）

| 命令 | 来源 | 当前处理位置 | 可用性标记 | 应有处理方式 | 状态 |
|------|------|-------------|-----------|-------------|------|
| `/model` | app-server | Native Controller → ChatView fallback | supported | Native Controller | ✅ 可用 |
| `/permissions` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/status` | app-server | Native Controller + ChatView (cost/stats) | supported | Native Controller | ⚠️ 部分 |
| `/mcp` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/compact` | app-server | Stream 层 | supported | Stream 层 | ✅ 可用 |
| `/review` | app-server | Stream 层 | supported | Stream 层 | ✅ 可用 |
| `/init` | app-server | ChatView default → sendMessage | supported | Prompt 命令 | ⚠️ 部分 |
| `/fork` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/diff` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/agent` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/experimental` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/personality` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/ps` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/debug-config` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/skills` | app-server | Native Controller | supported | Native Controller | ✅ 可用 |
| `/apps` | app-server | Native Controller → ChatView fallback | supported | Native Controller | ⚠️ ChatView 覆盖了 native |
| `/clear` | fallback | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/fast` | fallback | 无处理 | supported | 待定义 | 🔇 菜单可见但无处理 |
| `/feedback` | fallback | ChatView switch/case | supported | Local UI | ⚠️ 仅显示提示 |
| `/help` | fallback | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/plan` | fallback | ChatView switch/case | supported | Local UI（模式切换） | ✅ 可用 |
| `/version` | fallback | 无处理 | supported | Local UI | 🔇 菜单可见但无处理 |
| `/history` | fallback | 无处理 | supported | Local UI | 🔇 菜单可见但无处理 |
| `/new` | fallback | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/resume` | fallback | ChatView switch/case | supported | Local UI | ⚠️ 仅打开侧边栏 |
| `/undo` | fallback | 无处理 | supported | Native Controller (rewindFiles) | 🔇 菜单可见但无处理 |
| `/search` | fallback | 无处理 | cli-only | CLI-only 提示 | 🔇 被 cli-only 拦截 |
| `/config` | fallback | ChatView switch/case | cli-only | Local UI（跳转设置） | ⚠️ 部分可用 |
| `/theme` | fallback | 无处理 | cli-only | CLI-only 提示 | 🔇 被 cli-only 拦截 |

### 4.3 Gemini 命令矩阵

> 来源: Gemini CLI BuiltinCommandLoader 动态加载  
> 动态加载: 38 个命令  
> Native Controller 处理: 15 个（`about`, `mcp`, `permissions`, `settings`, `auth`, `memory`, `agents`, `extensions`, `hooks`, `skills`, `tools`, `doctor`, `diff`, `model`, `init`）  
> Stream 处理: 0 个（**无 Gemini stream 文件**）

| 命令 | 来源 | 当前处理位置 | 可用性标记 | 应有处理方式 | 状态 |
|------|------|-------------|-----------|-------------|------|
| `/about` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/mcp` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/permissions` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/settings` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/auth` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/memory` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/agents` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/extensions` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/hooks` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/skills` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/tools` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/doctor` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/diff` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/model` | 动态加载 | Native Controller → ChatView fallback | supported | Native Controller | ✅ 可用 |
| `/init` | 动态加载 | Native Controller | supported | Native Controller | ✅ 可用 |
| `/help` | 动态加载 | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/clear` | 动态加载 | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/chat` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/copy` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/quit` | 动态加载 | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/plan` | 动态加载 | ChatView switch/case | supported | Local UI | ✅ 可用 |
| `/resume` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅打开侧边栏 |
| `/vim` | 动态加载 | ChatView switch/case | supported | CLI-only 提示 | ⚠️ 显示 "not supported" |
| `/stats` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 走 cost/stats 逻辑 |
| `/theme` | 动态加载 | 无处理 | supported | CLI-only 提示或 Local UI | 🔇 菜单可见但无处理 |
| `/bug` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/docs` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/privacy` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/setup-github` | 动态加载 | ChatView switch/case | supported | Local UI | ⚠️ 仅 ChatView 处理 |
| `/terminal-setup` | 动态加载 | ChatView switch/case | supported | CLI-only 提示 | ⚠️ 显示 "terminal only" |
| `/compress` | 动态加载 | 无处理 | supported | Prompt 命令（类似 compact） | 🔇 菜单可见但无处理 |
| `/commands` | 动态加载 | 无处理 | supported | Local UI（等同 /help） | 🔇 菜单可见但无处理 |
| `/corgi` | 动态加载 | 无处理 | supported | 彩蛋 / Local UI | 🔇 菜单可见但无处理 |
| `/directory` | 动态加载 | 无处理 | supported | Local UI 或 Native Controller | 🔇 菜单可见但无处理 |
| `/editor` | 动态加载 | 无处理 | supported | CLI-only 提示 | 🔇 菜单可见但无处理 |
| `/shortcuts` | 动态加载 | 无处理 | supported | Local UI | 🔇 菜单可见但无处理 |
| `/rewind` | 动态加载 | 无处理 | supported | Native Controller | 🔇 菜单可见但无处理 |
| `/ide` | 动态加载 | 无处理 | supported | CLI-only 提示 | 🔇 菜单可见但无处理 |
| `/policies` | 动态加载 | 无处理 | supported | Native Controller（等同 permissions） | 🔇 菜单可见但无处理 |
| `/profile` | 动态加载 | 无处理 | supported | Native Controller | 🔇 菜单可见但无处理 |
| `/shells` | 动态加载 | 无处理 | supported | CLI-only 提示 | 🔇 菜单可见但无处理 |

---

## 5. 非功能性需求

### 5.1 架构约束

1. **禁止在 ChatView 中硬编码命令列表**: 所有命令处理必须通过统一的 Command Dispatcher 路由，ChatView 只负责调用 dispatcher 并展示结果。
2. **统一命令分派器**: 必须有一个单入口 dispatcher，根据命令元数据决定执行路径。
3. **消除 page.tsx 与 ChatView.tsx 的重复**: 命令处理逻辑只存在于一处。

### 5.2 错误处理

1. **未知命令**: 显示 "未知命令" + 建议使用 `/help` 查看可用命令。
2. **CLI-only 命令**: 显示带引擎名称的友好消息，指引用户使用终端。
3. **需要 session 的命令**: 无 session 时显示 "请先发送一条消息启动会话"。
4. **后端不可达**: 显示 "命令执行器暂不可用，请检查后端服务状态"。

### 5.3 性能要求

1. 命令注册表缓存 TTL: 1 分钟（已实现）。
2. 命令路由决策: 纯前端操作，不增加额外 API 调用。
3. 后端命令响应: < 2 秒（CLI 二进制调用除外）。

### 5.4 兼容性

1. 旧的 `/api/chat/runtime-control` API 仍需保持向后兼容（legacy actions）。
2. 命令别名（如 `/quit` → `/exit`）必须继续工作。
3. interactive picker（模型选择、权限选择）的交互方式不变。

---

## 6. 统计摘要

| 指标 | Claude | Codex | Gemini |
|------|--------|-------|--------|
| 动态加载命令总数 | 39 | 29 | 38 |
| Native Controller 处理 | 9 | 13 | 15 |
| Stream 处理 | 2 | 2 | 0 |
| ChatView switch/case 处理 | ~18 | ~10 | ~12 |
| 完全无处理（🔇） | ~6 | ~5 | ~13 |
| 实际可用（✅） | ~15 | ~15 | ~17 |
| 部分可用（⚠️） | ~12 | ~6 | ~8 |

> Gemini 的问题最严重: 38 个动态命令中有约 13 个完全无处理，且没有 stream 层支持 `/compact` 和 `/review` 的等价命令（`/compress`）。
