# CLI 登录/认证管理 - 需求文档

> 文档 ID: CLI-LOGIN-REQ
> 创建日期: 2026-03-29
> 修订日期: 2026-03-29
> 状态: 草案（修订版 - OAuth 优先 + CLI-only 命令升级）
> 关联研究报告:
> - \`deep-research-report.md\`（Codex CLI 深度研究）
> - \`claude-geminideep-research-report.md\`（Claude CLI 与 Gemini CLI 深度研究）

---

## 1. 背景与现状

### 1.1 当前状态

CodePilot Settings 页面（\`src/components/settings/SettingsLayout.tsx\`）目前包含五个标签页：General、Providers、CLI Runtime、Remote Dev、Usage。其中：

- **Providers**（\`ProviderManager.tsx\`）：管理第三方 API 提供商（Anthropic、OpenRouter、GLM 等），用于 Claude 引擎的 API key 转发。这里管理的是「把 API key 注入到 CLI 子进程环境变量」的 Provider 模式，**不涉及 CLI 自身的登录认证**。

- **CLI Runtime**（\`CliSettingsSection.tsx\`）：读写各 CLI 的配置文件（\`~/.claude/settings.json\`、\`~/.codex/config.toml\`、\`~/.gemini/settings.json\`），提供表单和源码编辑两种模式。但**不提供登录/登出操作**，仅在提示区域显示一行静态的命令行提示（如 \`claude login\`、\`codex login\`）。

- **ConnectionStatus**（\`src/components/layout/ConnectionStatus.tsx\`）：轮询 \`/api/runtime-status\` 检测三个引擎的可用性/就绪状态，当引擎未就绪时弹出安装向导，提示用户到终端执行 \`claude login\`、\`codex login\`、\`gemini\` 等命令。

**核心痛点**：用户必须离开 GUI 打开终端才能完成 CLI 认证，GUI 中无法查看当前认证状态、无法发起 OAuth 流程、无法登出。这打断了用户的操作流，尤其对不熟悉命令行的用户造成较大使用障碍。

### 1.2 目标用户期望

用户期望在 Settings 页面内完成所有 CLI 认证管理操作：
- **通过 OAuth 账号登录（主要方式）**：用 Anthropic 账号、ChatGPT 账号、Google 账号直接登录，而不是手动粘贴 API key
- 直观看到每个 CLI 引擎的认证状态（已认证/未认证/已过期）
- 查看已存储的凭据信息（脱敏显示：账户邮箱、套餐类型）
- 从 GUI 执行登出操作
- 输入/更新 API key 作为备用认证方式

### 1.3 设计原则：OAuth 账号登录优先

**认证方式优先级**：
1. **OAuth 账号登录（主要）**：用户通过浏览器跳转，使用已有的平台账号直接登录
2. **API Key 输入（次要/备用）**：当 OAuth 不可用或用户偏好直接使用 API key 时

理由：
- 对普通用户而言，"用我的账号登录"比"去控制台找 API key 并粘贴"更直观
- OAuth 登录可自动获取 refresh token，免去手动管理 key 过期的问题
- 三个 CLI 官方都提供了成熟的 OAuth/浏览器登录流程：
  - Claude: \`claude login\` 启动 Anthropic OAuth 浏览器流程
  - Codex: \`codex login\` 启动 ChatGPT OAuth 浏览器流程
  - Gemini: \`gemini auth login\` 启动 Google OAuth 浏览器流程

---

## 2. 各 CLI 认证方式详述

### 2.1 Claude Code（\`claude\` CLI）

**来源证据**：
> Claude Code issue 中出现了 \`CLAUDE_CODE_OAUTH_TOKEN\` 与 \`ANTHROPIC_API_KEY\` 在不同系统下的优先级/钥匙串行为差异（macOS Keychain 前置导致 env var API key 可能被忽略）。
> — \`claude-geminideep-research-report.md\`，安全与鉴权影响要点

> 启动单个会话时会并发请求 \`https://api.anthropic.com/api/oauth/claude_cli/client_data\` 并触发 429，日志里直接打印了 URL 与状态。这类 \`/api/oauth/claude_cli/*\` 路径从命名直觉上更像产品 OAuth 客户端数据/能力探测接口。
> — \`claude-geminideep-research-report.md\`，Claude Code 自身的产品/会话/鉴权相关端点线索

> Claude 的公开 Messages API 在官方文档中给出明确端点与 headers（\`https://api.anthropic.com/v1/messages\`、\`x-api-key\`、\`anthropic-version\` 等）。
> — \`claude-geminideep-research-report.md\`，公开端点证据

> Claude Code CLI stores credentials in ~/.claude/ (via \`claude login\`), which the SDK subprocess can read — even without ANTHROPIC_API_KEY in env.
> — \`src/app/api/providers/models/route.ts\`，代码注释

**认证方式清单**（按优先级排列）：

| 优先级 | 方式 | 环境变量/存储位置 | 说明 |
|--------|------|------------------|------|
| **主要** | **Anthropic OAuth 登录** | \`~/.claude/.credentials.json\` 或 macOS Keychain | 通过 \`claude login\` 浏览器 OAuth 获得，UI 提供「Login with Anthropic Account」按钮触发。CLI 启动时会请求 \`api.anthropic.com/api/oauth/claude_cli/client_data\` 进行能力探测 |
| 次要 | API Key | \`ANTHROPIC_API_KEY\` 环境变量 | 直接使用 Anthropic API key，走 \`x-api-key\` header |

**OAuth 流程细节**（来自研究报告与 CLI 行为）：
- \`claude login\` 打开浏览器跳转到 Anthropic 控制台进行 OAuth 授权
- CLI 在本地启动回调服务器等待 OAuth 回调
- 获取到 token 后缓存到 \`~/.claude/.credentials.json\`（文件权限 0600）
- 通过 \`BROWSER=echo\` 环境变量可使 CLI 输出 URL 而非打开浏览器（headless 适配）

**当前代码中的引用**：
- \`src/app/api/providers/route.ts\`：\`detectEnvVars()\` 检测 \`ANTHROPIC_API_KEY\`、\`ANTHROPIC_AUTH_TOKEN\`、\`ANTHROPIC_BASE_URL\`
- \`src/lib/claude-persistent-client.ts\`：向子进程注入 \`ANTHROPIC_API_KEY\`
- \`src/app/api/providers/models/route.ts\`：注释提到 CLI 可通过 \`~/.claude/\` 中的凭据认证，无需 env var

**VPS 当前状态**：\`~/.claude/.credentials.json\` 文件存在（471 字节），说明已通过 OAuth 登录。

### 2.2 Codex CLI（\`codex\` CLI）

**来源证据**：
> 官方认证文档确认两种登录方式：ChatGPT 登录（浏览器 OAuth 回传访问令牌）与 API key 登录，并强调凭据缓存于 \`~/.codex/auth.json\` 或系统凭据库，且文件模式下应视为密码。
> — \`deep-research-report.md\`，鉴权方式与关键 Header 的证据

> 当认证模式是 ChatGPT（\`AuthMode::Chatgpt\`）时，默认 base_url 是 \`https://chatgpt.com/backend-api/codex\`；否则（例如 API key）默认 base_url 是 \`https://api.openai.com/v1\`。
> — \`deep-research-report.md\`，端点与基址的源码级证据

> 官方文档明确两种登录方式会落在不同的治理与数据处理策略下：ChatGPT 登录跟随 ChatGPT workspace 权限、RBAC、保留与驻留设置；API key 登录则跟随 API 组织的保留与数据共享设置。
> — \`deep-research-report.md\`，Token/Scope 与治理差异

**认证方式清单**（按优先级排列）：

| 优先级 | 方式 | 环境变量/存储位置 | 说明 |
|--------|------|------------------|------|
| **主要** | **ChatGPT OAuth 登录** | \`~/.codex/auth.json\`（明文 JSON） | 通过 \`codex login\` 浏览器 OAuth 登录 ChatGPT 账号，获取 id_token、access_token、refresh_token；UI 提供「Login with ChatGPT」按钮触发。走 \`chatgpt.com/backend-api/codex\` 端点 |
| 次要 | API Key | \`OPENAI_API_KEY\` 环境变量 | 直接使用 OpenAI API key，走 \`api.openai.com/v1\` 端点，\`Authorization: Bearer\` header |

**OAuth 流程细节**（来自研究报告与源码）：
- \`codex login\` 在 localhost 启动回调服务器
- 输出 ChatGPT 登录 URL 到 stdout
- 用户在浏览器中完成 ChatGPT 账号授权
- 回调后 CLI 获取 tokens 并写入 \`~/.codex/auth.json\`
- auth.json 结构：\`{ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }\`
- 支持自动 token 刷新
- 环境变量 \`CODEX_CA_CERTIFICATE\` 可用于自定义 CA（支持 mitmproxy 调试）

**当前代码中的引用**：
- \`src/lib/codex-app-server-client.ts\`：定义 \`CodexAppServerAccount\` 类型，区分 \`apiKey\` 和 \`chatgpt\`（含 email、planType）两种账户类型；\`readAccount()\` 方法可查询当前认证状态和是否需要 OpenAI 认证（\`requiresOpenaiAuth\`）
- \`src/app/api/runtime-status/route.ts\`："Codex SDK can run with ChatGPT login and does not require OPENAI_API_KEY to be considered ready."

**VPS 当前状态**：\`~/.codex/auth.json\` 存在（4341 字节），使用 ChatGPT 登录模式（\`auth_mode: "chatgpt"\`），关联 email: chuanxu48@gmail.com，planType: pro。

### 2.3 Gemini CLI（\`gemini\` CLI）

**来源证据**：
> Gemini CLI 的认证文档明确给出三大主路径与关键 env vars：API Key（\`GEMINI_API_KEY\`）、Vertex（\`GOOGLE_CLOUD_PROJECT\` + ADC）、Google 账号登录（浏览器 OAuth，凭据缓存到本地）。
> — \`claude-geminideep-research-report.md\`，复现网络调用

> 源码中 \`CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'\`、\`CODE_ASSIST_API_VERSION = 'v1internal'\`，用于 Google 账号登录后的 Code Assist OAuth 路径。
> — \`claude-geminideep-research-report.md\`，Code Assist 内部端点

> issue 中可见 OAuth 流的真实参数：\`redirect_uri\` 指向 localhost 随机端口的 \`/oauth2callback\`，并请求 \`cloud-platform\`、\`userinfo.email\`、\`userinfo.profile\` 等 scope，\`access_type=offline\` 表示可能会获得 refresh token。
> — \`claude-geminideep-research-report.md\`，OAuth 流参数

**认证方式清单**（按优先级排列）：

| 优先级 | 方式 | 环境变量/存储位置 | 说明 |
|--------|------|------------------|------|
| **主要** | **Google OAuth 登录** | \`~/.gemini/oauth_creds.json\` + \`~/.gemini/google_accounts.json\` | 通过 \`gemini auth login\` 浏览器 OAuth 登录 Google 账号；UI 提供「Login with Google Account」按钮触发。获得 access_token/refresh_token，走 Code Assist 内部端点 \`cloudcode-pa.googleapis.com/v1internal:*\` |
| 次要 | API Key | \`GEMINI_API_KEY\` 或 \`GOOGLE_API_KEY\` 环境变量 | 直接使用 Google AI API key，走 \`generativelanguage.googleapis.com\` 公开端点 |
| 次要 | Vertex AI（ADC） | \`GOOGLE_APPLICATION_CREDENTIALS\` / \`GOOGLE_CLOUD_PROJECT\` / \`GOOGLE_CLOUD_LOCATION\` | 使用 Application Default Credentials 或 Service Account key，走 \`{location}-aiplatform.googleapis.com\` 端点 |
| 辅助 | \`.gemini/.env\` 文件 | \`~/.gemini/.env\` | 可在此文件中设置上述环境变量，CLI 启动时自动加载 |

**OAuth 流程细节**（来自研究报告与源码）：
- \`gemini auth login\` 在 localhost 随机端口启动回调服务器
- 构造 OAuth authorize URL，scope 包括 \`cloud-platform\`、\`userinfo.email\`、\`userinfo.profile\`
- \`access_type=offline\` 确保获得 refresh token
- \`redirect_uri\` 指向 \`localhost:PORT/oauth2callback\`
- 用户在浏览器中完成 Google 账号授权
- 回调后 CLI 获取 tokens 写入 \`~/.gemini/oauth_creds.json\`
- 更新 \`~/.gemini/settings.json\` 中 \`security.auth.selectedType\` 为 \`"oauth-personal"\`

**当前代码中的引用**：
- \`src/app/api/runtime-status/route.ts\`：\`getGeminiSettingsAuthType()\` 读取 \`security.auth.selectedType\`；\`hasGeminiEnvAuth()\` 检测环境变量
- \`src/lib/agent/gemini-native-controller.ts\`：\`formatGeminiAuth()\` 读取并格式化认证状态
- \`src/lib/agent/gemini-engine.ts\`：向 CLI 子进程注入 \`GEMINI_API_KEY\`
- \`src/hooks/useNativeCommandController.ts\`：Gemini 原生命令列表包含 \`auth\`

**VPS 当前状态**：\`~/.gemini/settings.json\` 中 \`security.auth.selectedType: "oauth-personal"\`；\`~/.gemini/oauth_creds.json\` 存在（1779 字节）；\`~/.gemini/google_accounts.json\` 存在。

---

## 3. 功能需求

### 3.1 OAuth 账号登录（主要认证方式）

**FR-001**: Settings 页面应新增「Authentication」区段，按引擎展示当前认证状态，**OAuth 登录按钮放在最显眼的位置**。

**FR-002**: 提供三个 OAuth 登录按钮，按引擎分别呈现：

| 引擎 | 按钮文案 | OAuth 流程 | 回调机制 |
|------|---------|-----------|---------|
| Claude | 「Login with Anthropic Account」 | 打开浏览器跳转 Anthropic OAuth → CLI 本地回调服务器接收 token | \`claude login\` 子进程 + \`BROWSER=echo\` 捕获 URL |
| Codex | 「Login with ChatGPT」 | 打开浏览器跳转 ChatGPT OAuth → CLI 本地回调服务器接收 token | \`codex login\` 子进程 + stdout 捕获 URL |
| Gemini | 「Login with Google Account」 | 打开浏览器跳转 Google OAuth → CLI 本地回调服务器接收 token | \`gemini auth login\` 子进程 + stdout 捕获 URL |

**FR-003**: OAuth 流程状态反馈：
- 点击登录按钮后：显示 spinner + 「正在启动认证...」
- URL 就绪后：显示可点击的 OAuth URL（新窗口打开）+ 「请在浏览器中完成认证...」
- 认证成功后：自动更新状态卡片为「已认证」，显示账户邮箱和套餐类型
- 超时或失败时：显示错误信息和「重试」按钮

**FR-004**: 认证成功后的账户信息展示：
- Claude：认证方式标签（OAuth）、凭据文件最后修改时间
- Codex：邮箱（脱敏）、套餐类型（Pro/Plus/Team）、最后刷新时间
- Gemini：认证类型（oauth-personal）、关联 Google 账户信息

**FR-005**: Token 刷新与会话管理：
- 各 CLI 自身负责 token 刷新（不由 CodePilot 处理）
- 当 token 过期且 CLI 无法自动刷新时，状态显示为「已过期」并提示重新登录

### 3.2 认证状态展示

**FR-010**: 每个引擎的认证状态卡片应包含：
- 引擎名称和图标（Claude / Codex / Gemini）
- 状态徽章：\`Authenticated\`（绿色）、\`Expired\`（黄色）、\`Not Configured\`（灰色）、\`Error\`（红色）
- 认证方式标签（如 "Anthropic OAuth"、"ChatGPT Login"、"Google OAuth"、"API Key"）
- 关联账户信息（如 email，脱敏显示）
- 凭据最后更新时间

**FR-011**: 状态检测逻辑：
- Claude：检查 \`~/.claude/.credentials.json\` 是否存在且可读；检查 \`ANTHROPIC_API_KEY\` 环境变量
- Codex：通过 App Server 的 \`readAccount()\` 接口查询（已有实现）；检查 \`OPENAI_API_KEY\` 环境变量
- Gemini：读取 \`~/.gemini/settings.json\` 中的 \`security.auth.selectedType\`；检查 \`~/.gemini/oauth_creds.json\` 是否存在；检查 \`GEMINI_API_KEY\` / \`GOOGLE_API_KEY\` 环境变量

### 3.3 API Key 输入与管理（次要/备用）

**FR-020**: 每个引擎卡片应提供 API Key 输入表单，**位于 OAuth 登录按钮之下**，作为备用认证方式：
- Claude: \`ANTHROPIC_API_KEY\` 输入框
- Codex: \`OPENAI_API_KEY\` 输入框
- Gemini: \`GEMINI_API_KEY\` 输入框

**FR-021**: API Key 输入交互：
- 密码模式输入（默认遮罩）
- 「显示/隐藏」切换按钮
- 「保存」按钮将 key 写入对应的环境配置文件
- 「测试连接」按钮验证 key 有效性（可选：向对应 API 发送最小请求）

**FR-022**: API Key 存储策略：
- Claude：写入 Provider 系统（\`createProvider()\` / \`updateProvider()\`），因 \`claude-persistent-client.ts\` 已有注入逻辑
- Codex：写入 \`~/.codex/auth.json\` 的 \`OPENAI_API_KEY\` 字段，设 \`auth_mode: "api-key"\`
- Gemini：写入 \`~/.gemini/.env\` 文件

### 3.4 凭据查看与登出

**FR-030**: 已认证引擎应显示凭据摘要信息（脱敏）。

**FR-031**: 每个已认证引擎应提供「登出」按钮：
- Claude: 删除 \`~/.claude/.credentials.json\`，清除相关环境变量
- Codex: 删除 \`~/.codex/auth.json\` 或调用 Codex App Server 的登出方法
- Gemini: 删除 \`~/.gemini/oauth_creds.json\` 和 \`~/.gemini/google_accounts.json\`，重置 \`settings.json\` 中的 \`security.auth.selectedType\`

**FR-032**: 登出操作需要二次确认对话框。

### 3.5 与现有系统的集成

**FR-040**: 认证状态变化应触发 \`ConnectionStatus\` 组件刷新（通过 \`window.dispatchEvent(new Event("engine-changed"))\`）。

**FR-041**: 当引擎切换时，认证区域应同步切换展示对应引擎的状态。

**FR-042**: 与 Provider 系统的关系：
- Provider 系统管理的是「转发 API key 到 CLI 子进程」的中间层
- CLI 认证系统管理的是「CLI 自身的原生登录凭据」
- 两者可以共存；UI 中需要明确区分这两个概念

---

## 4. CLI-Only 命令升级需求

### 4.1 背景

当前 \`src/lib/command-registry/fallbacks.ts\` 中多个命令被标记为 \`availability: 'cli-only', execution: 'cli-only'\`，意味着它们在 GUI 中不可用。用户在 GUI 中输入这些命令时会被告知"仅限 CLI"，被迫切换到终端操作。

**设计原则**：尽可能多地将 cli-only 命令升级为 GUI 可用，仅保留真正无法在 GUI 中实现的命令。

### 4.2 CLI-Only 命令升级决策

**来源证据**：
> \`src/lib/command-registry/fallbacks.ts\` 中的 cli-only 命令清单（三个引擎的 fallback 数组）

#### 可升级到 GUI 的命令

| 命令 | 所属引擎 | 升级方案 | 在 GUI 中的实现 |
|------|---------|---------|----------------|
| \`/login\` | Claude | **升级为 OAuth 流程** | 在 Settings 认证区域提供「Login with Anthropic Account」按钮，触发 \`claude login\` 子进程 |
| \`/logout\` | Claude | **升级为登出操作** | 在 Settings 认证区域提供「Logout」按钮，清除凭据文件 |
| \`/config\` | Claude, Codex | **重定向到 Settings 页面** | 已有 Settings 页面可编辑所有配置。输入 \`/config\` 时自动跳转到 Settings 页面的 CLI Runtime 标签 |
| \`/theme\` | Gemini | **升级为主题切换** | 导航栏已有主题切换按钮（\`ThemeToggle\` 组件）。输入 \`/theme\` 时触发主题切换或跳转到 Settings > General |
| \`/ide\` | Gemini | **升级为 IDE 连接信息展示** | 在 Settings 或 About 区域显示当前 IDE 集成状态和连接信息 |

#### 必须保留 cli-only 的命令

| 命令 | 所属引擎 | 保留理由 |
|------|---------|---------|
| \`/vim\` | Claude, Gemini | 切换 vim 键位绑定，仅对终端 TUI 有意义。GUI 使用完全不同的编辑器交互模型 |
| \`/terminal-setup\` | Claude, Gemini | 安装终端集成（shell 补全、快捷键等），是纯终端环境配置，与 GUI 无关 |
| \`/editor\` | Gemini | 设置默认外部编辑器（如 vim、emacs），仅对 CLI 中调用外部编辑器的场景有意义 |
| \`/shells\` | Gemini | 配置 shell 集成（后台 shell 查看），是纯终端功能 |

### 4.3 升级后的命令注册要求

**FR-050**: 将 \`/login\` 从 \`cli-only\` 改为 \`supported\`，\`execution: 'immediate'\`。执行时：
- 如果在会话中输入，自动导航到 Settings > CLI Runtime > 认证区域
- 或直接在当前页面弹出 OAuth 登录流程（取决于 UI 设计）

**FR-051**: 将 \`/logout\` 从 \`cli-only\` 改为 \`supported\`，\`execution: 'immediate'\`。执行时：
- 弹出登出确认对话框
- 确认后清除对应引擎的凭据

**FR-052**: 将 \`/config\` 从 \`cli-only\` 改为 \`supported\`，\`execution: 'immediate'\`。执行时：
- 导航到 Settings > CLI Runtime 标签页

**FR-053**: 将 \`/theme\` 从 \`cli-only\` 改为 \`supported\`，\`execution: 'immediate'\`。执行时：
- 触发主题切换（亮/暗模式切换）
- 或导航到 Settings > General 中的主题设置

**FR-054**: 将 \`/ide\` 从 \`cli-only\` 改为 \`supported\`，\`execution: 'immediate'\`。执行时：
- 显示当前 IDE 集成信息（连接状态、IDE 类型等）

---

## 5. 安全需求

### 5.1 凭据存储安全

**SR-001**: API key 在传输过程中（前端 -> 后端 API -> 文件系统）全程通过 HTTPS。

**SR-002**: API key 在前端展示时必须默认遮罩，仅显示最后 4-8 个字符（与现有 \`maskApiKey()\` 函数一致）。

**SR-003**: API key 在 API 响应中不得返回完整明文。GET 状态接口只返回遮罩后的值。

**SR-004**: 凭据文件的文件权限应与各 CLI 原生设置保持一致：
- \`~/.claude/.credentials.json\`: mode 0600
- \`~/.codex/auth.json\`: mode 0600
- \`~/.gemini/oauth_creds.json\`: mode 0600

### 5.2 OAuth 安全

**SR-010**: OAuth 子进程在服务端运行，token 不经过前端。

**SR-011**: 前端只获取 auth_url 和最终的 status，不获取 token 内容。

**SR-012**: OAuth session 有 5 分钟 TTL，过期自动清理。

**SR-013**: 同一引擎同一时间只允许一个 OAuth session。

### 5.3 会话安全

**SR-020**: 所有凭据管理 API 端点必须经过 CodePilot 自身的 WebAuthn 认证保护。

**SR-021**: 敏感操作（写入 API key、登出）需要服务端验证当前 session 有效性。

### 5.4 日志与审计

**SR-030**: 凭据操作应记录审计日志（操作类型、引擎、时间戳），但不得记录凭据值本身。

**SR-031**: 错误日志中不得包含 token/key 的完整值。

---

## 6. 非功能需求

### 6.1 兼容性

**NFR-001**: 必须兼容 VPS Linux 环境（无 macOS Keychain、无 GUI 桌面环境用于 OAuth 浏览器自动打开）。OAuth 流程在 headless 环境下应降级为「显示 URL，用户手动在本地浏览器中打开」。

**NFR-002**: 必须兼容 Remote Dev 模式（当 \`workspaceMode === 'remote'\` 时，凭据操作应在远程主机上执行）。

### 6.2 性能

**NFR-010**: 认证状态查询应在 2 秒内返回结果。

**NFR-011**: 不应在每次页面加载时自动触发 token 刷新；仅在用户主动点击「刷新状态」或发起操作时检查。

### 6.3 国际化

**NFR-020**: 所有 UI 文案必须通过 \`useTranslation()\` 加载，支持中英文切换。

---

## 7. 验收标准

| 编号 | 验收条件 |
|------|---------|
| AC-01 | 用户在 Settings 页面能看到三个引擎各自的认证状态（绿色/黄色/灰色徽章） |
| AC-02 | **用户点击「Login with Anthropic Account」按钮后，能看到 OAuth URL，在浏览器中完成认证后状态自动更新为 Authenticated** |
| AC-03 | **用户点击「Login with ChatGPT」按钮后，能看到 OAuth URL，在浏览器中完成认证后状态显示 email 和 plan type** |
| AC-04 | **用户点击「Login with Google Account」按钮后，能看到 OAuth URL，在浏览器中完成认证后状态显示 oauth-personal** |
| AC-05 | 用户能在 GUI 中输入 API Key 作为备用认证方式，保存后引擎状态变为 Authenticated |
| AC-06 | 用户点击「登出」按钮后，二次确认，确认后对应引擎状态变为 Not Configured |
| AC-07 | API Key 在页面上以遮罩形式展示，不暴露完整值 |
| AC-08 | 在 Remote Dev 模式下，凭据操作在远程主机上执行 |
| AC-09 | Codex 引擎能正确显示 ChatGPT 登录的 email 和 plan 类型 |
| AC-10 | Gemini 引擎能正确显示当前认证类型（oauth-personal/api-key/vertex） |
| AC-11 | **在 GUI 中输入 \`/login\` 命令时，导航到认证区域或触发 OAuth 流程，而不是提示"仅限 CLI"** |
| AC-12 | **在 GUI 中输入 \`/logout\` 命令时，弹出登出确认对话框，而不是提示"仅限 CLI"** |
| AC-13 | **在 GUI 中输入 \`/config\` 命令时，导航到 Settings 页面，而不是提示"仅限 CLI"** |
| AC-14 | **在 GUI 中输入 \`/theme\` 命令时，切换主题，而不是提示"仅限 CLI"** |
| AC-15 | **OAuth 登录按钮在未认证状态下位于 API Key 输入框之上（视觉优先级更高）** |

---

## 8. 范围外（Out of Scope）

- Token 自动刷新逻辑（由各 CLI 自身处理）
- 多账户切换（仅支持当前活跃账户的管理）
- Vertex AI Service Account key 文件上传（仅支持环境变量方式）
- macOS Keychain 集成（Linux VPS 环境不需要）
- 修改现有 Provider 系统的核心逻辑
- 直接构造 OAuth URL（复用各 CLI 自身的 login 命令，不自行实现 OAuth 客户端）
