# dsh-telegram

把这个机器上的 Hulala agent 接到 Telegram 上。手机发一句话，本机的 Host 执行，回复流式回到同一个对话；`/cwd` 切换这个对话挂载哪个会话——和 TUI 里切换会话是同一件事。

## 它是什么

**一个 peer**，和 TUI、Desktop、Web 同级。它连到正在运行的 Hulala Host：

```
GET /connect?token=…&interactions=answer   → cookie
ctx.remote.$mount(Session, Workspace)      → 会话与工作区
ctx.remote.$on('approval/request')         → 审批
session.follow({ assistantStream: true })  → 流式回复
```

不是 Host 插件、不是 Cordis 行、不改 DSH、不打补丁。会话历史、cwd、模型、权限之外的一切都以 Host 为真源；这里只保存「哪个对话挂了哪个会话」。

**一台机器一个 Host**：发现走 `~/.hulala/server/host/endpoint.json`，只 attach，从不自己拉起 Host。Host 不在时回一条明确提示。

**多端同时在线是正常的**：TUI 和手机可以挂同一个会话，两边看到同一段历史。审批会同时出现在两端，谁先点生效，另一端卡片自动变成「已在其他端处理」。这是 DSH 官方客户端的行为，不是这里发明的协调机制。

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
node src/index.ts                 # 开发
node src/index.ts --self-check    # 只验证能不能连上 Host，不发任何消息
bun run build && node dist/index.mjs   # 打成一个文件再跑
```

`--self-check` 会 attach、读会话列表、注册两个 waterfall 事件，然后退出——升级 Host 或换机器后先跑它。

## 命令

| 命令 | 行为 |
|---|---|
| `/cwd` | 当前挂载的会话与目录 |
| `/cwd <path>` | 换挂载：该目录下最近的会话，没有就新建 |
| `/new` | 在当前目录新建会话 |
| `/sessions` | 最近 10 个会话，`*` 表示当前 |
| `/switch <n>` | 切到第 n 个 |
| `/status` | 会话、目录、运行状态 |
| `/stop` | 停止当前回合 |
| `/help` | 上面这些 |

直接发文字就是提问。第一次说话会自动在 `defaultCwd` 里建一个会话并挂上。

## 行为细节

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
