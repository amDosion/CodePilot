# CLI 登录/认证管理 - 架构设计文档

> 文档 ID: CLI-LOGIN-ARCH
> 创建日期: 2026-03-29
> 修订日期: 2026-03-29
> 状态: 草案（修订版 - OAuth 优先 + CLI-only 命令升级）
> 前置文档: \`cli-login-requirements.md\`
> 关联研究报告:
> - \`deep-research-report.md\`（Codex CLI 深度研究）
> - \`claude-geminideep-research-report.md\`（Claude CLI 与 Gemini CLI 深度研究）

---

## 1. 系统架构概览

### 1.1 整体架构图

\`\`\`
+------------------------------------------------------------------+
|                        前端 (React/Next.js)                        |
|                                                                    |
|  SettingsLayout                                                    |
|  +------------------------------------------------------------+   |
|  |  CliSettingsSection (已有)                                   |   |
|  |  +------------------------------------------------------+   |   |
|  |  | 引擎切换按钮: [Claude] [Codex] [Gemini]               |   |   |
|  |  +------------------------------------------------------+   |   |
|  |  |                                                      |   |   |
|  |  | CliAuthSection (新增)                                 |   |   |
|  |  | +--------------------------------------------------+ |   |   |
|  |  | | 认证状态卡片 + 账户信息                            | |   |   |
|  |  | |                                                  | |   |   |
|  |  | | [OAuth 登录按钮 - 主要]                           | |   |   |
|  |  | |   Login with Anthropic Account                   | |   |   |
|  |  | |   Login with ChatGPT                             | |   |   |
|  |  | |   Login with Google Account                      | |   |   |
|  |  | |                                                  | |   |   |
|  |  | | — or —                                           | |   |   |
|  |  | |                                                  | |   |   |
|  |  | | [API Key 输入 - 次要]                             | |   |   |
|  |  | |   [________API Key________] [Save]               | |   |   |
|  |  | |                                                  | |   |   |
|  |  | | [登出按钮]                                        | |   |   |
|  |  | +--------------------------------------------------+ |   |   |
|  |  |                                                      |   |   |
|  |  | 配置编辑区 (已有的 form/source 模式)                  |   |   |
|  |  +------------------------------------------------------+   |   |
|  +------------------------------------------------------------+   |
+------------------------------------------------------------------+
                              |
                    fetch / POST / DELETE
                              |
                              v
+------------------------------------------------------------------+
|                     后端 API (Next.js Route Handlers)              |
|                                                                    |
|  /api/cli-auth/status     GET    查询认证状态（含账户信息）         |
|  /api/cli-auth/api-key    POST   存储 API Key（次要方式）          |
|  /api/cli-auth/api-key    DELETE 删除 API Key                     |
|  /api/cli-auth/oauth/start POST  发起 OAuth 账号登录（主要方式）   |
|  /api/cli-auth/oauth/poll  GET   轮询 OAuth 完成状态               |
|  /api/cli-auth/logout     DELETE 清除凭据/登出                     |
+------------------------------------------------------------------+
                              |
              文件系统 / 子进程（CLI login 命令）
                              |
                              v
+------------------------------------------------------------------+
|                       凭据存储层                                    |
|                                                                    |
|  ~/.claude/.credentials.json   (Claude OAuth token)                |
|  ~/.codex/auth.json            (Codex ChatGPT token / API key)     |
|  ~/.gemini/oauth_creds.json    (Gemini OAuth token)                |
|  ~/.gemini/google_accounts.json (Gemini Google 账户)               |
|  ~/.gemini/settings.json       (Gemini auth type 配置)             |
|  ~/.gemini/.env                (Gemini API key 环境变量)            |
|  process.env.*                 (服务进程环境变量)                    |
+------------------------------------------------------------------+
\`\`\`

### 1.2 设计原则

1. **OAuth 优先**：UI 布局和交互流程中，OAuth 账号登录按钮始终位于 API Key 输入之上，是首选认证方式
2. **CLI 原生复用**：OAuth 流程通过 spawn 各 CLI 的 login 命令实现，不自行构造 OAuth URL 或实现 OAuth 客户端。理由：各 CLI 的 OAuth client_id、redirect_uri、scope 配置是内部实现，且可能随版本变更
3. **只读优先**：状态查询尽量通过读取文件和环境变量完成，避免不必要的子进程调用
4. **CLI 原生兼容**：凭据写入应与 CLI 自身的存储格式完全一致
5. **安全第一**：API 响应永远不返回完整凭据；OAuth token 不经过前端

---

## 2. OAuth 账号登录流程设计（核心）

### 2.1 通用 OAuth 流程架构

所有三个 CLI 的 OAuth 登录遵循相同的子进程代理模式：

\`\`\`
用户点击                    后端 API                       CLI 子进程
  |                           |                              |
  |  POST /oauth/start        |                              |
  |-------------------------->|                              |
  |                           |  spawn("cli login")          |
  |                           |  env: BROWSER=echo           |
  |                           |----------------------------->|
  |                           |                              |
  |                           |  stdout: OAuth URL           |
  |                           |<-----------------------------|
  |  { session_id, auth_url } |                              |
  |<--------------------------|                              |
  |                           |                              |
  |  用户在浏览器中完成认证    |                              |
  |  ...                      |                              |
  |                           |                              |
  |  GET /oauth/poll          |                              |
  |-------------------------->|                              |
  |                           |  检查子进程状态               |
  |                           |  + 检查凭据文件               |
  |                           |                              |
  |                           |  子进程退出码 0               |
  |                           |<-----------------------------|
  |                           |  凭据文件已写入               |
  |  { status: completed }    |                              |
  |<--------------------------|                              |
\`\`\`

**关键设计决策：使用 \`BROWSER=echo\` 环境变量**

三个 CLI 在执行 login 命令时都会尝试打开系统浏览器。在 headless VPS 环境下，通过设置 \`BROWSER=echo\`，CLI 会将 OAuth URL 输出到 stdout 而不是尝试打开浏览器。这使得后端可以捕获 URL 并推送给前端展示。

### 2.2 Claude OAuth 流程

**触发方式**：用户点击「Login with Anthropic Account」

**来源证据**：
> CLI 启动时会并发请求 \`https://api.anthropic.com/api/oauth/claude_cli/client_data\`
> — \`claude-geminideep-research-report.md\`，Claude Code 自身的产品/会话/鉴权相关端点线索

> 设置 \`BROWSER=echo\` 环境变量，迫使 CLI 输出 URL 而非尝试打开浏览器
> — \`claude-geminideep-research-report.md\`，Headless 环境特殊处理

\`\`\`
[POST /api/cli-auth/oauth/start]
body: { engine: "claude" }
        |
        v
+-- spawn("claude", ["login"]) --+
|   env: BROWSER=echo, NO_COLOR=1 |
|                                   |
|  监听 stdout/stderr:              |
|    匹配 URL 正则:                 |
|    /https?:\/\/(console\.anthropic\.com|claude\.ai)[^\s'"]+/
|                                   |
|  提取到 URL 后:                   |
|    session.authUrl = url          |
|    session.status = 'url_ready'   |
|                                   |
|  子进程退出后:                    |
|    exitCode 0 → 检查 ~/.claude/.credentials.json 是否新建/更新
|    exitCode !0 → 标记 failed，记录 stderr
+-----------------------------------+
\`\`\`

**OAuth URL 格式**（根据研究报告推断）：
- 域名可能是 \`console.anthropic.com\` 或 \`claude.ai\`
- 包含 OAuth 授权参数（client_id、redirect_uri 指向 localhost）

**Token 存储位置**：\`~/.claude/.credentials.json\`

**验证成功**：文件存在且大小 > 0，JSON 可解析

### 2.3 Codex OAuth 流程

**触发方式**：用户点击「Login with ChatGPT」

**来源证据**：
> Codex login 会在 localhost 启动回调服务器、输出浏览器 URL 到 stdout、等待 OAuth 回调、写入 ~/.codex/auth.json
> — \`deep-research-report.md\`，鉴权方式

> 官方认证文档提供了自定义 CA bundle 的环境变量：\`CODEX_CA_CERTIFICATE\`
> — \`deep-research-report.md\`，TLS 拦截

\`\`\`
[POST /api/cli-auth/oauth/start]
body: { engine: "codex" }
        |
        v
+-- spawn("codex", ["login"]) --+
|   env: BROWSER=echo, NO_COLOR=1|
|                                 |
|  Codex login 流程:              |
|  1. 在 localhost 启动回调服务器  |
|  2. 构造 ChatGPT OAuth URL     |
|  3. 输出 URL 到 stdout         |
|  4. 等待用户在浏览器中完成认证  |
|  5. 接收 OAuth 回调，获取 tokens|
|  6. 写入 ~/.codex/auth.json    |
|                                 |
|  监听 stdout:                   |
|    匹配 URL 正则:               |
|    /https?:\/\/(auth\.openai\.com|chatgpt\.com|auth0\.openai\.com)[^\s'"]+/
|                                 |
|  子进程退出后:                  |
|    验证 auth.json 是否更新      |
|    解析 auth_mode 和 account 信息|
+---------------------------------+
\`\`\`

**OAuth URL 格式**（根据 Codex 源码推断）：
- 域名可能是 \`auth.openai.com\` 或 \`chatgpt.com\`
- 包含 OAuth 授权参数

**Token 存储位置**：\`~/.codex/auth.json\`

**auth.json 结构**（已在 VPS 上验证）：
\`\`\`json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "eyJ...",
    "access_token": "eyJ...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-03-28T..."
}
\`\`\`

**成功后的账户信息**：通过 Codex App Server \`readAccount()\` 获取 email 和 planType。

### 2.4 Gemini OAuth 流程

**触发方式**：用户点击「Login with Google Account」

**来源证据**：
> issue 中可见 OAuth 流的真实参数：\`redirect_uri\` 指向 localhost 随机端口的 \`/oauth2callback\`，并请求 \`cloud-platform\`、\`userinfo.email\`、\`userinfo.profile\` 等 scope，\`access_type=offline\` 表示可能会获得 refresh token。
> — \`claude-geminideep-research-report.md\`，OAuth 流参数

> 源码中 \`CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'\`，\`CODE_ASSIST_API_VERSION = 'v1internal'\`
> — \`claude-geminideep-research-report.md\`，Code Assist 内部端点

\`\`\`
[POST /api/cli-auth/oauth/start]
body: { engine: "gemini" }
        |
        v
+-- spawn("gemini", ["auth", "login"]) --+
|   env: BROWSER=echo, NO_COLOR=1         |
|                                           |
|  Gemini auth login 流程:                  |
|  1. 在 localhost 随机端口启动回调服务器    |
|     redirect_uri = localhost:port/oauth2callback
|  2. 构造 Google OAuth URL:               |
|     scopes: cloud-platform,              |
|             userinfo.email,              |
|             userinfo.profile             |
|     access_type: offline                 |
|  3. 输出 URL 到 stdout                   |
|  4. 等待用户在浏览器中完成 Google 登录    |
|  5. 接收 OAuth 回调并获取 tokens          |
|  6. 写入 ~/.gemini/oauth_creds.json      |
|  7. 更新 settings.json 的 auth type       |
|                                           |
|  监听 stdout:                             |
|    匹配 URL 正则:                         |
|    /https?:\/\/accounts\.google\.com[^\s'"]+/
|                                           |
|  子进程退出后:                            |
|    验证 oauth_creds.json 是否新建/更新    |
|    验证 settings.json 的 selectedType     |
+-------------------------------------------+
\`\`\`

**OAuth URL 格式**（根据源码与 issue 确认）：
- 域名：\`accounts.google.com\`
- redirect_uri：\`http://localhost:PORT/oauth2callback\`
- scope：\`cloud-platform userinfo.email userinfo.profile\`
- access_type：\`offline\`

**Token 存储位置**：
- \`~/.gemini/oauth_creds.json\` — OAuth tokens
- \`~/.gemini/google_accounts.json\` — 关联的 Google 账户信息
- \`~/.gemini/settings.json\` — \`security.auth.selectedType: "oauth-personal"\`

**登录后的 API 端点**：
- 走 Code Assist 内部端点 \`cloudcode-pa.googleapis.com/v1internal:streamGenerateContent\`（非公开 API）
- 而非 API Key 模式下的 \`generativelanguage.googleapis.com\`

### 2.5 OAuthSessionManager 核心实现

\`\`\`typescript
// src/lib/oauth-session-manager.ts

interface OAuthSession {
  id: string;
  engine: 'claude' | 'codex' | 'gemini';
  child: ChildProcess;
  status: 'waiting' | 'url_ready' | 'completed' | 'failed' | 'expired';
  authUrl: string | null;
  startedAt: number;
  error?: string;
}

class OAuthSessionManager {
  private sessions = new Map<string, OAuthSession>();
  private readonly SESSION_TTL = 5 * 60 * 1000; // 5 分钟

  async startSession(engine: RuntimeEngine): Promise<OAuthStartResponse> {
    // 确保同一引擎只有一个活跃会话
    this.cancelExistingSession(engine);

    const sessionId = crypto.randomUUID();
    const cmd = this.getLoginCommand(engine);

    const child = spawn(cmd.binary, cmd.args, {
      env: {
        ...process.env,
        BROWSER: 'echo',    // 核心：输出 URL 而非打开浏览器
        NO_COLOR: '1',      // 清理终端颜色码
      },
    });

    // URL 提取正则（宽松匹配，兼容未来版本变更）
    const URL_PATTERNS = {
      claude: /https?:\/\/(console\.anthropic\.com|claude\.ai)[^\s'"]+/,
      codex: /https?:\/\/(auth\.openai\.com|chatgpt\.com|auth0\.openai\.com)[^\s'"]+/,
      gemini: /https?:\/\/accounts\.google\.com[^\s'"]+/,
    };

    child.stdout.on('data', (data) => {
      const match = data.toString().match(URL_PATTERNS[engine]);
      if (match) {
        session.authUrl = match[0];
        session.status = 'url_ready';
      }
    });

    child.stderr.on('data', (data) => {
      // stderr 也可能包含 URL（部分 CLI 输出到 stderr）
      const match = data.toString().match(URL_PATTERNS[engine]);
      if (match && !session.authUrl) {
        session.authUrl = match[0];
        session.status = 'url_ready';
      }
    });

    child.on('exit', async (code) => {
      if (code === 0) {
        // 验证凭据文件已写入
        const verified = await this.verifyCredentials(engine);
        session.status = verified ? 'completed' : 'failed';
      } else {
        session.status = 'failed';
      }
    });

    // 5 分钟超时
    setTimeout(() => {
      if (session.status !== 'completed' && session.status !== 'failed') {
        child.kill();
        session.status = 'expired';
      }
    }, this.SESSION_TTL);

    const session: OAuthSession = {
      id: sessionId, engine, child, status: 'waiting',
      authUrl: null, startedAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return { session_id: sessionId, status: 'waiting' };
  }

  private getLoginCommand(engine: RuntimeEngine) {
    switch (engine) {
      case 'claude': return { binary: 'claude', args: ['login'] };
      case 'codex':  return { binary: 'codex',  args: ['login'] };
      case 'gemini': return { binary: 'gemini', args: ['auth', 'login'] };
    }
  }

  private async verifyCredentials(engine: RuntimeEngine): Promise<boolean> {
    switch (engine) {
      case 'claude': return fs.existsSync(
        path.join(os.homedir(), '.claude', '.credentials.json'));
      case 'codex': {
        const authPath = path.join(os.homedir(), '.codex', 'auth.json');
        if (!fs.existsSync(authPath)) return false;
        const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        return content.auth_mode === 'chatgpt' && content.tokens != null;
      }
      case 'gemini': return fs.existsSync(
        path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
    }
  }
}
\`\`\`

---

## 3. API Key 存储流程设计（次要方式）

### 3.1 Claude API Key 存储

\`\`\`
[POST /api/cli-auth/api-key]
body: { engine: "claude", api_key: "sk-ant-..." }
        |
        v
+-- 验证 key 格式 (sk-ant-* 或 sk-*) --+
|                                         |
|  可选验证: POST https://api.anthropic.com/v1/messages
|    headers: x-api-key, anthropic-version: 2023-06-01
|    body: 最小请求 (max_tokens: 1)       |
|                                         |
|  存储: 与 Provider 系统集成             |
|    调用 createProvider() 或             |
|    updateProvider() 写入 DB             |
|                                         |
|  返回 { success, masked_key }           |
+-----------------------------------------+
\`\`\`

**推荐方案**：与现有 Provider 系统集成。理由：
1. ProviderManager 已有完善的 API key 管理 UI
2. \`claude-persistent-client.ts\` 已有从 Provider 注入 \`ANTHROPIC_API_KEY\` 的逻辑
3. 避免新建独立的 key 存储机制

**证据依据**：
> \`src/lib/claude-persistent-client.ts\` 第 441-443 行：\`sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;\`
> — 证明 Provider 系统的 API key 会被注入到 Claude CLI 子进程

### 3.2 Codex API Key 存储

\`\`\`
[POST /api/cli-auth/api-key]
body: { engine: "codex", api_key: "sk-..." }
        |
        v
+-- 读取 ~/.codex/auth.json (如果存在) --+
|   更新/创建:                              |
|   {                                       |
|     "auth_mode": "api-key",               |
|     "OPENAI_API_KEY": "sk-...",           |
|     "tokens": null,                       |
|     "last_refresh": null                  |
|   }                                       |
|   写入文件 (mode 0600)                    |
+-------------------------------------------+
\`\`\`

**注意**：从 ChatGPT 登录切换到 API Key 会改变数据处理策略（ChatGPT workspace 权限 vs API 组织权限），UI 中应对此做出提示。

### 3.3 Gemini API Key 存储

\`\`\`
[POST /api/cli-auth/api-key]
body: { engine: "gemini", api_key: "AIza..." }
        |
        v
+-- 写入 ~/.gemini/.env --+
|   读取现有 .env 内容       |
|   更新/新增 GEMINI_API_KEY |
|   写入文件                 |
|                           |
|   更新 ~/.gemini/settings.json:
|   security.auth.selectedType = "api-key"
+---------------------------+
\`\`\`

---

## 4. 认证状态检测设计

### 4.1 Claude 状态检测

\`\`\`
[GET /api/cli-auth/status?engine=claude]
        |
        v
+-- 读取 ~/.claude/.credentials.json --+
|                                        |
|  文件存在且可解析?                      |
|  +-- 是 --> 状态: authenticated        |
|  |   认证方式: oauth                   |
|  |   信息: "Anthropic OAuth" 标签      |
|  +-- 否 ------+                        |
|               |                        |
|  检查 process.env.ANTHROPIC_API_KEY    |
|  +-- 有值 --> 状态: authenticated      |
|  |   认证方式: api-key                 |
|  |   信息: ***后8位                    |
|  +-- 无值 --> 状态: not-configured     |
+----------------------------------------+
\`\`\`

### 4.2 Codex 状态检测

\`\`\`
[GET /api/cli-auth/status?engine=codex]
        |
        v
+-- 优先使用 App Server readAccount() --+
|                                         |
|  App Server 可用?                       |
|  +-- 是 --> 调用 readAccount()          |
|  |   account.type === "chatgpt"         |
|  |     --> authenticated (chatgpt-login)|
|  |     info: email, planType            |
|  |   account.type === "apiKey"          |
|  |     --> authenticated (api-key)      |
|  |   requiresOpenaiAuth === true        |
|  |     --> not-configured               |
|  +-- 否 ------+                         |
|               |                         |
|  降级: 直接读取 ~/.codex/auth.json      |
|  +-- 文件存在且 auth_mode 有值          |
|  |   --> 解析 auth_mode 和 tokens       |
|  +-- 否 --> 检查 OPENAI_API_KEY env     |
+-----------------------------------------+
\`\`\`

### 4.3 Gemini 状态检测

\`\`\`
[GET /api/cli-auth/status?engine=gemini]
        |
        v
+-- 多源检测 --+
|               |
|  1. 读取 ~/.gemini/settings.json
|     security.auth.selectedType
|     +-- "oauth-personal" --> 检查 oauth_creds.json
|     +-- "api-key" --> 检查 GEMINI_API_KEY env
|     +-- "vertex" --> 检查 ADC 环境变量
|     +-- 空/不存在 --> not-configured
|               |
|  2. 如果 selectedType 为 oauth:
|     读取 ~/.gemini/oauth_creds.json
|     读取 ~/.gemini/google_accounts.json
|     提取: email, token 过期时间
|               |
|  3. 如果无 selectedType:
|     检查环境变量:
|     GEMINI_API_KEY, GOOGLE_API_KEY,
|     GOOGLE_APPLICATION_CREDENTIALS
+---------------+
\`\`\`

---

## 5. API 端点详细设计

### 5.1 GET /api/cli-auth/status

**路径**: \`src/app/api/cli-auth/status/route.ts\`

**响应结构**:
\`\`\`typescript
interface CliAuthStatusResponse {
  engines: {
    claude: EngineAuthStatus;
    codex: EngineAuthStatus;
    gemini: EngineAuthStatus;
  };
}

interface EngineAuthStatus {
  status: "authenticated" | "expired" | "not-configured" | "error";
  auth_method: "oauth" | "api-key" | "chatgpt-login" | "vertex-adc" | null;
  account_info: {
    email?: string;         // 脱敏: ch***48@gmail.com
    plan_type?: string;     // "pro", "plus", "team"
    auth_type_label?: string; // "Anthropic OAuth", "ChatGPT Login", "Google OAuth"
  } | null;
  masked_key?: string;      // "***xxxxxxxx"
  last_updated?: string;    // ISO timestamp
  detail?: string;
}
\`\`\`

### 5.2 POST /api/cli-auth/oauth/start

**路径**: \`src/app/api/cli-auth/oauth/start/route.ts\`

**请求体**:
\`\`\`typescript
interface OAuthStartRequest {
  engine: "claude" | "codex" | "gemini";
}
\`\`\`

**响应**:
\`\`\`typescript
interface OAuthStartResponse {
  session_id: string;
  auth_url?: string;
  status: "waiting" | "url_ready" | "error";
  message?: string;
}
\`\`\`

### 5.3 GET /api/cli-auth/oauth/poll

**路径**: \`src/app/api/cli-auth/oauth/poll/route.ts\`

**响应**:
\`\`\`typescript
interface OAuthPollResponse {
  status: "waiting" | "url_ready" | "completed" | "failed" | "expired";
  auth_url?: string;   // 当 status 为 url_ready 时返回
  auth_status?: EngineAuthStatus;  // 当 status 为 completed 时返回最新认证状态
  error?: string;
}
\`\`\`

**前端轮询策略**: 每 2 秒轮询一次，最多 150 次（5 分钟）。

### 5.4 POST /api/cli-auth/api-key

**请求体**:
\`\`\`typescript
interface SetApiKeyRequest {
  engine: "claude" | "codex" | "gemini";
  api_key: string;
  validate?: boolean; // 默认 true
}
\`\`\`

**存储策略汇总**:

| 引擎 | 存储目标 | 格式 | 原因 |
|------|---------|------|------|
| Claude | Provider 系统 SQLite DB | \`createProvider()\` / \`updateProvider()\` | 现有 Provider 已处理注入逻辑 |
| Codex | \`~/.codex/auth.json\` | \`{ auth_mode: "api-key", OPENAI_API_KEY: "..." }\` | 与 CLI 原生格式一致 |
| Gemini | \`~/.gemini/.env\` + \`settings.json\` | \`.env\` + \`selectedType: "api-key"\` | CLI 原生支持 .env 加载 |

### 5.5 DELETE /api/cli-auth/logout

**登出操作汇总**:

| 引擎 | 操作 |
|------|------|
| Claude | 删除 \`~/.claude/.credentials.json\`；可选清除 Provider DB 中的 key |
| Codex | 删除 \`~/.codex/auth.json\`；或通过 App Server 发送登出命令 |
| Gemini | 删除 \`oauth_creds.json\` + \`google_accounts.json\`；更新 \`settings.json\` 移除 \`selectedType\`；删除 \`.env\` 中 \`GEMINI_API_KEY\` 行 |

---

## 6. CLI-Only 命令升级架构

### 6.1 命令注册变更

**来源证据**：
> \`src/lib/command-registry/fallbacks.ts\` 中的 cli-only 命令分布：
> - Claude fallback (line 79-85): login, logout, config, vim, terminal-setup
> - Codex fallback (line 131): config
> - Gemini fallback (line 184-189): editor, ide, shells, theme, vim, terminal-setup

**变更清单**：

| 命令 | 所属引擎 | 变更前 | 变更后 | 执行逻辑 |
|------|---------|--------|--------|---------|
| \`/login\` | Claude | \`cli-only\` | \`supported\`, \`immediate\` | 导航到 Settings 认证区域或触发 OAuth 弹窗 |
| \`/logout\` | Claude | \`cli-only\` | \`supported\`, \`immediate\` | 弹出登出确认对话框 |
| \`/config\` | Claude, Codex | \`cli-only\` | \`supported\`, \`immediate\` | 导航到 Settings > CLI Runtime |
| \`/theme\` | Gemini | \`cli-only\` | \`supported\`, \`immediate\` | 触发主题切换 |
| \`/ide\` | Gemini | \`cli-only\` | \`supported\`, \`immediate\` | 显示 IDE 集成信息 |
| \`/vim\` | Claude, Gemini | 保持 \`cli-only\` | — | 终端 TUI 专属功能 |
| \`/terminal-setup\` | Claude, Gemini | 保持 \`cli-only\` | — | 终端环境配置 |
| \`/editor\` | Gemini | 保持 \`cli-only\` | — | 外部编辑器设置 |
| \`/shells\` | Gemini | 保持 \`cli-only\` | — | 后台 shell 查看 |

### 6.2 命令执行处理器

升级后的命令需要在 \`useNativeCommandController.ts\` 或相关处理器中添加 GUI 执行逻辑：

\`\`\`typescript
// 命令升级的执行逻辑
function handleUpgradedCommand(command: string, engine: string) {
  switch (command) {
    case 'login':
      // 方案 A: 导航到 Settings 认证区域
      router.push('/settings?tab=cli-runtime&section=auth');
      // 方案 B: 在当前页面弹出 OAuth 流程
      openOAuthDialog(engine);
      break;

    case 'logout':
      // 弹出登出确认对话框
      openLogoutConfirmDialog(engine);
      break;

    case 'config':
      // 导航到 Settings > CLI Runtime
      router.push('/settings?tab=cli-runtime');
      break;

    case 'theme':
      // 触发主题切换
      toggleTheme();
      break;

    case 'ide':
      // 显示 IDE 集成信息
      showIdeInfo();
      break;
  }
}
\`\`\`

### 6.3 fallbacks.ts 修改示例

\`\`\`typescript
// Claude fallback: /login 升级
- { name: 'login', description: 'Log in to Claude', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
+ { name: 'login', description: 'Log in to Claude', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },

// Claude fallback: /logout 升级
- { name: 'logout', description: 'Log out of Claude', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
+ { name: 'logout', description: 'Log out of Claude', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },

// Claude & Codex fallback: /config 升级
- { name: 'config', description: 'View or update settings', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
+ { name: 'config', description: 'View or update settings', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },

// Gemini fallback: /theme 升级
- { name: 'theme', description: 'Change color theme', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
+ { name: 'theme', description: 'Change color theme', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },

// Gemini fallback: /ide 升级
- { name: 'ide', description: 'Set IDE integration', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
+ { name: 'ide', description: 'Set IDE integration', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
\`\`\`

---

## 7. 前端 UI 设计

### 7.1 组件结构

\`\`\`
CliSettingsSection.tsx (已有，修改)
  |-- 引擎切换按钮 (已有)
  |-- CliAuthSection.tsx (新增)
  |     |-- AuthStatusCard (认证状态 + 账户信息)
  |     |-- OAuthLoginButton.tsx (新增 - 最显眼位置)
  |     |     |-- 「Login with [Platform] Account」按钮
  |     |     |-- OAuthProgress (等待中 UI: URL 展示 + spinner)
  |     |-- ApiKeyForm.tsx (新增 - "或" 分隔符之下)
  |     |     |-- PasswordInput + 保存按钮
  |     |-- LogoutButton.tsx (新增)
  |           |-- ConfirmDialog (二次确认)
  |-- 配置编辑区 (已有 Tabs form/source)
\`\`\`

### 7.2 未认证状态 UI（OAuth 优先布局）

\`\`\`
+------------------------------------------------------------------+
| Authentication                                          [Refresh] |
+------------------------------------------------------------------+
|                                                                    |
|  [Gray] Not Configured                                            |
|                                                                    |
|  +----------------------------------+                             |
|  |  Login with ChatGPT (Browser)    |  <-- 主要方式，显眼按钮     |
|  +----------------------------------+                             |
|                                                                    |
|  — or use API Key —                                               |
|                                                                    |
|  +-----------------------------------+                            |
|  | OPENAI_API_KEY                    |  [Save]  <-- 次要方式      |
|  | ******************************** |                              |
|  +-----------------------------------+                            |
|                                                                    |
+------------------------------------------------------------------+
\`\`\`

### 7.3 已认证状态 UI

\`\`\`
+------------------------------------------------------------------+
| Authentication                                          [Refresh] |
+------------------------------------------------------------------+
|                                                                    |
|  [Green] Authenticated via ChatGPT Login                          |
|                                                                    |
|  Account:  ch***48@gmail.com                                      |
|  Plan:     Pro                                                    |
|  Updated:  2026-03-28 10:49                                       |
|                                                                    |
|  +------------------+  +--------+                                 |
|  | Re-login (OAuth) |  | Logout |                                 |
|  +------------------+  +--------+                                 |
|                                                                    |
+------------------------------------------------------------------+
\`\`\`

### 7.4 OAuth 等待中 UI

\`\`\`
+------------------------------------------------------------------+
| Authentication                                                    |
+------------------------------------------------------------------+
|                                                                    |
|  [Spinner] Waiting for browser authentication...                  |
|                                                                    |
|  Open this URL in your browser:                                   |
|  +--------------------------------------------------------------+|
|  | https://chatgpt.com/auth?client_id=...&redirect_uri=...      ||
|  +--------------------------------------------------------------+|
|  [Copy URL]                                                       |
|                                                                    |
|  The page will automatically update once authentication           |
|  is complete.                                          [Cancel]   |
|                                                                    |
+------------------------------------------------------------------+
\`\`\`

### 7.5 状态徽章映射

| 状态 | 颜色 | 文案（中文） | 文案（英文） |
|------|------|-------------|-------------|
| authenticated | 绿色 \`bg-green-500/10 text-green-600\` | 已认证 | Authenticated |
| expired | 黄色 \`bg-yellow-500/10 text-yellow-600\` | 已过期 | Expired |
| not-configured | 灰色 \`bg-muted text-muted-foreground\` | 未配置 | Not Configured |
| error | 红色 \`bg-red-500/10 text-red-600\` | 错误 | Error |

### 7.6 i18n 键值规划

\`\`\`typescript
"cli.auth.title": "Authentication" / "认证管理"
"cli.auth.status.authenticated": "Authenticated" / "已认证"
"cli.auth.status.expired": "Expired" / "已过期"
"cli.auth.status.notConfigured": "Not Configured" / "未配置"
"cli.auth.status.error": "Error" / "错误"
"cli.auth.method.oauth": "Anthropic OAuth" / "Anthropic OAuth 登录"
"cli.auth.method.chatgptLogin": "ChatGPT Login" / "ChatGPT 登录"
"cli.auth.method.googleOAuth": "Google OAuth" / "Google OAuth 登录"
"cli.auth.method.apiKey": "API Key" / "API Key"
"cli.auth.method.vertexAdc": "Vertex AI (ADC)" / "Vertex AI (ADC)"
"cli.auth.loginWithAnthropic": "Login with Anthropic Account" / "使用 Anthropic 账号登录"
"cli.auth.loginWithChatGPT": "Login with ChatGPT" / "使用 ChatGPT 登录"
"cli.auth.loginWithGoogle": "Login with Google Account" / "使用 Google 账号登录"
"cli.auth.orUseApiKey": "— or use API Key —" / "— 或使用 API Key —"
"cli.auth.apiKeyPlaceholder": "Enter API Key..." / "输入 API Key..."
"cli.auth.saveApiKey": "Save API Key" / "保存 API Key"
"cli.auth.logout": "Logout" / "登出"
"cli.auth.reLogin": "Re-login" / "重新登录"
"cli.auth.logoutConfirmTitle": "Confirm Logout" / "确认登出"
"cli.auth.logoutConfirmDesc": "This will clear all authentication credentials for {engine}." / "这将清除 {engine} 的所有认证凭据。"
"cli.auth.waitingForAuth": "Waiting for browser authentication..." / "等待浏览器认证..."
"cli.auth.openUrlHint": "Open this URL in your browser:" / "请在浏览器中打开以下 URL："
"cli.auth.copyUrl": "Copy URL" / "复制 URL"
"cli.auth.cancel": "Cancel" / "取消"
"cli.auth.autoUpdate": "The page will automatically update once authentication is complete." / "认证完成后页面将自动更新。"
"cli.auth.account": "Account" / "账户"
"cli.auth.plan": "Plan" / "套餐"
"cli.auth.lastUpdated": "Last Updated" / "最后更新"
"cli.auth.refresh": "Refresh" / "刷新"
\`\`\`

---

## 8. 与现有系统的集成点

### 8.1 与 ConnectionStatus 的集成

认证状态变化后，触发 ConnectionStatus 重新检测：
\`\`\`typescript
const refreshConnectionStatus = () => {
  window.dispatchEvent(new Event("engine-changed"));
};
\`\`\`

### 8.2 与 runtime-status API 的集成

\`/api/runtime-status\` 中的检测逻辑（\`getGeminiSettingsAuthType()\`、\`hasGeminiEnvAuth()\` 等）应抽取为可复用工具函数到 \`src/lib/cli-auth-utils.ts\`。

### 8.3 与 CliSettingsSection 的集成

认证区域嵌入现有组件中，位于引擎切换按钮之下、配置编辑区之上。

### 8.4 与命令注册系统的集成

升级后的 cli-only 命令需要在 \`useNativeCommandController.ts\` 中添加 GUI 执行逻辑（导航、弹窗等）。

### 8.5 Remote Dev 模式支持

当 \`workspaceMode === 'remote'\` 时，所有凭据操作通过 SSH 在远程主机上执行。参考现有 \`/api/remote/settings\` 模式。

### 8.6 与 Provider 系统的关系

\`\`\`
+-- Provider 系统 (已有) --+     +-- CLI Auth 系统 (新增) --+
|                           |     |                          |
|  管理"第三方 API 转发"    |     |  管理"CLI 原生认证"       |
|  存储在 SQLite DB         |     |  OAuth: CLI 配置文件      |
|  通过 env 注入子进程      |     |  API Key: 按引擎分别存储  |
|                           |     |                          |
|  适用场景:                |     |  适用场景:               |
|  - 自定义 API 端点        |     |  - 官方 OAuth 登录        |
|  - 多 provider 切换       |     |  - 直接的官方 API key    |
+---------------------------+     +--------------------------+
\`\`\`

---

## 9. 安全考虑

### 9.1 OAuth Token 安全

- OAuth 子进程在服务端运行，token 不经过前端
- 前端只获取 auth_url 和最终的 status
- OAuth session 有 5 分钟 TTL

### 9.2 API Key 保护

\`\`\`
前端 Input  -->  POST /api/cli-auth/api-key  -->  文件系统写入
   |                    |                           |
   密码模式             HTTPS 传输                  chmod 0600
   不存入 state         不记录到日志                 原生格式
\`\`\`

### 9.3 防重放与并发

- OAuth session 使用 UUID 标识
- 同一引擎同一时间只允许一个 OAuth session
- API Key 写入使用 atomic write

---

## 10. 错误处理与降级

| 错误类型 | HTTP 状态码 | 降级策略 |
|---------|------------|---------|
| CLI 未安装 | 404 | 提示安装命令，仍可输入 API Key |
| OAuth 子进程无法启动 | 500 | 提示用户手动在终端执行 \`cli login\` |
| OAuth URL 提取失败 | 500 | 显示"请在终端执行 \`cli login\`" |
| OAuth 超时（5 分钟） | 408 | 提示超时，提供重试按钮 |
| API Key 验证失败 | 422 | 提示 key 无效，允许"跳过验证直接保存" |
| Codex App Server 不可用 | — | 降级为文件读取 \`~/.codex/auth.json\` |
| 凭据文件权限不足 | 500 | 提示文件权限问题 |
