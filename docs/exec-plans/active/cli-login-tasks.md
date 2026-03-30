# CLI 登录/认证管理 - 任务分解文档

> 文档 ID: CLI-LOGIN-TASKS
> 创建日期: 2026-03-29
> 修订日期: 2026-03-29
> 状态: 草案（修订版 - OAuth 优先 + CLI-only 命令升级）
> 前置文档: \`cli-login-requirements.md\`、\`cli-login-architecture.md\`
> 关联研究报告:
> - \`deep-research-report.md\`（Codex CLI 深度研究）
> - \`claude-geminideep-research-report.md\`（Claude CLI 与 Gemini CLI 深度研究）

---

## 1. 阶段划分总览

| 阶段 | 名称 | 目标 | 预估工时 |
|------|------|------|---------|
| Phase 1 | 认证状态检测与展示 | 用户能在 Settings 页面看到各引擎认证状态 | 3-4天 |
| Phase 2 | OAuth 账号登录（核心） | 用户能通过浏览器 OAuth 登录三个平台账号 | 4-5天 |
| Phase 3 | API Key 管理（次要） | 用户能在 GUI 中输入/保存 API Key 作为备用 | 2-3天 |
| Phase 4 | 登出与凭据管理 | 用户能登出和查看凭据详情 | 1-2天 |
| Phase 5 | CLI-Only 命令升级 | 升级 /login、/logout、/config、/theme、/ide 到 GUI | 2-3天 |
| Phase 6 | Remote Dev 支持 | Remote 模式下在远程主机上执行凭据操作 | 2-3天 |
| Phase 7 | 集成测试与打磨 | 全流程测试、i18n、错误处理完善 | 2天 |

**总预估**: 16-23 天

---

## 2. Phase 1: 认证状态检测与展示

### T1.1 创建认证检测工具库

- **任务 ID**: T1.1
- **文件**: \`src/lib/cli-auth-utils.ts\`（新建）
- **复杂度**: 中
- **依赖**: 无
- **描述**: 创建可复用的认证状态检测函数，抽取并扩展现有逻辑

**实现要点**:
- 从 \`src/app/api/runtime-status/route.ts\` 中抽取 \`getGeminiSettingsAuthType()\` 和 \`hasGeminiEnvAuth()\`
- 从 \`src/app/api/providers/route.ts\` 中抽取 \`detectEnvVars()\` 的部分逻辑
- 新增 Claude 凭据文件检测（读取 \`~/.claude/.credentials.json\`）
- 新增 Codex auth.json 文件解析
- 新增通用工具函数：\`maskKey()\`、\`maskEmail()\`

**类型定义**:
\`\`\`typescript
type AuthStatus = "authenticated" | "expired" | "not-configured" | "error";
type AuthMethod = "oauth" | "api-key" | "chatgpt-login" | "vertex-adc" | null;

interface EngineAuthStatus {
  status: AuthStatus;
  auth_method: AuthMethod;
  account_info: {
    email?: string;
    plan_type?: string;
    auth_type_label?: string;
  } | null;
  masked_key?: string;
  last_updated?: string;
  detail?: string;
}
\`\`\`

**来源证据**:
> Codex auth.json 结构：\`{ auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }\`
> — VPS 实际文件 \`~/.codex/auth.json\` 内容验证

> Gemini settings.json 结构：\`{ security: { auth: { selectedType: "oauth-personal" } } }\`
> — VPS 实际文件验证 + \`src/app/api/runtime-status/route.ts\` 代码逻辑

### T1.2 创建认证状态 API 端点

- **任务 ID**: T1.2
- **文件**: \`src/app/api/cli-auth/status/route.ts\`（新建）
- **复杂度**: 中
- **依赖**: T1.1
- **描述**: 实现 \`GET /api/cli-auth/status\` 端点

**实现要点**:
- 支持 \`?engine=claude|codex|gemini\` 查询参数（可选，不传返回全部）
- 调用 T1.1 中的检测函数
- 对 Codex 尝试使用 App Server \`readAccount()\`，失败则降级到文件读取
- 所有敏感值必须脱敏
- 确保不返回完整 token/key 值

**Codex App Server 集成说明**:
> \`src/lib/codex-app-server-client.ts\` 已定义 \`readAccount()\` 方法，返回 \`{ account: CodexAppServerAccount | null, requiresOpenaiAuth: boolean }\`
> 其中 \`CodexAppServerAccount\` 为联合类型：\`{ type: 'apiKey' }\` 或 \`{ type: 'chatgpt', email: string, planType: string }\`

### T1.3 创建前端认证状态组件

- **任务 ID**: T1.3
- **文件**: \`src/components/settings/CliAuthSection.tsx\`（新建）
- **复杂度**: 中
- **依赖**: T1.2
- **描述**: 创建认证状态展示卡片组件

**实现要点**:
- 接收 \`engine\`、\`workspaceMode\`、\`remoteConnectionId\` props
- 调用 \`/api/cli-auth/status?engine=xxx\` 获取状态
- 渲染状态徽章（Badge 组件）
- 渲染认证方式标签（OAuth / ChatGPT Login / API Key）
- 渲染账户信息（email、plan type、auth type）
- 提供刷新按钮

### T1.4 集成到 CliSettingsSection

- **任务 ID**: T1.4
- **文件**: \`src/components/settings/CliSettingsSection.tsx\`（修改）
- **复杂度**: 低
- **依赖**: T1.3
- **描述**: 在现有 CLI Settings 中嵌入认证区域

**实现要点**:
- 在引擎切换按钮之下、配置编辑区之上插入 \`<CliAuthSection />\`
- 传递 \`activeEngine\`、\`workspaceMode\`、\`remoteConnectionId\`
- 简化现有运行时提示区域

### T1.5 添加 i18n 翻译键

- **任务 ID**: T1.5
- **文件**: \`src/i18n/\` 目录下的翻译文件（修改）
- **复杂度**: 低
- **依赖**: T1.3
- **描述**: 为认证 UI 添加中英文翻译

**翻译键列表**: 见 \`cli-login-architecture.md\` 第 7.6 节

---

## 3. Phase 2: OAuth 账号登录（核心）

### T2.1 创建 OAuth 会话管理器

- **任务 ID**: T2.1
- **文件**: \`src/lib/oauth-session-manager.ts\`（新建）
- **复杂度**: 高
- **依赖**: 无
- **描述**: 实现 OAuth 子进程管理、URL 提取、会话生命周期管理

**实现要点**:
- 使用 \`child_process.spawn\` 启动各 CLI 的 login 命令
- 设置 \`BROWSER=echo\` 环境变量，使 CLI 输出 URL 而非打开浏览器
- 从 stdout/stderr 中正则提取各平台的 OAuth authorize URL
- 管理会话状态：waiting -> url_ready -> completed/failed/expired
- 5 分钟超时自动 kill 子进程并清理
- 同一引擎同一时间只允许一个活跃 OAuth 会话
- 进程退出后验证凭据文件是否已写入

**各引擎 CLI 命令与 URL 提取**:

| 引擎 | 命令 | URL 匹配正则 | 凭据验证文件 |
|------|------|-------------|------------|
| Claude | \`claude login\` | \`/https?:\/\/(console\.anthropic\.com\|claude\.ai)[^\s'"]+/\` | \`~/.claude/.credentials.json\` |
| Codex | \`codex login\` | \`/https?:\/\/(auth\.openai\.com\|chatgpt\.com\|auth0\.openai\.com)[^\s'"]+/\` | \`~/.codex/auth.json\`（验证 auth_mode=chatgpt 且 tokens 非空） |
| Gemini | \`gemini auth login\` | \`/https?:\/\/accounts\.google\.com[^\s'"]+/\` | \`~/.gemini/oauth_creds.json\` |

**来源证据**:
> Codex login 会在 localhost 启动回调服务器、输出浏览器 URL 到 stdout、等待 OAuth 回调、写入 ~/.codex/auth.json
> — \`deep-research-report.md\`，鉴权方式

> Gemini auth login 的 \`redirect_uri\` 指向 localhost 随机端口的 \`/oauth2callback\`，并请求 \`cloud-platform\`、\`userinfo.email\`、\`userinfo.profile\` 等 scope
> — \`claude-geminideep-research-report.md\`，OAuth 流参数

> Claude Code issue 中出现 \`api.anthropic.com/api/oauth/claude_cli/client_data\` 端点
> — \`claude-geminideep-research-report.md\`，OAuth 相关端点

### T2.2 创建 OAuth API 端点

- **任务 ID**: T2.2
- **文件**: \`src/app/api/cli-auth/oauth/start/route.ts\`（新建）、\`src/app/api/cli-auth/oauth/poll/route.ts\`（新建）
- **复杂度**: 中
- **依赖**: T2.1
- **描述**: 实现 OAuth 发起和轮询端点

**POST /api/cli-auth/oauth/start**:
- 接收 \`{ engine }\` 请求体
- 调用 OAuthSessionManager 创建会话
- 返回 \`{ session_id, status, auth_url? }\`

**GET /api/cli-auth/oauth/poll**:
- 接收 \`?session_id=xxx\` 查询参数
- 查询会话状态
- 如果已完成，附带最新的认证状态（\`EngineAuthStatus\`）

### T2.3 创建 OAuth 登录按钮组件

- **任务 ID**: T2.3
- **文件**: \`src/components/settings/OAuthLoginButton.tsx\`（新建）
- **复杂度**: 中
- **依赖**: T2.2
- **描述**: 创建带状态反馈的 OAuth 登录按钮，按引擎显示不同文案

**实现要点**:
- 按钮文案按引擎区分：
  - Claude: 「Login with Anthropic Account」
  - Codex: 「Login with ChatGPT」
  - Gemini: 「Login with Google Account」
- 按钮点击后调用 POST /api/cli-auth/oauth/start
- 状态流转 UI：
  1. 初始：显示 OAuth 登录按钮（主要视觉权重）
  2. 等待中：显示 spinner + 「正在启动认证...」
  3. URL 就绪：显示可点击的 URL + 复制按钮 + 「正在等待浏览器完成认证...」
  4. 成功：显示绿色对勾 + 「认证成功」+ 自动刷新状态卡片
  5. 失败/超时：显示错误信息 + 重试按钮
- 2 秒间隔轮询 GET /api/cli-auth/oauth/poll
- 超时（5 分钟）后停止轮询并提示

### T2.4 集成 OAuth 按钮到 CliAuthSection（主要位置）

- **任务 ID**: T2.4
- **文件**: \`src/components/settings/CliAuthSection.tsx\`（修改）
- **复杂度**: 低
- **依赖**: T2.3, T1.3
- **描述**: 将 OAuth 按钮嵌入认证区域，**位于 API Key 输入之上**

**布局规则**:
- 未认证时：OAuth 按钮在上方，"— or use API Key —" 分隔符，API Key 表单在下方
- 已认证时：显示账户信息、"Re-login" 按钮、"Logout" 按钮

---

## 4. Phase 3: API Key 管理（次要）

### T3.1 创建 API Key 存储端点

- **任务 ID**: T3.1
- **文件**: \`src/app/api/cli-auth/api-key/route.ts\`（新建）
- **复杂度**: 中高
- **依赖**: T1.1
- **描述**: 实现 \`POST /api/cli-auth/api-key\` 和 \`DELETE /api/cli-auth/api-key\`

**POST 实现要点**:
- 接收 \`{ engine, api_key, validate? }\` 请求体
- 按引擎执行不同的存储逻辑：
  - **Claude**: 调用现有 Provider 系统 \`createProvider()\` 或 \`updateProvider()\`，写入 DB
  - **Codex**: 读取/创建 \`~/.codex/auth.json\`，设 \`auth_mode: "api-key"\`，写入 \`OPENAI_API_KEY\`，清空 \`tokens\`；chmod 0600
  - **Gemini**: 读取/创建 \`~/.gemini/.env\`，设置 \`GEMINI_API_KEY=xxx\`；更新 \`~/.gemini/settings.json\` 中 \`selectedType\` 为 \`"api-key"\`
- 可选验证：向对应 API 发送最小请求验证 key 有效性

**来源证据**:
> \`src/lib/claude-persistent-client.ts\`：\`sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;\`
> — 证明 Provider 系统的 API key 会被注入到 Claude CLI 子进程

### T3.2 API Key 验证逻辑

- **任务 ID**: T3.2
- **文件**: \`src/lib/cli-auth-utils.ts\`（扩展）
- **复杂度**: 中
- **依赖**: T3.1
- **描述**: 实现各引擎 API Key 的有效性验证

**验证方法**:
- **Claude**: \`POST https://api.anthropic.com/v1/messages\`，headers: \`x-api-key\`、\`anthropic-version\`
- **Codex**: \`GET https://api.openai.com/v1/models\`，header: \`Authorization: Bearer\`
- **Gemini**: \`GET https://generativelanguage.googleapis.com/v1beta/models?key=...\`

### T3.3 API Key 输入表单组件

- **任务 ID**: T3.3
- **文件**: \`src/components/settings/ApiKeyForm.tsx\`（新建）
- **复杂度**: 低
- **依赖**: T3.1
- **描述**: 创建 API Key 输入表单组件（位于 OAuth 按钮下方的次要位置）

**实现要点**:
- 密码模式 Input，带「显示/隐藏」切换
- 保存按钮（带 loading 状态）
- Key 格式前端预校验（Claude: \`sk-ant-\` 或 \`sk-\`；Codex: \`sk-\`；Gemini: \`AIza\`）
- 视觉层级：比 OAuth 按钮更低的权重（辅助颜色/尺寸）

### T3.4 集成 API Key 表单到 CliAuthSection（次要位置）

- **任务 ID**: T3.4
- **文件**: \`src/components/settings/CliAuthSection.tsx\`（修改）
- **复杂度**: 低
- **依赖**: T3.3, T2.4
- **描述**: 将 API Key 表单嵌入认证区域，位于 OAuth 按钮下方，用"— or use API Key —"分隔

---

## 5. Phase 4: 登出与凭据管理

### T4.1 创建登出 API 端点

- **任务 ID**: T4.1
- **文件**: \`src/app/api/cli-auth/logout/route.ts\`（新建）
- **复杂度**: 中
- **依赖**: T1.1
- **描述**: 实现 \`DELETE /api/cli-auth/logout\` 端点

**按引擎的登出操作**:

| 引擎 | 删除的文件/清除的配置 |
|------|---------------------|
| Claude | 1. \`fs.unlink('~/.claude/.credentials.json')\` 2. 可选：清除 Provider DB 中的 Anthropic API key |
| Codex | 1. \`fs.unlink('~/.codex/auth.json')\` 2. 或重写为空状态 |
| Gemini | 1. \`fs.unlink('~/.gemini/oauth_creds.json')\` 2. \`fs.unlink('~/.gemini/google_accounts.json')\` 3. 更新 \`settings.json\` 移除 \`selectedType\` 4. 删除 \`.env\` 中 \`GEMINI_API_KEY\` 行 |

### T4.2 创建登出按钮与确认对话框

- **任务 ID**: T4.2
- **文件**: \`src/components/settings/LogoutButton.tsx\`（新建）
- **复杂度**: 低
- **依赖**: T4.1
- **描述**: 创建登出按钮组件（含二次确认 AlertDialog）

### T4.3 凭据详情展示增强

- **任务 ID**: T4.3
- **文件**: \`src/components/settings/CliAuthSection.tsx\`（修改）
- **复杂度**: 低
- **依赖**: T1.3, T4.1
- **描述**: 增强认证状态卡片的账户信息展示

---

## 6. Phase 5: CLI-Only 命令升级

### T5.1 修改 fallbacks.ts 命令注册

- **任务 ID**: T5.1
- **文件**: \`src/lib/command-registry/fallbacks.ts\`（修改）
- **复杂度**: 低
- **依赖**: 无
- **描述**: 将可升级的 cli-only 命令改为 \`supported\` + \`immediate\`

**变更清单**:

| 命令 | 位置（行号） | 所属数组 | 变更 |
|------|------------|---------|------|
| \`/login\` | L79 | CLAUDE_FALLBACK_COMMANDS | \`availability: 'supported', execution: 'immediate'\` |
| \`/logout\` | L80 | CLAUDE_FALLBACK_COMMANDS | \`availability: 'supported', execution: 'immediate'\` |
| \`/config\` | L81 | CLAUDE_FALLBACK_COMMANDS | \`availability: 'supported', execution: 'immediate'\` |
| \`/config\` | L131 | CODEX_FALLBACK_COMMANDS | \`availability: 'supported', execution: 'immediate'\` |
| \`/theme\` | L187 | GEMINI_FALLBACK_COMMANDS | \`availability: 'supported', execution: 'immediate'\` |
| \`/ide\` | L185 | GEMINI_FALLBACK_COMMANDS | \`availability: 'supported', execution: 'immediate'\` |

**保持不变（继续 cli-only）**:
- \`/vim\` (L83, L188): 终端 TUI 专属
- \`/terminal-setup\` (L85, L189): 终端环境配置
- \`/editor\` (L184): 外部编辑器设置
- \`/shells\` (L186): 后台 shell 查看

### T5.2 实现 /login 命令的 GUI 执行逻辑

- **任务 ID**: T5.2
- **文件**: \`src/hooks/useNativeCommandController.ts\`（修改）或相关命令处理器
- **复杂度**: 中
- **依赖**: T5.1, T2.3（OAuth 按钮组件）
- **描述**: 在 GUI 中执行 \`/login\` 时触发 OAuth 登录流程

**实现要点**:
- 方案 A：导航到 Settings > CLI Runtime > 认证区域
  \`router.push('/settings?tab=cli-runtime&section=auth')\`
- 方案 B：在当前页面弹出 OAuth 登录对话框
  \`openOAuthDialog(currentEngine)\`
- 推荐方案 A，因为认证区域已有完整的状态展示和操作按钮

### T5.3 实现 /logout 命令的 GUI 执行逻辑

- **任务 ID**: T5.3
- **文件**: \`src/hooks/useNativeCommandController.ts\`（修改）
- **复杂度**: 低
- **依赖**: T5.1, T4.2（登出按钮组件）
- **描述**: 在 GUI 中执行 \`/logout\` 时弹出登出确认对话框

### T5.4 实现 /config 命令的 GUI 执行逻辑

- **任务 ID**: T5.4
- **文件**: \`src/hooks/useNativeCommandController.ts\`（修改）
- **复杂度**: 低
- **依赖**: T5.1
- **描述**: 在 GUI 中执行 \`/config\` 时导航到 Settings > CLI Runtime

**实现**：
\`\`\`typescript
case 'config':
  router.push('/settings?tab=cli-runtime');
  return { handled: true };
\`\`\`

### T5.5 实现 /theme 命令的 GUI 执行逻辑

- **任务 ID**: T5.5
- **文件**: \`src/hooks/useNativeCommandController.ts\`（修改）
- **复杂度**: 低
- **依赖**: T5.1
- **描述**: 在 GUI 中执行 \`/theme\` 时切换主题

**实现**：
\`\`\`typescript
case 'theme':
  // 复用 ThemeToggle 组件的逻辑
  const { setTheme, theme } = useTheme();
  setTheme(theme === 'dark' ? 'light' : 'dark');
  return { handled: true, message: \`Theme switched to \${newTheme}\` };
\`\`\`

### T5.6 实现 /ide 命令的 GUI 执行逻辑

- **任务 ID**: T5.6
- **文件**: \`src/hooks/useNativeCommandController.ts\`（修改）
- **复杂度**: 低
- **依赖**: T5.1
- **描述**: 在 GUI 中执行 \`/ide\` 时显示 IDE 集成信息

---

## 7. Phase 6: Remote Dev 支持

### T6.1 创建远程认证状态 API

- **任务 ID**: T6.1
- **文件**: \`src/app/api/remote/cli-auth/status/route.ts\`（新建）
- **复杂度**: 中
- **依赖**: T1.2
- **描述**: 通过 SSH 在远程主机上执行认证状态检测

### T6.2 创建远程 API Key 管理端点

- **任务 ID**: T6.2
- **文件**: \`src/app/api/remote/cli-auth/api-key/route.ts\`（新建）
- **复杂度**: 中
- **依赖**: T3.1, T6.1
- **描述**: 通过 SSH 在远程主机上写入/删除 API Key

### T6.3 创建远程 OAuth 登录端点

- **任务 ID**: T6.3
- **文件**: \`src/app/api/remote/cli-auth/oauth/route.ts\`（新建）
- **复杂度**: 高
- **依赖**: T2.2, T6.1
- **描述**: 在远程主机上发起 OAuth 登录

**特殊考虑**:
- 远程主机通常无浏览器，必须使用 headless 模式（\`BROWSER=echo\`）
- OAuth 回调的 redirect_uri 指向远程主机的 localhost，可能需要端口转发
- 或提示用户手动在本地浏览器打开 URL，完成后 CLI 自动捕获回调

### T6.4 创建远程登出端点

- **任务 ID**: T6.4
- **文件**: \`src/app/api/remote/cli-auth/logout/route.ts\`（新建）
- **复杂度**: 低
- **依赖**: T4.1, T6.1

### T6.5 前端 Remote 模式适配

- **任务 ID**: T6.5
- **文件**: \`src/components/settings/CliAuthSection.tsx\`（修改）
- **复杂度**: 中
- **依赖**: T6.1-T6.4
- **描述**: 当 \`workspaceMode === 'remote'\` 时，所有 API 调用切换到 \`/api/remote/cli-auth/*\`

---

## 8. Phase 7: 集成测试与打磨

### T7.1 端到端测试

- **任务 ID**: T7.1
- **复杂度**: 中
- **依赖**: Phase 1-5 全部完成
- **描述**: 全流程手动测试

**测试矩阵**:

| 测试场景 | Claude | Codex | Gemini |
|---------|--------|-------|--------|
| OAuth 登录 | 点击「Login with Anthropic Account」，完成浏览器 OAuth | 点击「Login with ChatGPT」，完成 ChatGPT 认证 | 点击「Login with Google Account」，完成 Google 认证 |
| OAuth 成功后状态 | 显示 Authenticated (OAuth) | 显示 email + plan type (ChatGPT Login) | 显示 oauth-personal |
| OAuth 超时 | 5 分钟不完成，验证超时处理 | 同上 | 同上 |
| API Key 保存 | 输入 ANTHROPIC_API_KEY，验证 Provider DB | 输入 OPENAI_API_KEY，验证 auth.json | 输入 GEMINI_API_KEY，验证 .env |
| 登出 | 清除 credentials 文件 | 清除 auth.json | 清除多个文件 |
| /login 命令 | 导航到认证区域，而不是 "仅限 CLI" | — | — |
| /logout 命令 | 弹出登出确认对话框 | — | — |
| /config 命令 | 导航到 Settings | 导航到 Settings | — |
| /theme 命令 | — | — | 切换主题 |
| /ide 命令 | — | — | 显示 IDE 信息 |

### T7.2 i18n 完善

- **任务 ID**: T7.2
- **复杂度**: 低
- **依赖**: T1.5
- **描述**: 完善所有翻译键的中英文文案，确保 OAuth 相关文案无遗漏

### T7.3 错误处理完善

- **任务 ID**: T7.3
- **复杂度**: 低
- **依赖**: Phase 1-5
- **描述**: 完善各种错误场景的用户提示

**错误场景清单**:
- CLI 未安装时的提示（仍可使用 API Key 方式）
- OAuth URL 提取失败（降级为提示手动执行 CLI login）
- OAuth 子进程启动失败
- 凭据文件权限不足
- API Key 格式不正确
- 网络请求超时
- Session 过期

### T7.4 UI 微调与一致性

- **任务 ID**: T7.4
- **复杂度**: 低
- **依赖**: Phase 1-5
- **描述**: 确保 UI 风格一致

**检查点**:
- OAuth 按钮视觉权重高于 API Key 输入（Primary 按钮 vs Outline 按钮）
- "— or use API Key —" 分隔符清晰
- 卡片边框和间距与现有风格一致
- Loading 状态使用 \`Loading02Icon\` 旋转动画
- 颜色使用 CSS 变量

---

## 9. 任务依赖关系图

\`\`\`
Phase 1 (状态检测)
  T1.1 cli-auth-utils ──────────┐
  T1.2 status API ──── T1.1 ───┤
  T1.3 CliAuthSection ── T1.2 ──┤
  T1.4 集成 ── T1.3             │
  T1.5 i18n ── T1.3             │
                                │
Phase 2 (OAuth 登录 - 核心)      │
  T2.1 OAuthSessionManager ────┤
  T2.2 OAuth API ──── T2.1 ────┤
  T2.3 OAuthLoginButton ── T2.2│
  T2.4 集成(主要位置) ── T2.3+T1.3
                                │
Phase 3 (API Key - 次要)         │
  T3.1 api-key API ──── T1.1 ──┤
  T3.2 验证逻辑 ──── T3.1      │
  T3.3 ApiKeyForm ──── T3.1 ───┤
  T3.4 集成(次要位置) ── T3.3+T2.4
                                │
Phase 4 (登出)                  │
  T4.1 logout API ──── T1.1 ───┤
  T4.2 LogoutButton ──── T4.1  │
  T4.3 详情增强 ──── T1.3      │
                                │
Phase 5 (CLI-only 升级)          │
  T5.1 fallbacks.ts 修改 ──────┤
  T5.2 /login GUI 逻辑 ── T5.1+T2.3
  T5.3 /logout GUI 逻辑 ── T5.1+T4.2
  T5.4 /config GUI 逻辑 ── T5.1│
  T5.5 /theme GUI 逻辑 ── T5.1 │
  T5.6 /ide GUI 逻辑 ── T5.1   │
                                │
Phase 6 (Remote)                │
  T6.1-T6.5 ──── Phase 1-4 ────┘

Phase 7 (测试)
  T7.1-T7.4 ──── Phase 1-6
\`\`\`

---

## 10. 安全审查清单

### 10.1 OAuth 安全

- [ ] OAuth token 不经过前端（仅通过子进程在服务端存储）
- [ ] OAuth session 有 5 分钟 TTL，过期自动清理
- [ ] 同一引擎同一时间只允许一个 OAuth session
- [ ] OAuth URL 提取使用严格的正则匹配
- [ ] 前端只获取 auth_url 和 status，不获取 token 内容

### 10.2 API Key 保护

- [ ] API Key 在 API 响应中始终被遮罩
- [ ] API Key 在前端 Input 中默认为 password 模式
- [ ] 凭据文件写入后立即设置 \`chmod 0600\`
- [ ] 日志中不包含完整的 token/key 值
- [ ] API Key 写入使用 atomic write

### 10.3 访问控制

- [ ] 所有 \`/api/cli-auth/*\` 端点经过 session 验证
- [ ] 登出操作需要二次确认
- [ ] 删除文件前检查路径在预期目录内（防止路径遍历）

---

## 11. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| CLI login 命令输出格式变化，URL 提取失败 | OAuth 流程不可用 | 中 | 使用宽松正则；降级为提示用户手动执行命令；同时检查 stdout 和 stderr |
| \`BROWSER=echo\` 在某些 CLI 版本不生效 | URL 无法被捕获 | 低 | 备选方案：使用 \`BROWSER=cat\` 或从 stderr 中提取 |
| headless 环境下 OAuth 回调 localhost 不通 | OAuth 流程失败 | 中 | 在 VPS 环境提示用户使用 API Key 方式或通过 SSH 端口转发 |
| Codex auth.json 格式变化 | 读写失败 | 低 | 写入前备份原文件；使用 JSON merge patch |
| 并发写入凭据文件导致损坏 | 凭据丢失 | 低 | 使用文件锁或 atomic write |

---

## 12. 新增/修改文件清单

### 新增文件

| 文件路径 | 说明 | Phase |
|---------|------|-------|
| \`src/lib/cli-auth-utils.ts\` | 认证检测工具库 | 1 |
| \`src/app/api/cli-auth/status/route.ts\` | 认证状态 API | 1 |
| \`src/components/settings/CliAuthSection.tsx\` | 认证 UI 主组件 | 1 |
| \`src/lib/oauth-session-manager.ts\` | OAuth 会话管理器 | 2 |
| \`src/app/api/cli-auth/oauth/start/route.ts\` | OAuth 发起 API | 2 |
| \`src/app/api/cli-auth/oauth/poll/route.ts\` | OAuth 轮询 API | 2 |
| \`src/components/settings/OAuthLoginButton.tsx\` | OAuth 登录按钮 | 2 |
| \`src/app/api/cli-auth/api-key/route.ts\` | API Key 管理 API | 3 |
| \`src/components/settings/ApiKeyForm.tsx\` | API Key 输入表单 | 3 |
| \`src/app/api/cli-auth/logout/route.ts\` | 登出 API | 4 |
| \`src/components/settings/LogoutButton.tsx\` | 登出按钮 | 4 |
| \`src/app/api/remote/cli-auth/status/route.ts\` | 远程认证状态 API | 6 |
| \`src/app/api/remote/cli-auth/api-key/route.ts\` | 远程 API Key API | 6 |
| \`src/app/api/remote/cli-auth/oauth/route.ts\` | 远程 OAuth API | 6 |
| \`src/app/api/remote/cli-auth/logout/route.ts\` | 远程登出 API | 6 |

### 修改文件

| 文件路径 | 修改内容 | Phase |
|---------|---------|-------|
| \`src/components/settings/CliSettingsSection.tsx\` | 嵌入 CliAuthSection 组件 | 1 |
| \`src/i18n/*.ts\` | 新增翻译键 | 1 |
| \`src/lib/command-registry/fallbacks.ts\` | 升级 cli-only 命令为 supported | 5 |
| \`src/hooks/useNativeCommandController.ts\` | 添加升级命令的 GUI 执行逻辑 | 5 |
