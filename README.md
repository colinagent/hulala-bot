# dsh-telegram

把这个机器上的 DeepSeek Harness agent 接到 Telegram 上。手机发一句话，本机的 Host 执行，回复流式回到同一个对话；`/cwd` 切换这个对话挂载哪个会话——和 TUI 里切换会话是同一件事。

两种 Host 都能接：作为 **DSH 插件**装进 Host（DSH 与呼啦啦都支持），或者作为**独立进程**连上去。

## 它是什么

**一个 Host 插件**，改不到 DSH 一行代码。它跑在 Host 进程里，直接调宿主服务：

```
ctx.sessionController.list / create / prompt / follow   → 会话与流式
ctx.workspaceController.create                          → 工作目录
ctx.on('approval/request', (req, next) => …)            → 审批
```

没有端口、token、cookie、WebSocket：插件就在 Host 里，`/cwd`、流式回复、审批都不需要
跨进程通信。会话历史、cwd、模型、权限以 Host 为真源；这里只保存「哪个对话挂了哪个会话」。

**多端同时在线是正常的**：TUI 和手机可以挂同一个会话，两边看到同一段历史。审批由 Host
内应答；如果 TUI 也开着，先答的生效。

## 安装

两种 Host 两种装法，包是同一个：`@colinagent/dsh-telegram`。

### DSH（Web / Desktop / TUI）

```sh
# 1. 装进一个 profile：tui / web / desktop
dsh plugin --profile tui add @colinagent/dsh-telegram

# 2. 写允许名单和 token 引用（唯一需要手填的东西）
dsh plugin --profile tui exec dsh-telegram --init

# 3. 重启 Host，日志出现 "bridge starting inside the Host" 就好了
```

`--init` 只写 `allowedUsers`、`defaultCwd` 和 token 在钥匙串里的**引用**，不写 token；允许名单为空时拒绝写入——没有它，任何人都能驱动 agent。没有终端时用参数：

```sh
dsh plugin --profile tui exec dsh-telegram --init \
  --token-ref telegram/bot-token --allowed-user 123456789 --default-cwd ~/work
```

装完核对：

```sh
dsh plugin --profile tui list             # 依赖里有 @colinagent/dsh-telegram
dsh tui --dump-config | grep telegram     # 组合里有一行 # == @colinagent/dsh-telegram
```

卸载：`dsh plugin --profile tui remove @colinagent/dsh-telegram`，然后重启 Host。

### 呼啦啦

呼啦啦的插件就是 DSH 插件，命令形状一样，装进呼啦啦自己的 home
（`~/.hulala/harness/profiles/tui`），不会写进 `~/.dsh`：

```sh
hulala plugin --profile tui add @colinagent/dsh-telegram
hulala plugin --profile tui exec dsh-telegram --init
# 重启 Host
```

**自动识别**：如果你在自己的 DSH 里也装了同一个插件（或任何插件），呼啦啦启动时会读
`~/.dsh/profiles/<同名>/package.json`，把用户额外装的 bundle 链接进自己的组合，所以不
需要再装一遍。反过来不成立——呼啦啦里装的插件不会出现在 DSH 里。

## 配置在哪

状态目录是 `$DSH_HOME/config/dsh-telegram/`（DSH 是 `~/.dsh`，呼啦啦是
`~/.hulala/harness`）。

`config.json`、`bindings.json`、`receipts/`、`logs/` 都在里面，权限 `0600`/`0700`。
轮询锁不在其中：它按 bot token 的摘要放在 `~/.dsh-telegram/<hash>.lock`，所以 DSH 和
呼啦啦两边都装了插件时，同一时刻也只有一个 Host 在轮询。

### 版本兼容

包按 `engines.dsh` 声明范围（当前 `>=0.2.2-rc.1 <0.3.0`）。Host 在**导入模块之前**校验，
不满足就跳过该 bundle 并在 `skippedBundles` 里报原因，不会带着半份装配跑起来。

安装本身要求 `pnpm` 在 PATH 上——DSH 的 `dsh plugin` 与呼啦啦的 `hulala plugin` 都转发给它。

## 准备

1. 一个 bot：跟 [@BotFather](https://t.me/BotFather) 说 `/newbot`，拿到 token。
2. 你自己的 Telegram user id（可以问 [@userinfobot](https://t.me/userinfobot)）。
3. `pnpm` 在 PATH 上（两种 Host 的插件命令都转发给它）。
4. 走源码或独立进程时：Node.js ≥ 22.6（直接用 Node 的类型剥离跑 `.ts` 源码）。

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

默认读 `$DSH_HOME/config/dsh-telegram/config.json`（DSH 是 `~/.dsh`，呼啦啦是
`~/.hulala/harness`；可用 `HULALA_TELEGRAM_CONFIG` 覆盖）：

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

装好之后桥随 Host 起落，不需要单独启动。日志里出现 `bridge starting inside the Host`
就是已经在轮询了。

**一个 bot token 只能有一个轮询者，跨 home 生效**：锁按 token 的摘要放在
`~/.dsh-telegram/<hash>.lock`，不在任何一个 home 里。所以 DSH（`~/.dsh`）和呼啦啦
（`~/.hulala/harness`）两边都装了插件时，第二个会报
`already being polled by another Host (pid …)` 并待命，而不是两边抢到 409、随机丢消息。

排查时先看 Host 日志里有没有 `dsh-telegram` 开头的行；想对真实 Host 跑一遍，用
`node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>`。

### 网络：DNS 污染与代理

`api.telegram.org` 在部分网络下会被污染到无关 IP，直连必然失败。Node 的 `fetch` 默认**不读**
`HTTP_PROXY`/`HTTPS_PROXY`；Node ≥ 24 用环境变量代理要显式开启。插件跑在 Host 进程里，
所以这个变量要加在**启动 Host 的环境**上：

```bash
NODE_USE_ENV_PROXY=1 dsh --profile tui
NODE_USE_ENV_PROXY=1 hulala
```

没有代理的机器上这个开关是无害的。

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

包按 `package.json` 的 `engines.dsh` 声明范围（当前 `>=0.2.2-rc.1 <0.3.0`）。装载器在
**导入模块之前**比较，不满足就跳过该层并在 `skippedBundles` 里报出包名、版本和原因，
Host 的其余部分照常启动。DSH 包是 peer 依赖，解析到宿主那一份，不会出现第二个注册表。

自查：`dsh <profile> --dump-config` 里有没有 `# == dsh-telegram`，以及日志里有没有
`skippedBundles`。

## 开发

```bash
node --test "tests/*.test.ts"                                  # 73 个用例
node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>      # 对真 Host 跑一轮
```

`tests/fakes.ts` 里的假 Host 实现了 bridge 用到的那几个 Remote 方法，所以桥的行为可以在
没有 Host、没有网络、没有 token 的情况下测。

## 许可

GPL-3.0-only。依赖：DSH 的客户端包（MIT）、`ws`（MIT）、`@deepseek-ai/cordis`（MIT）。
