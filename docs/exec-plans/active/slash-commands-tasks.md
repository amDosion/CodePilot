# 斜杠命令系统改造 — 任务拆解文档

> **状态**: 规划中  
> **关联文档**:
> - [需求文档](./slash-commands-requirements.md)
> - [架构设计文档](./slash-commands-architecture.md)
> **日期**: 2026-03-29

---

## Phase 1: 审计与分类（无代码改动）

> 目标：对当前状态进行精确核实，确认需求文档中的命令矩阵准确无误。

### T1.1 验证命令注册表的完整性

- **ID**: T1.1
- **描述**: 对比三个引擎的动态加载命令列表与 fallbacks.ts 中的列表，确认是否有遗漏或多余条目。
- **涉及文件**:
  - `src/lib/command-registry/fallbacks.ts`（只读）
  - `src/lib/command-registry/claude-commands.ts`（只读）
  - `src/lib/command-registry/codex-commands.ts`（只读）
  - `src/lib/command-registry/gemini-commands.ts`（只读）
- **依赖**: 无
- **复杂度**: S
- **验收标准**: 输出一份差异报告，列出 fallback 中存在但动态加载中没有的命令，以及反向的差异。
- **测试方法**: 调用 `/api/runtime-commands?engine_type=xxx` 对比 fallbacks.ts 的命令名列表。

### T1.2 验证 Native Controller 覆盖范围

- **ID**: T1.2
- **描述**: 确认每个 native controller 的 `NATIVE_COMMAND_NAMES` 集合与其 switch/case 分支完全一致，没有声称处理但实际不处理的命令。
- **涉及文件**:
  - `src/lib/agent/claude-native-controller.ts`（只读）
  - `src/lib/agent/codex-native-controller.ts`（只读）
  - `src/lib/agent/gemini-native-controller.ts`（只读）
- **依赖**: 无
- **复杂度**: S
- **验收标准**: 报告确认 NATIVE_COMMAND_NAMES 与实际 case 分支完全匹配。
- **测试方法**: 用 grep 提取 case 分支名称与 NATIVE_COMMAND_NAMES 进行集合比较。

### T1.3 验证 ChatView switch/case 覆盖范围

- **ID**: T1.3
- **描述**: 列出 ChatView.tsx 和 page.tsx 中所有 switch/case 分支，标记哪些与 native controller 重复、哪些是纯 local UI 处理。
- **涉及文件**:
  - `src/components/chat/ChatView.tsx`（只读）
  - `src/app/chat/page.tsx`（只读）
- **依赖**: 无
- **复杂度**: S
- **验收标准**: 完整的 case 分支清单，标注每个 case 是否与 native controller 重叠。
- **测试方法**: 用 grep 提取所有 `case '/xxx'` 并与 T1.2 结果交叉比对。

### T1.4 验证 useNativeCommandController 的路由行为

- **ID**: T1.4
- **描述**: 确认 `useNativeCommandController` hook 的 `nativeCommandNames` 列表来源（API fetch vs fallback），以及当后端返回 `handled: false` 时的前端行为。
- **涉及文件**:
  - `src/hooks/useNativeCommandController.ts`（只读）
- **依赖**: 无
- **复杂度**: S
- **验收标准**: 文档化当前的命令拦截逻辑和 fallback 行为。
- **测试方法**: 代码审查 + 运行时在浏览器 DevTools 中验证。

### T1.5 标记所有 "🔇 菜单可见但无处理" 的命令

- **ID**: T1.5
- **描述**: 对需求文档中所有标记为 🔇 的命令逐一验证——在 GUI 中输入该命令，记录实际行为（是报错、静默忽略还是发送给 LLM）。
- **涉及文件**: 无（纯测试）
- **依赖**: T1.1, T1.2, T1.3
- **复杂度**: M
- **验收标准**: 每个 🔇 命令有对应的实际行为记录。
- **测试方法**: 在三个引擎的 GUI 会话中逐一输入命令并截图/记录。

---

## Phase 2: 构建统一命令分派器

> 目标：创建 Command Dispatcher 和 Local Command Handlers，但暂不替换 ChatView。

### T2.1 扩展 RuntimeCommandMetadata 类型

- **ID**: T2.1
- **描述**: 在 `execution` 字段中增加 `'stream'` 值，用于明确区分 stream 命令与其他 immediate 命令。更新 `commandMode` 类型定义以覆盖所有需要的模式。
- **涉及文件**:
  - `src/lib/runtime-command-catalog.ts`（修改 `execution` 类型定义）
  - `src/lib/command-registry/types.ts`（如果有独立类型定义）
- **依赖**: T1.1
- **复杂度**: S
- **验收标准**: TypeScript 编译通过，`execution` 类型包含 `'immediate' | 'prompt' | 'stream' | 'terminal' | 'cli-only'`。
- **测试方法**: `tsc --noEmit` 编译检查。

### T2.2 更新 fallbacks.ts 的 execution 字段

- **ID**: T2.2
- **描述**: 将 `compact` 和 `review` 的 `execution` 改为 `'stream'`。为每个缺失处理的命令设置正确的 `execution` 值（`'cli-only'`、`'prompt'` 或保持 `'immediate'`）。
- **涉及文件**:
  - `src/lib/command-registry/fallbacks.ts`
- **依赖**: T2.1
- **复杂度**: M
- **验收标准**: 所有命令的 `execution` 值与架构文档中的路由表一致。
- **测试方法**: 调用 `/api/runtime-commands` 验证每个命令的 `execution` 值。

### T2.3 创建 local-command-handlers.ts

- **ID**: T2.3
- **描述**: 提取 ChatView switch/case 中所有 Local UI 命令的处理逻辑到独立文件。每个命令是一个纯函数，接受 `LocalCommandContext` 返回 `LocalCommandResult`。
- **涉及文件**:
  - `src/lib/local-command-handlers.ts`（新建）
- **依赖**: T2.1
- **复杂度**: L
- **验收标准**:
  - 以下命令有对应的 handler: `clear`, `help`, `cost`, `stats`, `copy`, `exit`, `quit`, `new`, `plan`, `resume`, `chat`, `about`, `docs`, `feedback`, `bug`, `add-dir`, `privacy`, `setup-github`, `mention`, `sandbox-add-read-dir`, `version`, `history`, `commands`, `shortcuts`, `directory`, `corgi`
  - 每个 handler 是可单独测试的纯函数（不依赖 React state）
  - cli-only 处理也有统一的 handler
- **测试方法**: 单元测试每个 handler 的输入输出。

### T2.4 创建 command-dispatcher.ts

- **ID**: T2.4
- **描述**: 实现统一命令分派器，根据命令元数据的 `execution` 字段路由到对应执行层。
- **涉及文件**:
  - `src/lib/command-dispatcher.ts`（新建）
- **依赖**: T2.2, T2.3
- **复杂度**: L
- **验收标准**:
  - `dispatchCommand()` 函数能正确路由所有 6 层命令
  - Stream 命令调用 `onStartStream`
  - Native 命令调用 `/api/chat/native-command`
  - Local 命令调用对应的 local handler
  - CLI-only 命令显示标准化提示
  - Prompt 命令调用 `onSendMessage`
  - 未知命令返回 `{ handled: false }`
  - statePatch 通过 `onApplyStatePatch` 回调应用
- **测试方法**: 单元测试 dispatcher 的路由逻辑（mock 各回调函数）。

### T2.5 创建 statePatch 应用函数

- **ID**: T2.5
- **描述**: 提取 ChatView 中处理 `nativeDispatch.statePatch` 的逻辑为独立函数，供 dispatcher 调用。
- **涉及文件**:
  - `src/lib/command-dispatcher.ts`（或独立 helper）
- **依赖**: T2.4
- **复杂度**: M
- **验收标准**: statePatch 中的 `model`, `mode`, `reasoning_effort`, `provider_id`, `approval_policy` 都能正确应用到前端状态。
- **测试方法**: 单元测试各种 statePatch 组合。

---

## Phase 3: 迁移 ChatView switch/case 到 Dispatcher

> 目标：将 ChatView.tsx 中的硬编码命令处理逐步替换为 dispatcher 调用。

### T3.1 迁移 Stream 命令路由

- **ID**: T3.1
- **描述**: 将 ChatView 中 `compact` / `review` 的特殊判断逻辑迁入 dispatcher。ChatView 的 `handleCommand` 第一步就调用 dispatcher，不再自行判断 stream 命令。
- **涉及文件**:
  - `src/components/chat/ChatView.tsx`
  - `src/lib/command-dispatcher.ts`
- **依赖**: T2.4
- **复杂度**: M
- **验收标准**: `/compact` 和 `/review` 在 Claude、Codex 引擎中仍通过 stream 执行，行为不变。
- **测试方法**: 在 Claude 和 Codex 会话中执行 `/compact`，验证流式响应。

### T3.2 迁移 Native Controller 命令路由

- **ID**: T3.2
- **描述**: 将 ChatView 中 `dispatchNativeManagedCommand()` 的调用逻辑迁入 dispatcher。包括 forkRedirect 处理、statePatch 应用、interactive picker 构建。
- **涉及文件**:
  - `src/components/chat/ChatView.tsx`
  - `src/lib/command-dispatcher.ts`
- **依赖**: T3.1, T2.5
- **复杂度**: L
- **验收标准**:
  - `/model`（带参数和不带参数）行为不变，包括 interactive picker
  - `/permissions` 行为不变
  - `/fork`（Codex）行为不变，包括跳转新会话
  - 所有 native 命令的 statePatch 正确应用
- **测试方法**: 在三个引擎中逐一测试每个 native 命令。

### T3.3 迁移 Local UI 命令

- **ID**: T3.3
- **描述**: 移除 ChatView switch/case 中所有 Local UI 命令的处理逻辑，改由 dispatcher 调用 `local-command-handlers.ts` 中的 handler。
- **涉及文件**:
  - `src/components/chat/ChatView.tsx`
  - `src/lib/command-dispatcher.ts`
- **依赖**: T3.2
- **复杂度**: L
- **验收标准**:
  - ChatView 中不再有 switch/case 命令处理
  - 所有 local 命令行为与迁移前一致
  - `handleCommand` 函数缩减到 < 20 行
- **测试方法**: 逐一测试所有 local 命令：/clear, /help, /cost, /plan, /new, /exit, /copy, /resume 等。

### T3.4 迁移 CLI-only 命令处理

- **ID**: T3.4
- **描述**: 将 ChatView 中的 cli-only 判断逻辑迁入 dispatcher。统一所有 cli-only 命令的提示消息格式。
- **涉及文件**:
  - `src/components/chat/ChatView.tsx`
  - `src/lib/command-dispatcher.ts`
- **依赖**: T3.3
- **复杂度**: S
- **验收标准**: 所有 cli-only 命令显示一致的提示消息格式。
- **测试方法**: 输入 `/vim`, `/login`, `/terminal-setup` 等验证提示消息。

### T3.5 同步 page.tsx 的命令处理

- **ID**: T3.5
- **描述**: 将 `page.tsx` 中与 ChatView 重复的 switch/case 逻辑也替换为 dispatcher 调用。两个文件使用同一个 dispatcher 实例。
- **涉及文件**:
  - `src/app/chat/page.tsx`
  - `src/lib/command-dispatcher.ts`
- **依赖**: T3.3
- **复杂度**: M
- **验收标准**: `page.tsx` 中的 `handleCommand` 与 ChatView 的实现一致，不再有独立的 switch/case。
- **测试方法**: 通过 page.tsx 路径（直接 URL 访问）测试命令。

---

## Phase 4: 新增缺失命令的处理

> 目标：为标记为 🔇 的命令实现实际的处理逻辑。

### T4.1 Claude: 实现 /fork 命令

- **ID**: T4.1
- **描述**: 为 Claude 引擎实现对话分叉功能。参考 Codex 的 fork 实现（通过 app-server forkThread），Claude 可以通过复制当前会话消息到新会话来实现。
- **涉及文件**:
  - `src/lib/agent/claude-native-controller.ts`
- **依赖**: T3.2
- **复杂度**: M
- **验收标准**: `/fork` 在 Claude 会话中创建新会话并跳转，新会话包含原会话的消息历史。
- **测试方法**: 在 Claude 会话中执行 `/fork`，验证新会话创建和消息复制。

### T4.2 Claude: 实现 /undo 命令

- **ID**: T4.2
- **描述**: 为 Claude 引擎实现 undo 功能，调用 SDK 的 `rewindFiles()` 方法。
- **涉及文件**:
  - `src/lib/agent/claude-native-controller.ts`
- **依赖**: T3.2
- **复杂度**: M
- **验收标准**: `/undo` 在 Claude 会话中调用 `rewindFiles` 并显示结果。
- **测试方法**: 在 Claude 会话中做一些文件修改，然后执行 `/undo`。

### T4.3 Claude/Codex: 实现 /version 命令

- **ID**: T4.3
- **描述**: 在 local command handlers 中实现 `/version`，通过 `/api/runtime-status` 获取引擎版本信息。
- **涉及文件**:
  - `src/lib/local-command-handlers.ts`
- **依赖**: T2.3
- **复杂度**: S
- **验收标准**: `/version` 显示当前引擎的版本号。
- **测试方法**: 在各引擎中执行 `/version`。

### T4.4 Claude/Codex: 实现 /history 命令

- **ID**: T4.4
- **描述**: 在 local command handlers 中实现 `/history`，导航到会话历史页面或打开侧边栏。
- **涉及文件**:
  - `src/lib/local-command-handlers.ts`
- **依赖**: T2.3
- **复杂度**: S
- **验收标准**: `/history` 导航到历史页面或展示最近会话列表。
- **测试方法**: 执行 `/history` 验证导航行为。

### T4.5 Claude/Codex: 实现 /fast 命令

- **ID**: T4.5
- **描述**: 实现 `/fast` 命令用于切换输出模式（快速模式 vs 标准模式）。如果当前 GUI 没有对应概念，改为 cli-only 提示。
- **涉及文件**:
  - `src/lib/local-command-handlers.ts` 或 `src/lib/command-registry/fallbacks.ts`
- **依赖**: T2.3
- **复杂度**: S
- **验收标准**: `/fast` 有明确的行为——切换模式或显示 cli-only 提示。
- **测试方法**: 执行 `/fast` 验证行为。

### T4.6 Gemini: 实现缺失的 native 命令

- **ID**: T4.6
- **描述**: 为 Gemini native controller 新增以下命令处理: `profile`（读取 ~/.gemini/settings.json 中的 profile 配置）、`policies`（作为 `/permissions` 的别名路由）、`rewind`（读取/展示 rewind 信息或显示不支持提示）。
- **涉及文件**:
  - `src/lib/agent/gemini-native-controller.ts`
- **依赖**: T3.2
- **复杂度**: M
- **验收标准**: `/profile`、`/policies`、`/rewind` 在 Gemini 引擎中有明确响应。
- **测试方法**: 在 Gemini 会话中执行这三个命令。

### T4.7 Gemini: 实现 /compress 作为 prompt 命令

- **ID**: T4.7
- **描述**: 将 Gemini 的 `/compress` 命令路由为 prompt 命令（execution='prompt'），发送给 LLM 进行对话压缩。
- **涉及文件**:
  - `src/lib/command-registry/fallbacks.ts`（如果需要在 fallback 中补充 Gemini 的 compress 条目）
  - `src/lib/command-dispatcher.ts`
- **依赖**: T2.4
- **复杂度**: S
- **验收标准**: Gemini 会话中 `/compress` 被发送给 LLM 并产生响应。
- **测试方法**: 在 Gemini 会话中执行 `/compress`，验证 LLM 收到命令并返回压缩结果。

### T4.8 Gemini: 实现缺失的 local 命令

- **ID**: T4.8
- **描述**: 在 local command handlers 中为 Gemini 实现以下命令: `commands`（等同 /help）、`shortcuts`（显示快捷键列表）、`directory`（显示/设置工作目录）、`corgi`（彩蛋）。
- **涉及文件**:
  - `src/lib/local-command-handlers.ts`
- **依赖**: T2.3
- **复杂度**: M
- **验收标准**: 这四个命令在 Gemini 会话中有明确响应。
- **测试方法**: 逐一执行并验证输出。

### T4.9 Codex: 实现 /undo 命令

- **ID**: T4.9
- **描述**: 为 Codex 引擎实现 undo 功能。可能需要通过 app-server 的 API 或 git 操作来实现。
- **涉及文件**:
  - `src/lib/agent/codex-native-controller.ts`
- **依赖**: T3.2
- **复杂度**: M
- **验收标准**: `/undo` 在 Codex 会话中有明确响应（执行撤销或显示不支持提示）。
- **测试方法**: 在 Codex 会话中执行 `/undo`。

---

## Phase 5: 消除重复处理，强制单一来源

> 目标：确保每个命令只在一个位置处理，删除所有残留的重复逻辑。

### T5.1 移除 ChatView.tsx 中的 switch/case 残留

- **ID**: T5.1
- **描述**: 确认 ChatView.tsx 的 `handleCommand` 函数中不再有任何 switch/case 分支，所有逻辑由 dispatcher 处理。
- **涉及文件**:
  - `src/components/chat/ChatView.tsx`
- **依赖**: T3.3
- **复杂度**: S
- **验收标准**: `handleCommand` 函数体小于 20 行，只调用 `dispatchCommand()` 和 `handleUnknownCommand()`。
- **测试方法**: 代码审查 + grep 确认无 `case '/` 字符串。

### T5.2 移除 page.tsx 中的重复逻辑

- **ID**: T5.2
- **描述**: 确认 page.tsx 中的命令处理与 ChatView 完全共享 dispatcher，不再有独立实现。
- **涉及文件**:
  - `src/app/chat/page.tsx`
- **依赖**: T3.5
- **复杂度**: S
- **验收标准**: page.tsx 中无 switch/case 命令处理，grep `case '/` 返回空。
- **测试方法**: 代码审查 + grep。

### T5.3 统一 nativeCommandNames 来源

- **ID**: T5.3
- **描述**: 确保前端的 `nativeCommandNames` 与后端 controller 的 `NATIVE_COMMAND_NAMES` 完全一致。考虑通过 API 端点导出后端的 `NATIVE_COMMAND_NAMES`，而非在前端硬编码 `NATIVE_COMMANDS_FALLBACK`。
- **涉及文件**:
  - `src/hooks/useNativeCommandController.ts`
  - `src/app/api/chat/native-command/route.ts`（可选：新增 GET endpoint）
- **依赖**: T5.1
- **复杂度**: M
- **验收标准**: 前端 fallback 列表与后端 controller 的 NATIVE_COMMAND_NAMES 完全匹配，或 fallback 被移除（完全依赖 API 动态加载）。
- **测试方法**: 比对前后端的命令名列表。

### T5.4 修正可用性标记

- **ID**: T5.4
- **描述**: 更新 fallbacks.ts，将所有不应标记为 `supported` 但实际为 cli-only 的命令改正（如 Claude 的 `/copy` 在 fallback 中标为 `cli-only`，但 GUI 实际支持）。反之亦然。
- **涉及文件**:
  - `src/lib/command-registry/fallbacks.ts`
- **依赖**: T5.1
- **复杂度**: M
- **验收标准**: 每个命令的 `availability` 值与 GUI 中的实际行为一致。
- **测试方法**: 逐一执行 `/api/runtime-commands` 中的每个命令，验证 `availability` 与实际行为的匹配度。

### T5.5 清理 runtime-control 路由的命令转发逻辑

- **ID**: T5.5
- **描述**: `/api/chat/runtime-control/route.ts` 中的新式命令路由（`CLAUDE_NATIVE_COMMANDS` set）与 `/api/chat/native-command/route.ts` 功能重叠。评估是否可以将其简化为仅保留 legacy action 支持。
- **涉及文件**:
  - `src/app/api/chat/runtime-control/route.ts`
- **依赖**: T5.3
- **复杂度**: M
- **验收标准**: 如果简化，确保 legacy actions（supportedCommands, supportedModels 等）仍然工作。如果保留，文档化两个端点的职责边界。
- **测试方法**: 通过 curl 调用 legacy actions 验证兼容性。

---

## Phase 6: 测试与验证

> 目标：全面验证改造后的命令系统。

### T6.1 编写命令分派器单元测试

- **ID**: T6.1
- **描述**: 为 `command-dispatcher.ts` 编写单元测试，覆盖所有 6 个执行层的路由逻辑。
- **涉及文件**:
  - `src/lib/__tests__/command-dispatcher.test.ts`（新建）
- **依赖**: T2.4
- **复杂度**: M
- **验收标准**: 测试覆盖: stream 路由、native 路由、local 路由、cli-only 路由、prompt 路由、terminal 路由、未知命令处理。
- **测试方法**: `npm test` / `jest`。

### T6.2 编写 local command handlers 单元测试

- **ID**: T6.2
- **描述**: 为 `local-command-handlers.ts` 中的每个 handler 编写单元测试。
- **涉及文件**:
  - `src/lib/__tests__/local-command-handlers.test.ts`（新建）
- **依赖**: T2.3
- **复杂度**: M
- **验收标准**: 每个 local handler 至少有一个测试用例。
- **测试方法**: `npm test` / `jest`。

### T6.3 全引擎命令矩阵端到端验证

- **ID**: T6.3
- **描述**: 在三个引擎中逐一执行需求文档命令矩阵中的每个命令，记录实际行为是否与设计文档一致。
- **涉及文件**: 无（纯测试）
- **依赖**: T5.4
- **复杂度**: L
- **验收标准**: 所有命令的实际行为与架构文档路由表一致，无 🔇 状态命令残留。
- **测试方法**: 手动在 GUI 中测试，填写命令矩阵验证表。

### T6.4 回归测试: interactive picker

- **ID**: T6.4
- **描述**: 验证 `/model`（无参数）和 `/permissions`（无参数）的 interactive picker 在迁移后仍正常工作。
- **涉及文件**: 无（纯测试）
- **依赖**: T3.2
- **复杂度**: S
- **验收标准**: interactive picker 显示正确的选项列表，选择后正确触发 command-rerun 事件。
- **测试方法**: 在 Claude、Codex、Gemini 中执行 `/model` 和 `/permissions`，验证 picker 交互。

### T6.5 回归测试: statePatch 持久化

- **ID**: T6.5
- **描述**: 验证通过命令切换 model/mode 后，变更在刷新页面后仍然保持。
- **涉及文件**: 无（纯测试）
- **依赖**: T3.2
- **复杂度**: S
- **验收标准**: `/model xxx` → 刷新 → 模型仍为 xxx。 `/permissions plan` → 刷新 → 模式仍为 plan。
- **测试方法**: 执行命令 → 刷新页面 → 验证状态。

### T6.6 回归测试: stream 命令

- **ID**: T6.6
- **描述**: 验证 `/compact` 和 `/review` 在 Claude 和 Codex 中的流式执行行为不受影响。
- **涉及文件**: 无（纯测试）
- **依赖**: T3.1
- **复杂度**: S
- **验收标准**: 流式响应正常返回，无中断、无错误。
- **测试方法**: 在有对话历史的会话中执行 `/compact` 和 `/review`。

---

## 任务依赖关系图

```
Phase 1 (审计)
  T1.1 ──┐
  T1.2 ──┤
  T1.3 ──┼── T1.5
  T1.4 ──┘

Phase 2 (构建)
  T1.1 → T2.1 → T2.2
                   ↘
  T2.1 → T2.3 ───→ T2.4 → T2.5
  
Phase 3 (迁移)
  T2.4 → T3.1 → T3.2 → T3.3 → T3.4
  T2.5 → T3.2                    ↓
                            T3.3 → T3.5

Phase 4 (新增)
  T3.2 → T4.1 (Claude /fork)
  T3.2 → T4.2 (Claude /undo)
  T2.3 → T4.3 (/version)
  T2.3 → T4.4 (/history)
  T2.3 → T4.5 (/fast)
  T3.2 → T4.6 (Gemini native)
  T2.4 → T4.7 (Gemini /compress)
  T2.3 → T4.8 (Gemini local)
  T3.2 → T4.9 (Codex /undo)

Phase 5 (清理)
  T3.3 → T5.1
  T3.5 → T5.2
  T5.1 → T5.3
  T5.1 → T5.4
  T5.3 → T5.5

Phase 6 (测试)
  T2.4 → T6.1
  T2.3 → T6.2
  T5.4 → T6.3
  T3.2 → T6.4
  T3.2 → T6.5
  T3.1 → T6.6
```

---

## 复杂度统计

| 复杂度 | 任务数 | 任务 ID |
|--------|--------|---------|
| S (小) | 13 | T1.1, T1.2, T1.3, T1.4, T2.1, T3.4, T4.3, T4.4, T4.5, T4.7, T5.1, T5.2, T6.4, T6.5, T6.6 |
| M (中) | 14 | T1.5, T2.2, T2.5, T3.1, T3.5, T4.1, T4.2, T4.6, T4.8, T4.9, T5.3, T5.4, T5.5, T6.1, T6.2 |
| L (大) | 4 | T2.3, T2.4, T3.2, T3.3, T6.3 |

**建议执行顺序**: Phase 1 → Phase 2 → Phase 3 → Phase 4 和 Phase 6（T6.1, T6.2 可并行） → Phase 5 → Phase 6（T6.3-T6.6 最终验证）
