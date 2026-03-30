# Claude CLI 与 Gemini CLI Slash Commands 是否存在对应的公共 API 或分发二进制的深度证据报告

## 执行摘要

本报告围绕两个“最官方/最活跃”的终端类产品：entity["company","Anthropic","ai company"] 的 **Claude Code（命令为 `claude`，常被口语称为 Claude CLI）** 与 entity["company","Google","technology company"] 的 **Gemini CLI（命令为 `gemini`）**，对其“斜杠命令（Slash Commands）是否有对应公共 API 或分发二进制”做证据链分析，并给出可复现实验与抓包/追踪方法。

核心结论（带置信度）如下：

Claude 侧：**存在“分发二进制”**（`claude` 可通过 `claude.ai/install.sh`、Homebrew cask、WinGet 等方式安装），且 Slash Commands 既有**内置命令**也支持从项目文件系统加载的**自定义命令（`.claude/commands/*.md`）**；同时 **Claude Agent SDK 明确支持在 SDK 中“发现并发送 slash commands”**，但这并不意味着每个 slash 命令都对应一个公开稳定的 HTTP API 端点——多数命令更像是“本地控制/提示模板”，最终仍主要落到 Claude 的消息接口/内部服务请求上。citeturn3view0turn5view0turn5view1turn10view0turn13view0turn9view0turn6search19turn5view2  
Gemini 侧：**存在“分发制品”**（NPM 包 + GitHub release 的单文件 bundle），Slash Commands 的解析与执行路径在开源仓库中可直接定位；但 **slash 命令本身通常不对应一个“独立公开 API”**，更常见的是“本地命令路由→组装 prompt/触发工具→调用 Gemini API/Vertex API/Code Assist 内部 API”。尤其当使用“Google 账号登录（Code Assist OAuth）”路径时，CLI 会调用 `cloudcode-pa.googleapis.com/v1internal:*` 形式的 **内部/私有风格端点**（可在源码常量与错误日志中得到一致证据），而使用 API key 或 Vertex 路径时则分别落到 **`generativelanguage.googleapis.com/v1beta/...`** 与 **`{location}-aiplatform.googleapis.com/v1/...`** 等公开端点。citeturn30search0turn3view1turn20view0turn24view0turn27view0turn15view0turn28search0turn28search2turn21search5turn28search12  

整体上：两者都**有明确的分发产物**（Claude 更偏“原生二进制 + 辅助开源仓库”，Gemini 更偏“开源 Node 包 + bundle release”）；“slash commands 是否对应公共 API”要拆成两层理解：  
- **开发者可直接调用的公开模型 API**（Claude Messages API、Gemini Developer API、Vertex AI REST）确实存在。citeturn13view0turn28search0turn28search2  
- **“命令级 API”（每个 /xxx 有专属公开端点）**：两者都缺乏“官方声明的、稳定的、对外承诺 SLA 的独立命令端点”。Gemini 的 Code Assist OAuth 路径甚至显式落入 `v1internal` 风格接口（从命名与代码结构上就更像内部服务）。citeturn24view0turn27view0turn21search5turn25search6  

## 研究范围与方法

本报告将“Claude CLI”理解为官方“Claude Code”的 `claude` 终端体验，因为它在官方 CLI 文档中自称“Claude Code CLI”，且 Slash Commands 是其交互模式核心概念之一。citeturn5view1turn3view0  
“Gemini CLI”则以 `google-gemini/gemini-cli` 为准，它在 Google Cloud/Google Developers 的官方文档中被描述为开源 CLI，并被用于 Gemini Code Assist agent mode。citeturn14view0turn22search8turn3view1  

证据优先级遵循：官方文档/官方仓库/官方包注册表与 release note ＞ 代码与构建产物 ＞ 可复现日志/issue 中的错误输出（用于补足“端点与 headers”细节，但置信度低于官方文档与源码常量）。citeturn13view0turn24view0turn27view0turn6search19turn21search5  

## Claude CLI（Claude Code）Slash Commands 的 API 与二进制证据

### 优先核查的权威来源

最应优先看的“第一方/主来源”包括：

Claude Code 的 CLI Reference（命令、flags、debug、remote-control 等）。citeturn5view1turn30search5  
Claude Code 仓库（安装方式、数据收集说明、示例 commands、plugins）。citeturn3view0turn8view0turn9view0turn5view2  
Claude Agent SDK 文档中关于 Slash Commands 的页面（“可发现、可发送”）。citeturn5view0  
Claude Agent SDK overview（SDK 与 Claude Code 共享能力，且明确“Slash commands 的文件位置”）。citeturn10view0  
Claude API（Messages API 的公开端点、headers 与请求/响应结构）。citeturn13view0  
Remote Control 与 Hooks（它们是“命令之外的控制面”，但直接关系到“是否存在可用的控制 API/HTTP hooks”）。citeturn30search1turn30search2  

补充来源（用于旁证网络端点/鉴权行为）：

Claude Code CHANGELOG（新增请求 header、代理/OTEL、日志环境变量等）。citeturn5view2  
Claude Code issues 中关于连接到 `api.anthropic.com`、OAuth client_data 等日志证据。citeturn6search19turn6search0turn6search10turn6search1turn6search25  

### Slash Commands 是否存在“对应的公共 API”

从官方定义看，Claude 的 Slash Commands 主要是一种“会话控制/快捷工作流”机制：SDK 文档明确说 slash commands 是以 `/` 开头的特殊命令，可通过 SDK 发送，用于清空历史、压缩、获取帮助等；并且 SDK 初始化消息里直接暴露可用命令列表。citeturn5view0  

同时，Agent SDK overview 明确把“Slash commands”定义为“用于常见任务的自定义命令”，位置在 `.claude/commands/*.md`，并说明 SDK 可通过设置 `settingSources=["project"]`（或 TS 的 `settingSources: ['project']`）加载这些文件系统配置。citeturn10view0  

因此，“对应公共 API”若理解为 **“存在一个公开 SDK 接口（可编程地发现/触发 slash commands）”**，答案是**有**：Claude Agent SDK 就是它。citeturn5view0turn10view0  
但若理解为 **“每个 /command 都对应一个对外承诺的独立 HTTP API 端点”**，官方材料并未给出这种承诺；更贴近事实的是：slash commands 通常在本地被解析/执行（改变会话状态、加载 prompt 模板、触发工具链），最终对模型的调用仍主要走 Messages API 或 Claude Code 自身的服务请求。citeturn5view0turn5view1turn13view0turn5view2  

### Slash Commands 触发的网络端点与鉴权证据

#### 公开、稳定、可复现的“核心模型调用”端点

Claude 的公开 Messages API 在官方文档中给出明确端点与 headers（`https://api.anthropic.com/v1/messages`、`x-api-key`、`anthropic-version` 等），并展示了请求/响应结构。citeturn13view0  

示例（官方结构，便于对照抓包数据）：

```bash
curl https://api.anthropic.com/v1/messages \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"Hello, Claude"}]
  }'
```

citeturn13view0  

这类请求既是“开发者 API”的事实标准，也是在你拦截 Claude Code 网络流量时最应该首先匹配的基线（至少 API key 路径下）。citeturn13view0turn10view0  

#### Claude Code 自身的“产品/会话/鉴权相关”端点线索

在 Claude Code 的 issue 中出现了非常具体的内部路径：启动单个会话时会并发请求 `https://api.anthropic.com/api/oauth/claude_cli/client_data` 并触发 429，日志里直接打印了 URL 与状态。citeturn6search19  
这类 `/api/oauth/claude_cli/*` 路径从命名直觉上更像产品 OAuth 客户端数据/能力探测接口，而非 Messages API（但它确实在 `api.anthropic.com` 域下）。是否公开/稳定：官方文档并未把它作为开发者 API 发布，因此应视为**内部契约**，抓包时可作为“slash 命令/登录/初始化阶段”的重要线索。citeturn6search19turn5view1  

另外，较早的 issue 中提到用 Wireshark 看到 SNI 包含 `api.anthropic.com`、`console.anthropic.com`、`statsig.anthropic.com` 等。`statsig` 常用于特性开关/实验分流（这里仍属于推断，不是官方声明），但至少可以确认 Claude Code 运行时不只访问单一 API 域名。citeturn6search10  

#### 请求 headers 与可观测性

Claude Code changelog 直接记录：“向 API 请求新增 `X-Claude-Code-Session-Id` header”，用途是让代理按 session 聚合而无需解析 body。citeturn5view2  
这意味着：就算你无法轻易解析 TLS 内的 JSON，也可能从上游代理日志里通过该 header 关联一次 slash 命令触发的模型调用链路（前提是你能在代理层看到 headers）。citeturn5view2turn5view1  

### Slash Commands 的本地实现与分发二进制证据

#### 分发二进制/安装通道

Claude Code 的官方仓库 README 给出“推荐安装方式”为从 `https://claude.ai/install.sh` 管道执行，或 Homebrew cask、WinGet 安装；并明确说明 NPM 安装已 deprecated。citeturn3view0  
这组信息本身就构成“存在分发二进制/分发产物”的强证据（尤其是 Homebrew cask 与 WinGet 通常指向可执行安装包/二进制）。citeturn3view0  

#### 可在公开仓库中定位的“命令文件路径/格式”

Claude Agent SDK overview 把 slash commands 的“文件系统实现”定位到 `.claude/commands/*.md`。citeturn10view0  
Claude Code 仓库中也确实存在 `.claude/commands/` 目录，并包含示例命令文件（如 `commit-push-pr.md`）。citeturn8view0turn9view0  

该示例文件展示了类似 frontmatter 的字段（`allowed-tools`、`description`）以及通过 `!` 包含 shell 命令输出作为上下文的模式（例如 `!` 形式的 `git status` / `git diff`）。citeturn9view0  
这说明至少“自定义 slash commands”在 Claude Code 生态里并不需要外部 HTTP API：它们本质是本地文件+提示模板+工具调用权限约束。citeturn10view0turn9view0  

#### 哪些部分“看不到源码”

虽然 Claude Code 在 entity["company","GitHub","software platform"] 上公开了大量仓库内容与 changelog，但它的安装方式以外部脚本/包管理器分发为主；这意味着“内置 slash commands 的核心实现（如 UI、命令路由、网络层细节）”很可能主要位于分发产物而非仓库里可直接搜索到的 TS/Python 文件（至少从仓库结构与安装策略可合理推断）。citeturn3view0turn5view1turn5view2  
从实务角度，你要验证这一点通常需要对已安装的 `claude` 可执行文件做本地逆向级别的可观测性（strings/trace/network），而不是只看仓库。citeturn6search0turn6search25  

### 复现网络调用与拦截/追踪步骤

下面步骤目标是：在**合法授权**前提下，把“某条 slash 命令”映射到“具体网络请求（域名/路径/headers/鉴权方式）”。

启用 CLI 自带调试输出：CLI reference 显示 `--debug` 支持按类别过滤（例如 `"api,mcp"`），并存在 `--disable-slash-commands` 用于禁用 skills/commands（可做对照实验：同一输入在禁用与启用 slash commands 时的网络差异）。citeturn5view1  

利用 changelog 提供的日志环境变量：changelog 指出已移除 `DEBUG=true`，改用 `ANTHROPIC_LOG=debug` 记录请求。citeturn5view2  

最小可复现实验建议（示例，具体版本/行为以你本机为准）：

```bash
# 1) 让 Claude Code 尽可能打印 API 相关日志（如果支持）
export ANTHROPIC_LOG=debug

# 2) 在新目录启动，避免历史影响
mkdir -p /tmp/cc-trace && cd /tmp/cc-trace

# 3) 启动带 debug 类别
claude --debug "api,mcp"
```

citeturn5view1turn5view2  

网络层捕获（TLS 环境下的现实做法）：

- 先做“域名/端口级别”确认：  
  - `lsof -i -P | grep claude`（找出实际连接对象）  
  - `tcpdump -i any -nn host api.anthropic.com`（只看 SNI/握手与流量方向）  
  - `strace -f -e trace=network -s 200 -o /tmp/claude.net.log claude ...`（Linux）  
从 issue 中已知至少可能出现 `api.anthropic.com` 以及 OAuth client_data 路径。citeturn6search19turn6search10  

- 若需要 HTTP 明细：优先考虑“在你可控的代理/网关层做终止 TLS 或记录 headers”的方式（因为 changelog 明确存在 session header，适合代理聚合）。citeturn5view2  
  纯本机 MITM（mitmproxy）并非总是成功，原因包括：应用可能使用系统信任链、可能做证书固定/自定义 CA 策略、或在桌面/remote-control 模式下走不同通道（这些需以实测为准）。citeturn30search1turn6search13  

### 安全与鉴权影响要点

Claude Agent SDK overview 要求开发者 API key（`ANTHROPIC_API_KEY`）作为主要鉴权方式，并同时提示“第三方开发者不被允许提供 claude.ai 登录或 rate limits 给他们的产品”，这意味着“订阅 OAuth token 复用”可能存在政策/技术限制（这将影响你是否能把 slash commands 当作一个可集成的“订阅级公共 API”）。citeturn10view0  

Claude Code issue 中出现了 `CLAUDE_CODE_OAUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 在不同系统下的优先级/钥匙串行为差异（macOS Keychain 前置导致 env var API key 可能被忽略）。这类差异会直接影响抓包与复现：同一条 `/login` 或同一条 slash 命令在不同鉴权路径下可能走不同端点/headers。citeturn6search1turn6search5  

数据与遥测：Claude Code 仓库 README 明确写到会收集反馈（包括使用数据、会话数据、通过 `/bug` 提交的反馈等），并指向数据使用政策。抓包/代理日志中如果包含这些数据，应把它当作敏感信息处理（脱敏、最小保留、权限隔离）。citeturn3view0  

另外，“Hooks 可执行 shell 命令/HTTP endpoints/LLM prompts”，这意味着你可以在本地把关键事件 POST 到自建审计端点，但也意味着一旦误配置，可能把代码/提示/路径等敏感信息外发。citeturn30search2  

## Gemini CLI Slash Commands 的 API 与二进制证据

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["Gemini CLI slash commands terminal /help /mcp","Google Gemini CLI custom slash commands .toml","Claude Code slash commands /model /compact terminal"],"num_per_query":1}

### 优先核查的权威来源

最优先的来源链如下：

Google Cloud 文档对 Gemini CLI 的总览（明确它开源、使用 ReAct loop，并列出在 Code Assist agent mode 中可用的命令子集，如 `/memory` `/stats` `/tools` `/mcp`）。citeturn14view0turn2search23  
Gemini CLI 官方开源仓库 README（安装方式、发布节奏、指向文档站）。citeturn3view1  
官方文档站对发布与制品的说明（GitHub release 发布单文件 `gemini.js` bundle，NPM 发布标准 package）。citeturn30search0turn30search4  
Gemini CLI 认证文档（`GEMINI_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、OAuth 登录与本地缓存、`.gemini/.env` 机制）。citeturn15view0  
Slash commands 文档：内置 commands 列表与 `/commands reload` 等管理命令。citeturn17view1turn17view0  
代码层：`packages/cli/.../slashCommandProcessor.ts`（命令解析与执行入口）、`packages/core/src/code_assist/server.ts`（内部 Code Assist 端点常量与请求拼装）、`packages/core/src/code_assist/converter.ts`（内部请求 envelope）。citeturn20view0turn24view0turn27view0  

### Slash Commands 是否存在“对应公共 API”

Gemini CLI 的 Slash Commands 在实现上更接近“本地命令路由层”，而不是“远端服务暴露的命令 API”。核心证据来自开源代码：`useSlashCommandProcessor` 会加载多类 CommandLoader（Builtin/Skill/MCP prompt/File command），对用户输入做 `parseSlashCommand`，把结果映射成 UI 动作、工具调度、历史加载等。citeturn20view0  

同时，官方文档明确自定义命令来自 `.toml` 文件，按 `~/.gemini/commands/` 与 `<project>/.gemini/commands/` 两级加载，并支持 `/commands reload` 在不重启 CLI 的情况下重新加载。citeturn17view0turn17view1  

因此，“slash commands 对应的公共 API”要拆解：

- 若你指“能被外部程序调用的、公开且稳定的 HTTP ‘/command API’”：**没有官方证据表明存在**。  
- 若你指“Slash Commands 最终触发的模型调用是否有公共 API”：**有**，即 Gemini Developer API 与 Vertex AI REST；但这并不是“命令 API”，而是“模型推理 API”。citeturn28search0turn28search2  
- 若你指“登录（Google 账号）路径下看到的 `cloudcode-pa.googleapis.com/v1internal:*`”：这更像内部 Code Assist 服务，不应当按公开 API 对待（命名就是 `v1internal`，且源码常量也这么写）。citeturn24view0turn21search5turn25search6  

### Slash Commands 的本地实现与可定位代码路径

#### slash 命令解析与命令加载链路

在 `slashCommandProcessor.ts` 的 raw 源码中可直接看到：

- `CommandService.create([...BuiltinCommandLoader, SkillCommandLoader, McpPromptLoader, FileCommandLoader], ...)`：命令来源不仅是内置，还包括 skills、MCP prompts、自定义文件命令。citeturn20view0  
- `parseSlashCommand(trimmed, commands)`：解析命令并提取 args、canonicalPath。citeturn20view0  
- 对未知命令的处理：代码注释明确提到像 `/home/user/file.txt` 这种绝对路径不应误判为命令；当找不到 command 且 MCP 不在加载中时，返回 `false`，让输入作为普通文本发给模型。citeturn20view0  

这段逻辑非常关键：它直接说明“Slash Commands 并不依赖远端命令 API”，而是在本地先把输入分流。citeturn20view0  

#### 自定义命令（.toml）与命名空间规则

官方文档在 `custom-commands.md` 中说明：  
- `~/.gemini/commands/test.toml` → `/test`  
- `<project>/.gemini/commands/git/commit.toml` → `/git:commit`（路径分隔符映射为 `:`）  
并强调 project 命令可覆盖 user 命令。citeturn17view0  

这意味着：对绝大多数“用户自定义 slash 命令”，其实现是“本地文件→提示模板→模型调用”，不需要任何额外 HTTP 端点。citeturn17view0turn17view1  

#### Code Assist（OAuth 登录）路径的内部端点与 envelope 请求体

Gemini CLI 的 `packages/core/src/code_assist/server.ts` 明确写死默认端点与版本：

- `CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'`  
- `CODE_ASSIST_API_VERSION = 'v1internal'`  
并用 `getMethodUrl(method)` 拼出 `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` 这类 URL；流式请求还会加 `alt=sse`。citeturn24view0  

同时，`converter.ts` 定义了 `CAGenerateContentRequest`，结构是：

- 顶层：`model`, `project`, `user_prompt_id`, `request: {...}`  
而不是 Gemini Developer API 的“直接 GenerateContentRequest fields”。citeturn27view0turn21search8  

这一点解释了为什么很多用户在 issue 里看到错误 URL 直接指向 `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` 或 `:countTokens`：这是 OAuth 认证路径的实际“后端”。citeturn21search5turn21search1turn28search12  

### Slash Commands 触发的 API 端点、鉴权方式与 curl 复现样例

#### Gemini Developer API（API Key）

Google AI 官方 API 参考给出范例：请求必须带 `x-goog-api-key` header，URL 通常是 `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`。citeturn28search0turn28search8  

```bash
export GEMINI_API_KEY="YOUR_KEY"

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "contents": [{"parts":[{"text":"hello"}]}]
  }'
```

citeturn28search0  

流式 SSE 也在官方文档中有明确范例（`streamGenerateContent?alt=sse`）。citeturn28search23  

#### Vertex AI（ADC/Service Account/OAuth access token）

Google Cloud 的 Vertex AI REST reference 把方法定义为 `POST /v1/{model}:generateContent`（其中 `{model}` 是完整资源名 `projects/{project}/locations/{location}/publishers/.../models/...`）。citeturn28search2turn28search25  

```bash
export PROJECT_ID="YOUR_PROJECT"
export LOCATION="us-central1"
export MODEL="gemini-2.0-flash-exp"

curl -s -X POST \
  "https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role":"user","parts":[{"text":"test"}]}]
  }'
```

citeturn28search2turn21search6  

#### Code Assist OAuth（内部 `v1internal`）

这是“有代码证据但非公开稳定 API”的路径：源码构造的是 `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`，请求体是 `CAGenerateContentRequest` envelope。citeturn24view0turn27view0  

如果你要在实验环境复现（仅用于研究/验证，稳定性与权限取决于你的账号与订阅），一个“按源码推导的最小形态”可能接近：

```bash
ACCESS_TOKEN="$(gcloud auth print-access-token)"

curl -N -X POST \
  "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-pro-preview-customtools",
    "project": "YOUR_PROJECT_ID",
    "user_prompt_id": "debug-001",
    "request": {
      "contents": [{"role":"user","parts":[{"text":"hi"}]}]
    }
  }'
```

该示例中的字段名、URL 形态与 `alt=sse` 由源码直接给出；但鉴权与权限、`project` 关联方式以及模型名是否接受，必须以你的 CLI 登录方式与组织策略为准。citeturn24view0turn27view0turn21search5turn21search19  

### 分发制品与本地“二进制/包”证据

Gemini CLI 仓库 README 给出 `npx @google/gemini-cli` 与 `npm install -g @google/gemini-cli`、Homebrew 安装方式，且强调其开源与发布节奏。citeturn3view1turn30search12  
官方 release 文档进一步给出清晰的双制品策略：  
- NPM：标准 packages（`packages/cli/dist` 等）  
- GitHub release：单文件 bundled `gemini.js`，便于 `npx` 直接执行。citeturn30search0  
此外 NPM registry 页面直接显示包版本与发布时间，构成“持续发布”的旁证。citeturn30search7  

如果你要在已安装包中定位代码路径（例如定位 slashCommandProcessor、code_assist/server 等），issue 的堆栈信息已经暴露了典型安装路径形态（例：Homebrew Cellar 下 `.../lib/node_modules/@google/gemini-cli-core/dist/...`）。citeturn4search16turn22search14  

### 复现网络调用与拦截/追踪步骤

Gemini CLI 的认证文档明确给出三大主路径与关键 env vars：

- API Key：`GEMINI_API_KEY`（并给出安全警告）。citeturn15view0  
- Vertex：`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION` + ADC (`gcloud auth application-default login`) 或 `GOOGLE_APPLICATION_CREDENTIALS`。citeturn15view0  
- Google 账号登录：通过浏览器 OAuth，凭据会缓存到本地用于后续会话。citeturn15view0  

同时，issue 中可见 OAuth 流的真实参数：`redirect_uri` 指向 localhost 随机端口的 `/oauth2callback`，并请求 `cloud-platform`、`userinfo.email`、`userinfo.profile` 等 scope，`access_type=offline` 表示可能会获得 refresh token（这对安全与落盘很重要）。citeturn21search5turn4search2  

拦截/追踪建议（按“从易到难”）：

- 域名级确认：  
  - `tcpdump -i any -nn host generativelanguage.googleapis.com`  
  - `tcpdump -i any -nn host cloudcode-pa.googleapis.com`  
  - `lsof -i -P | grep gemini`  
  通过源码你应能预期 OAuth 路径默认命中 `cloudcode-pa.googleapis.com`（可由常量与错误日志互证）。citeturn24view0turn28search12  

- 进程级网络系统调用：  
  - Linux：`strace -f -e trace=network -s 200 -o /tmp/gemini.net.log gemini`  
  - macOS：可用 `sudo dtruss -f -n node`（需权限，且对 SIP/系统版本敏感）  
  这通常能让你在不解密 TLS 的前提下拿到连接目标与时序。  

- 需要 HTTP 明细时（TLS MITM）：  
  Node 生态通常可用 `NODE_EXTRA_CA_CERTS=/path/to/mitmproxy-ca.pem` 让 Node 信任你的 MITM CA，然后用 `HTTPS_PROXY=http://127.0.0.1:8080` 把流量导向 mitmproxy；但是否生效取决于 CLI 的 HTTP 客户端栈与是否绕过系统代理。  
  对 Code Assist OAuth 路径还要注意它使用 `google-auth-library` 的 `AuthClient.request`；你可以优先在 gcloud/企业网关层记录出站请求，而不是强行在本机做 MITM。citeturn24view0turn21search5  

## 安全、鉴权与遥测的对比要点

Claude Code：

- 公共模型 API key 走 `x-api-key` + `anthropic-version`（公开、稳定）。citeturn13view0  
- CLI 自身还可能访问 `api.anthropic.com/api/oauth/claude_cli/client_data` 之类内部路径，且 changelog 显示 API 请求会带 `X-Claude-Code-Session-Id`，这对代理侧可观测性与隐私（会话关联）都有影响。citeturn6search19turn5view2  
- 认证形态上，issue 表明存在 OAuth token（`CLAUDE_CODE_OAUTH_TOKEN`）与 API key 的并存，以及 macOS 钥匙串优先级导致的差异；这会影响你对“slash 命令是否对应某个 API 调用”的归因，因为同一命令可能在不同 auth path 下走不同网络。citeturn6search1turn6search5  
- Hooks 支持 HTTP endpoints 自动执行，意味着你可以把关键事件导入 SIEM/审计系统，但也意味着配置错误会扩大数据外泄面。citeturn30search2  

Gemini CLI：

- 认证文档清晰列出：Google 登录（缓存凭据）、API key、Vertex（ADC/SA key/Cloud API key），并给出 `.gemini/.env` 的加载位置与“任何子进程可读 env”风险提示。citeturn15view0  
- “Google 登录（Code Assist）”路径会调用 `cloudcode-pa.googleapis.com/v1internal:*`，且源码允许通过 `CODE_ASSIST_ENDPOINT`/`CODE_ASSIST_API_VERSION` 覆盖（便于开发测试，也意味着企业环境可能有自建代理/镜像端点的需求）。citeturn24view0turn22search7  
- OAuth scopes 与 offline access 在 issue 中可被直接观察；这意味着 CLI 可能在本地保存 refresh token 或等价凭据（你应当把 `~/.gemini` 下的认证缓存当作敏感资产来保护与审计）。citeturn21search5turn4search2  
- 公开 Gemini Developer API 以 `x-goog-api-key` 为核心，适合企业做“最小权限/最小泄露”的策略（API key 本质仍是高价值秘密）。citeturn28search0turn15view0  

## 证据对照表与置信度评估

| 项目 | 关键主张 | 主要证据来源（优先级从高到低） | 置信度 |
|---|---|---|---|
| Claude | Claude Code CLI 存在可安装的分发产物（非纯源码运行） | Claude Code 仓库 README 给出 `install.sh`/Homebrew cask/WinGet，且 NPM deprecated。citeturn3view0 | 高 |
| Claude | SDK 可发现并发送 slash commands（对外可编程接口存在） | “Slash Commands in the SDK” 明确写可通过 SDK 发送，init 消息暴露 `slash_commands`。citeturn5view0 | 高 |
| Claude | 部分 slash commands/自定义命令来自 `.claude/commands/*.md` | Agent SDK overview 指出文件位置；仓库中存在 `.claude/commands` 示例文件。citeturn10view0turn9view0 | 高 |
| Claude | Claude 模型调用的公开基础端点是 `/v1/messages`（headers 固定） | Messages API 官方示例（URL + headers + JSON）。citeturn13view0 | 高 |
| Claude | Claude Code 启动阶段可能访问内部 OAuth 客户端数据端点 | issue 日志直接给出 `https://api.anthropic.com/api/oauth/claude_cli/client_data`。citeturn6search19 | 中 |
| Claude | Claude Code API 请求新增 `X-Claude-Code-Session-Id` header | changelog 明确记录。citeturn5view2 | 高 |
| Gemini | Gemini CLI 是开源且有明确发布节奏与安装方式 | GitHub README；Google Cloud 文档也称其开源并用于 agent mode。citeturn3view1turn14view0 | 高 |
| Gemini | Gemini CLI 有双制品分发：NPM packages + GitHub release 单文件 `gemini.js` | 官方 releases 文档明确描述。citeturn30search0 | 高 |
| Gemini | Slash命令解析/执行在本地完成（命令路由层） | `slashCommandProcessor.ts`：CommandService + loaders + parseSlashCommand + fallback。citeturn20view0 | 高 |
| Gemini | 自定义 slash commands 来自 `.toml`，目录优先级明确 | `custom-commands.md` 与 Commands reference（含 `/commands reload` 与来源列表）。citeturn17view0turn17view1 | 高 |
| Gemini | API key 路径调用公开 `generativelanguage.googleapis.com/v1beta/...`，header 为 `x-goog-api-key` | Google AI API reference 官方示例。citeturn28search0 | 高 |
| Gemini | Vertex 路径调用公开 `aiplatform.googleapis.com/v1/...:generateContent` | Vertex REST reference 官方定义。citeturn28search2turn28search25 | 高 |
| Gemini | Google 登录（Code Assist OAuth）路径调用 `cloudcode-pa.googleapis.com/v1internal:*`（内部端点） | `CODE_ASSIST_ENDPOINT`/`CODE_ASSIST_API_VERSION` 常量；大量错误日志含 `v1internal:*`。citeturn24view0turn28search12turn21search5 | 高 |
| Gemini | Code Assist OAuth 路径请求体与公共 API 不同（envelope + `user_prompt_id`） | `converter.ts` 的 `CAGenerateContentRequest` 定义；相关分析 issue。citeturn27view0turn21search8 | 高 |

## 推荐后续动作与可复现命令集

### 面向 Claude Code

确认你机器上 `claude` 的真实网络行为（按命令分类，而非“整体抓包”）：

```bash
# 1) 记录版本与运行模式差异（交互 vs print）
claude --version
claude -p "hello"

# 2) 在交互模式开启 API/MCP 相关 debug
export ANTHROPIC_LOG=debug
claude --debug "api,mcp"
```

citeturn5view1turn5view2  

随后在交互里逐条执行典型 slash 命令并做“网络差分”：

- `/help`、`/clear`、`/compact`（预计多数是本地/会话级动作，但 `/compact` 可能触发模型调用）citeturn5view0turn5view2  
- `/login`（关注是否命中 `/api/oauth/claude_cli/*`）citeturn6search19  
- `/mcp`（若使用远程 MCP，关注 OAuth/HTTP headers 与域名）citeturn5view1turn5view2  
- `claude remote-control ...`（验证是否出现本地监听端口与远端连接）citeturn5view1turn30search1  

对 “slash commands 是否对应某 API” 做归因时，必须同步记录鉴权路径（API key / OAuth token / third-party providers），否则结论会混淆。citeturn10view0turn6search1turn6search25  

### 面向 Gemini CLI

先固定认证路径，因为这决定你会看到哪套 API：

```bash
# A) API key 路径
export GEMINI_API_KEY="YOUR_KEY"
gemini

# B) Vertex 路径（ADC）
unset GEMINI_API_KEY GOOGLE_API_KEY
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT"
export GOOGLE_CLOUD_LOCATION="us-central1"
gcloud auth application-default login
gemini
```

citeturn15view0  

然后在交互里做 slash 命令与网络的对照：

- `/help`、`/commands reload`（应主要触发本地加载 `.toml`，不应依赖模型 API）citeturn17view1turn17view0  
- `/mcp auth <server>`（会触发 OAuth discovery/token endpoint 访问；结合 MCP 文档与 issue 可定位 token 文件行为）citeturn17view1turn4search14turn4search22  
- `/tools`、`/stats`（多为本地统计/列举，但 stats 里可反推最近请求的 endpoint 类型）citeturn14view0turn17view1turn4search16  

若你要把“slash 命令→具体端点”做成可复现报告，最稳的做法是用三类 host filter 分别 tcpdump：

```bash
# Developer API
sudo tcpdump -i any -nn host generativelanguage.googleapis.com

# Vertex AI
sudo tcpdump -i any -nn host aiplatform.googleapis.com or host us-central1-aiplatform.googleapis.com

# Code Assist internal
sudo tcpdump -i any -nn host cloudcode-pa.googleapis.com
```

并与源码常量/URL 拼接逻辑对照（`CODE_ASSIST_ENDPOINT`、`getMethodUrl(':streamGenerateContent')`）。citeturn24view0turn27view0turn28search0turn28search2  

最后，如果你的目标是判断“是否存在官方、稳定、可集成的 slash command API”，建议把研究重点从“/xxx 的名字”转向“命令执行后到底走了哪类后端”：

- API key/Vertex：相对稳定、对外承诺接口（适合系统集成）。citeturn28search0turn28search2turn15view0  
- Code Assist `v1internal`：面向产品体验的内部接口（适合抓包理解行为，但不宜当作长期集成契约）。citeturn24view0turn21search5turn25search6