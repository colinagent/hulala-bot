# hulala-bot

把这个机器上的 DeepSeek Harness agent 接到 **Telegram** 和 **飞书 / Lark** 上。手机发一句话，本机的 Host 执行，回复流式回到同一个对话；`/cwd` 切换这个对话挂载哪个会话——和 TUI 里切换会话是同一件事。

DSH 原生和呼啦啦都用同一种方式接：**装成 Host 插件**，进 profile，随 Host 起落。

## 它是什么

**一个 Host 插件**，改不到 DSH 一行代码。它跑在 Host 进程里，直接调宿主服务：

```
ctx.sessionController.list / create / prompt / follow   → 会话与流式
ctx.workspaceController.create                          → 工作目录
ctx.on('approval/request', (req, next) => …)            → 审批
```

没有端口、token、cookie、WebSocket（飞书那条长连接是飞书自己的事件通道，不是本机服务）：插件就在 Host 里，`/cwd`、流式回复、审批都不需要跨进程通信。会话历史、cwd、模型、权限以 Host 为真源；这里只保存「哪个对话挂了哪个会话」。

**一条代码，两个渠道**：`src/channel.ts` 是唯一的渠道契约，Telegram 和飞书各自实现它（id 形状、markdown 方言、流式方式、按钮回调都不同），`src/bridge.ts` 里的会话逻辑两边共用。两个渠道可以同时开，各自维护允许名单和会话挂载；Telegram 的对话和飞书的对话是两个独立会话，不合并身份。

**多端同时在线是正常的**：TUI 和手机可以挂同一个会话，两边看到同一段历史。审批由 Host 内应答；如果两端都开着，先答的生效，另一端收到「已在其他端处理」。

## 安装

包是 `@colinagent/hulala-bot`，两种 Host 装的是同一个。

### 呼啦啦（一条命令）

```sh
hulala install bot
# 等价于：hulala plugin --profile tui add @colinagent/hulala-bot
hulala plugin --profile tui exec hulala-bot --init
# 重启 Host
```

### DSH（Web / Desktop / TUI）

```sh
dsh plugin --profile tui add @colinagent/hulala-bot
dsh plugin --profile tui exec hulala-bot --init
# 重启 Host
```

`--init` 只写允许名单、`defaultCwd` 和凭据在钥匙串里的**引用**，不写 token / app secret；允许名单为空时拒绝写入——没有它，任何人都能驱动 agent。

没有终端时用参数（两条渠道可以只配一条）：

```sh
# Telegram
hulala plugin --profile tui exec hulala-bot --init --no-input \
  --telegram-token-ref telegram/bot-token \
  --telegram-allowed-user 123456789 \
  --default-cwd ~/hulala-workspace/workspace

# 飞书 / Lark
hulala plugin --profile tui exec hulala-bot --init --no-input \
  --lark-app-id cli_0123456789abcdef \
  --lark-app-secret-ref lark/app-secret \
  --lark-allowed-user ou_0123456789abcdef0123456789abcdef
```

`--init` 只改它拿到的那条渠道，另一条原样保留；允许名单/其它字段也按已有内容合并，所以改一个代理不会把白名单清掉。

装完核对：

```sh
hulala plugin --profile tui list          # 依赖里有 @colinagent/hulala-bot
```

卸载：`hulala plugin --profile tui remove @colinagent/hulala-bot`，然后重启 Host。

**自动识别**：如果你在自己的 DSH 里也装了同一个插件，呼啦啦启动时会读 `~/.dsh/profiles/<同名>/package.json`，把用户额外装的 bundle 链接进自己的组合，所以不需要再装一遍。反过来不成立——呼啦啦里装的插件不会出现在 DSH 里。

## 准备

### Telegram

1. 一个 bot：跟 [@BotFather](https://t.me/BotFather) 说 `/newbot`，拿到 token。
2. 你自己的 Telegram user id（可以问 [@userinfobot](https://t.me/userinfobot)）。
3. 网络到不了 `api.telegram.org` 时配 `proxy`（见下）。

token 放系统钥匙串：

```bash
security add-generic-password -U -s telegram -a bot-token -w '123456:ABC…'   # macOS
secret-tool store --label 'telegram bot' service telegram account bot-token  # Linux
```

也可以临时用环境变量：`TELEGRAM_BOT_TOKEN=…`。

### 飞书 / Lark

配置由用户自己在开发者后台完成，这里只说明需要什么：

1. 在 [飞书开放平台](https://open.feishu.cn)（国际版是 [Lark](https://open.larksuite.com)）建一个**企业自建应用**，拿到 App ID（`cli_` + 16 位十六进制）和 App Secret。
2. **开启机器人能力**。
3. **权限**：至少 `im:message`（读发给机器人的消息）与 `im:message:send_as_bot`（以应用身份发消息、更新自己发的卡片）。后台会按实际接口提示还缺哪一项。
4. **事件与回调 → 订阅方式：使用长连接接收事件**。订阅 `im.message.receive_v1`，并添加卡片回调 `card.action.trigger`（审批按钮靠它回来）。**不要**配 webhook 地址：长连接是唯一不需要公网入口的方式。
5. 发布一个版本，把可用范围设成你自己（或团队），然后在飞书里搜到机器人，单聊或拉进群（群里必须 @ 它）。

App secret 同样放钥匙串：

```bash
security add-generic-password -U -s lark -a app-secret -w '…'
```

国际版在配置里加 `"domain": "lark"`，Open API 会指向 `open.larksuite.com`。

**怎么拿到自己的 open id**：先随便给机器人发一条消息，日志里会出现
`ignored chat=oc_… from=ou_… (not in allowlist)`，把 `ou_…` 填进 `allowedUsers` 再重启。

## 配置在哪

状态目录是 `$DSH_HOME/config/hulala-bot/`（DSH 是 `~/.dsh`，呼啦啦是 `~/.hulala/harness`）。

`config.json`、`bindings.json`、`receipts/`、`logs/` 都在里面，权限 `0600`/`0700`。连接锁不在其中：它按凭据摘要放在 `~/.hulala-bot/<hash>.lock`，所以 DSH 和呼啦啦两边都装了插件时，同一时刻也只有一个 Host 在轮询/连长连接。

默认读同目录的 `config.json`（可用 `HULALA_BOT_CONFIG` 覆盖）：

```json
{
  "defaultCwd": "~/hulala-workspace/workspace",
  "streamIntervalMs": 800,
  "telegram": {
    "tokenRef": "telegram/bot-token",
    "allowedUsers": [123456789],
    "parseMode": "markdown",
    "proxy": "http://127.0.0.1:7897"
  },
  "lark": {
    "appId": "cli_0123456789abcdef",
    "appSecretRef": "lark/app-secret",
    "domain": "feishu",
    "allowedUsers": ["ou_0123456789abcdef0123456789abcdef"]
  }
}
```

顶层：

| 字段 | 说明 |
|---|---|
| `defaultCwd` | 第一次说话时在哪个目录建会话 |
| `streamIntervalMs` | 同一条消息两次编辑的最小间隔，默认 800ms（飞书的卡片更新有频率限制，别调太低） |

`telegram`：

| 字段 | 说明 |
|---|---|
| `tokenRef` / `tokenEnv` | 钥匙串引用或环境变量名 |
| `allowedUsers` | Telegram user id。与 `allowedChats` 都为空时拒绝启动 |
| `allowedChats` | chat id（群/频道场景） |
| `parseMode` | `markdown`（代码块正常显示，失败自动退回纯文本）或 `plain` |
| `proxy` | HTTP/HTTPS 代理，形如 `http://127.0.0.1:7897`；支持 `用户:密码@`。不读 `HTTPS_PROXY`，只认这一项 |
| `baseUrl` | 只给测试用：把 Bot API 指向假服务器 |
| `pollTimeoutSeconds` | 长轮询等待秒数，默认 25 |

`lark`：

| 字段 | 说明 |
|---|---|
| `appId` | `cli_` + 16 位十六进制；格式不对会在启动前报出来，而不是静默连不上 |
| `appSecretRef` / `appSecretEnv` | 钥匙串引用或环境变量名 |
| `domain` | `feishu`（默认）或 `lark`（国际版） |
| `allowedUsers` | 允许驱动的 open id（`ou_…`）。与 `allowedChats` 都为空时拒绝启动 |
| `allowedChats` | 允许驱动的 chat id（`oc_…`） |
| `baseUrl` | 只给测试用 |

`proxy` 只接受 `http://` 或 `https://`（Clash、Surge、V2RayN 的 HTTP 端口都是这个形状）；SOCKS5 不支持。请求走 CONNECT 隧道，配置写错会在启动时直接报错，而不是悄悄直连。

状态文件同目录：`bindings.json`（挂载表，键是 `渠道:chat id[:主题]`）、`receipts/`（入站去重账本，24h TTL，两个渠道各一份）、`logs/`。全部 `0600`，凭据在写日志前就被替换成 `<secret>`。

## 运行

装好之后随 Host 起落，不需要单独启动。日志里出现
`bot starting inside the Host; channels telegram, lark` 就是两条都在跑了。

**一个凭据只能有一个连接，跨 home 生效**：锁按 token / app id 的摘要放在
`~/.hulala-bot/<hash>.lock`。DSH（`~/.dsh`）和呼啦啦（`~/.hulala/harness`）两边都装了插件时，第二个会报
`already connected from another Host (pid …)` 并待命，而不是两边抢同一条事件流、随机丢消息。

### 网络：DNS 污染与代理

`api.telegram.org` 在部分网络下会被污染到无关 IP，直连必然失败。Node 的 `fetch` 默认**不读** `HTTP_PROXY`/`HTTPS_PROXY`；配 `telegram.proxy` 就够，不用给 Host 加环境变量。

## 命令

两个渠道命令一样：

| 命令 | 行为 |
|---|---|
| `/cwd` | 弹出最近用过的目录，点一个就挂上去 |
| `/cwd <path>` | 换挂载：该目录下最近的会话，没有就新建 |
| `/new` | 在当前目录新建会话 |
| `/sessions` | 最近 10 个会话，`*` 表示当前 |
| `/switch <n>` | 切到第 n 个 |
| `/status` | 会话、目录、运行状态 |
| `/stop` | 停止当前回合 |
| `/help` | 上面这些 |

直接发文字就是提问。第一次说话会自动在 `defaultCwd` 里建一个会话并挂上。

## 两个渠道的差异

| | Telegram | 飞书 / Lark |
|---|---|---|
| 传输 | Bot API 长轮询 | 长连接（WebSocket） |
| 流式 | 反复编辑同一条消息 | 反复 patch 同一张卡片（飞书**不能**编辑文本消息） |
| 按钮 | inline keyboard | 卡片 `action` 按钮 + `card.action.trigger` 回调 |
| 置顶状态栏 | 有（`📍 <目录>`） | 无；用 `/status` 看 |
| "正在输入" | 有 | 飞书没有这个 API |
| 单条上限 | 4096（内部按 4000 切） | 4000 字符一张卡片，超了续卡片 |
| 群聊 | 直接收 | 必须 @ 机器人，文本里的 `@_user_1` 会被去掉 |

## 行为细节

- **一条回合一条消息**：回合开始发占位，之后反复编辑；回合结束用会话日志里的正式文本替换。超长续消息，并在代码块边界处断开、补齐围栏。
- **工具调用**：还没有文本时显示 `· bash …`，让手机知道在干什么。
- **编辑退避**：连续 3 次编辑失败就关掉流式，回合结束一次性发送；限流按服务器给的等待时间退避。
- **入站去重**：Telegram 的 update 在 ack 丢失时会重投 24 小时，飞书长连接重连也可能重放，同一条消息不会喂给 agent 两次。
- **审批**：卡片只有「允许这一次 / 拒绝」。请求里没有命令行文本，只有工具名与理由；要显示具体命令需要按 `callId` 去会话日志取。跨端取消只在 Host 内的客户端之间生效，插件模式下手机上的卡片不会被远程收走（另一端点过之后会显示「已在其他端处理」）。
- **提问**：`ask_user_question` 会在手机上显示问题和选项，但只做通知——回答请回到 TUI/Desktop。

## 安全边界

- 白名单是唯一的口令。允许名单为空时该渠道拒绝启动。
- 消息正文、工具输出、贴出的路径都会经过 Telegram / 飞书的服务器。敏感仓库请用 `allowedUsers` 限制到私人会话，并考虑关掉流式预览。
- 这个插件不给 Host 增加任何权限：它能做的事，TUI 也能做。
- 权限策略仍由 Host 的 permission preset 决定，这里不改写、不绕过。

## 与 Host 版本的关系

包按 `package.json` 的 `engines.dsh` 声明范围（当前 `>=0.2.2-rc.1 <0.3.0`）。装载器在**导入模块之前**比较，不满足就跳过该层并在 `skippedBundles` 里报出包名、版本和原因，Host 的其余部分照常启动。DSH 包是 peer 依赖，解析到宿主那一份，不会出现第二个注册表。

安装本身要求 `pnpm` 在 PATH 上——DSH 的 `dsh plugin` 与呼啦啦的 `hulala plugin`（以及 `hulala install bot`）都转发给它。

## 开发

```bash
node --test "tests/*.test.ts"                                  # 106 个用例
node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>      # 对真 Host 跑一轮
```

飞书的 REST 调用用注入的 `fetch` 测；长连接用假的 transport 测，测试不需要租户、不需要网络。

## 许可

GPL-3.0-only。它链接的是 GPL 的 DeepSeek Harness / Hulala，不是专有代码。
