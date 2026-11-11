# dsh-telegram

把这个机器上的 Hulala agent 接到 Telegram 上。手机发一句话，本机的 Host 执行，回复流式回到同一个对话；`/cwd` 切换这个对话挂载哪个会话——和 TUI 里切换会话是同一件事。

## 它是什么

一套 Telegram 逻辑，两种接进 Host 的方式，都改不到 DSH 一行代码：

| 形态 | 用在 | 怎么进去 |
|---|---|---|
| **插件**（宿主内） | DSH 原生 Web / Desktop | `dsh plugin add dsh-telegram --profile desktop` |
| **peer**（独立进程） | Hulala Host | `node src/index.ts`，发现 `endpoint.json` 后 attach |

插件形态里，桥直接调宿主服务，**没有端口、token、cookie、WebSocket**：

```
ctx.sessionController.list / create / prompt / follow   → 会话与流式
ctx.workspaceController.create                          → 工作目录
ctx.on('approval/request', (req, next) => …)            → 审批
```

peer 形态里，同样四件事走载体：

```
GET /connect?token=…&interactions=answer   → cookie
ctx.remote.$mount(Session, Workspace)      → 会话与工作区
ctx.remote.$on('approval/request')         → 审批
session.follow({ assistantStream: true })  → 流式回复
```

会话历史、cwd、模型、权限之外的一切都以 Host 为真源；这里只保存「哪个对话挂了哪个会话」。

**多端同时在线是正常的**：TUI 和手机可以挂同一个会话，两边看到同一段历史。peer 形态下审批同时出现在两端，谁先点生效，另一端卡片自动变成「已在其他端处理」；插件形态下审批由 Host 内直接应答，没有跨端撤回。

## 作为 DSH 插件安装

```bash
dsh plugin add dsh-telegram --profile desktop   # 或 web / tui
```

它按 `engines.dsh` 声明兼容范围（当前 `>=0.2.2-rc.1 <0.3.0`），Host 启动时检查，不匹配就跳过并报出原因，不会带着半份装配跑起来。状态在 `$DSH_HOME/config/dsh-telegram/`，bot token 仍然只在系统钥匙串里。

自检（不动 Host，只看配置和 Bot API）：

```bash
node src/index.ts --self-check
```

## 准备

1. 一个 bot：跟 [@BotFather](https://t.me/BotFather) 说 `/newbot`，拿到 token。
2. 你自己的 Telegram user id（可以问 [@userinfobot](https://t.me/userinfobot)）。
3. 机器上跑着 Hulala Host（从 TUI 或 `hulala start` 起来）。
4. Node.js ≥ 23.6（直接用 Node 的类型剥离跑 `.ts` 源码）。

token 放系统钥匙串，不写配置文件：

```bash
# macOS
security add-generic-password -s telegram -a bot-token -w '123456:ABC…'
```

Linux 用 `secret-tool`：

```bash
secret-tool store --label 'telegram bot' service telegram account bot-token
```

也可以临时用环境变量：`TELEGRAM_BOT_TOKEN=…`。

## 配置

默认读 `~/.hulala/config/dsh-telegram/config.json`（可用 `HULALA_TELEGRAM_CONFIG` 覆盖）：

```json
{
  "tokenRef": "telegram/bot-token",
  "allowedUsers": [123456789],
  "defaultCwd": "~/hulala-workspace/workspace",
  "streamIntervalMs": 800,
  "parseMode": "markdown"
}
```

| 字段 | 说明 |
|---|---|
| `tokenRef` | 钥匙串里的 `<service>/<account>`；或 `tokenEnv` 指定环境变量名 |
| `allowedUsers` | 允许驱动的 Telegram user id。与 `allowedChats` 都为空时拒绝启动 |
| `allowedChats` | 允许驱动的 chat id（群/频道场景） |
| `defaultCwd` | 第一次说话时在哪个目录建会话 |
| `streamIntervalMs` | 同一条消息两次编辑的最小间隔，默认 800ms |
| `parseMode` | `markdown`（代码块正常显示，失败自动退回纯文本）或 `plain` |
| `baseUrl` | 只给测试用：把 Bot API 指向假服务器 |

状态文件同目录：`bindings.json`（挂载表）、`receipts/`（入站去重账本，24h TTL）、`logs/`。全部 `0600`，token 不进日志。

## 运行

```bash
node src/index.ts                        # 开发
NODE_USE_ENV_PROXY=1 node src/index.ts   # 需要走本机代理时（见下）
node src/index.ts --self-check           # 只验证连通性，不发任何消息
bun run build && node dist/index.mjs     # 打成一个文件再跑
```

一个状态根只能跑一个桥：启动时写 `bridge.lock`，再启一个会直接报 `another bridge is already running (pid …)`。两个进程抢同一个 token 会让 Telegram 回 409，并把消息随机丢给其中一个。

`--self-check` 会先 `getMe` 验 Telegram，再 attach Host、读会话列表、注册两个 waterfall 事件，然后退出。升级 Host、换机器、或「发了消息没反应」时先跑它。

### 网络：DNS 污染与代理

`api.telegram.org` 在部分网络下会被污染到无关 IP，直连必然失败。Node 的 `fetch` 默认**不读** `HTTP_PROXY`/`HTTPS_PROXY`；Node ≥ 24 用环境变量代理要显式开启：

```bash
NODE_USE_ENV_PROXY=1 node src/index.ts
```

`no_proxy` 里的 `127.0.0.1` 会让访问 Host 的 loopback 请求绕过代理，所以两者可以共存。没有代理的机器上这个开关是无害的。

## 命令

| 命令 | 行为 |
|---|---|
| `/cwd` | 弹出最近用过的目录，点一个就挂上去；没有按钮时显示当前状态 |
| `/cwd <path>` | 换挂载：该目录下最近的会话，没有就新建 |
| `/new` | 在当前目录新建会话 |
| `/sessions` | 最近 10 个会话，`*` 表示当前 |
| `/switch <n>` | 切到第 n 个 |
| `/status` | 会话、目录、运行状态 |
| `/stop` | 停止当前回合 |
| `/help` | 上面这些 |

直接发文字就是提问。第一次说话会自动在 `defaultCwd` 里建一个会话并挂上。

## 行为细节

- **置顶状态栏**：每个对话顶部钉一条 `📍 <目录>` 的消息，换挂载时原地更新，回合开始/结束时把「空闲 / 运行中」也改掉。Telegram 不允许改私聊标题栏，置顶是唯一常驻顶部的官方机制。
- **一条回合一条消息**：回合开始发 `⋯`，之后反复编辑同一条消息；回合结束用会话日志里的正式文本替换。超过 4096 字符才续消息，并在代码块边界处断开、补齐围栏。
- **工具调用**：还没有文本时显示 `· bash …`，让手机知道在干什么。
- **编辑退避**：连续 3 次编辑失败就关掉流式，回合结束一次性发送；429 按服务器给的 `retry_after` 退避。
- **入站去重**：Bot API 的 update 在 ack 丢失时会重投 24 小时，同一条消息不会喂给 agent 两次。
- **审批**：卡片只有「允许这一次 / 拒绝」。请求里没有命令行文本，只有工具名与理由；要显示具体命令需要按 `callId` 去会话日志取。
- **提问**：`ask_user_question` 会在手机上显示问题和选项，但 M0 只做通知——回答请回到 TUI/Desktop。

## 安全边界

- 白名单是唯一的口令。`allowedUsers` 与 `allowedChats` 都为空时进程拒绝启动。
- 消息正文、工具输出、贴出的路径都会经过 Telegram 的服务器。敏感仓库请用 `allowedUsers` 限制到私人 chat，并考虑关掉流式预览。
- 这个进程不给 Host 增加任何权限：它能做的事，TUI 也能做。
- 权限策略仍由 Host 的 permission preset 决定，这里不改写、不绕过。

## 与 Host 版本的关系

依赖 DSH 客户端的 `connection` / `Remote` 面：`$mount` 的命名空间、`SessionFollowFrame` 的形状、`approval/request` 的转发语义。升级 DSH 后先跑 `--self-check`；握手失败会给出可读错误而不是半工作。

## 开发

```bash
node --test "tests/*.test.ts"   # 45 个用例：纯逻辑 + 用假 Host 和假 Bot API 跑完整桥
node scripts/smoke.ts           # 对着本机真 Host 跑一轮（需要 Host 在跑）
node scripts/smoke-question.ts  # 验证 waterfall 真的送到 peer
```

`tests/fakes.ts` 里的假 Host 实现了 bridge 用到的那几个 Remote 方法，所以桥的行为可以在没有 Host、没有网络、没有 token 的情况下测。

## 许可

GPL-3.0-only。依赖：DSH 的客户端包（MIT）、`ws`（MIT）、`@deepseek-ai/cordis`（MIT）。
