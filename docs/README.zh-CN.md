# hulala-bot

[English](https://github.com/colinagent/hulala-bot/blob/main/README.md) | 简体中文

把这个机器上的 DeepSeek Harness agent 接到 **Telegram** 和 **飞书 / Lark** 上。手机发一句话，本机的 Host 执行，回复流式回到同一个对话；`/cwd` 切换这个对话挂载哪个会话——和 TUI 里切换会话是同一件事。

DSH 原生和呼啦啦都用同一种方式接：**装成 Host 插件**，进 profile，随 Host 起落。

---

## 让 AI 帮你配

这个文件就是给 AI 看的说明书：命令、配置项、期望输出、报错原文都写在里面。把下面这段发给你的 AI（Claude Code、Cursor、ChatGPT 都行），它会照着做：

```text
帮我配置 hulala-bot（一个把 Telegram / 飞书接到本机 DeepSeek Harness 的插件）。
请先完整读 https://github.com/colinagent/hulala-bot/blob/main/docs/README.zh-CN.md 的说明，然后按顺序执行：

1. 检查环境：node -v（>=22.6）、pnpm -v、hulala --version
2. 按「安装」一节装插件（呼啦啦用 hulala install bot；没有这条命令就用 hulala plugin）
3. 按「配置」一节写 config.json；凭据只进系统钥匙串，不要让我把 token 贴进聊天，也不要写进 config.json
4. 重启 Host
5. 按「验证清单」逐条确认，每一步把实际输出贴给我
6. 任何一步失败，按「故障排查」的原文匹配原因，不要猜

规则：不要发明 README 之外的命令、配置项、权限或事件；缺信息就停下来问我。
```

给 AI 的三条硬规则，README 里也有对应依据：

1. **凭据只进钥匙串**，配置文件里只放 `tokenRef` / `appSecretRef`（`<service>/<account>`）。
2. **允许名单不能为空**：空名单会被拒绝启动，这不是可以跳过的步骤。
3. **改完配置必须重启 Host**：插件在启动时读取配置，没有热加载。

---

## 它是什么

**一个 Host 插件**，不 patch DSH 一行代码。它跑在 Host 进程里，直接调宿主服务：

```
ctx.sessionController.list / create / prompt / follow   → 会话与流式
ctx.workspaceController.create                          → 工作目录
ctx.on('approval/request', (req, next) => …)            → 审批
```

没有端口、token、cookie、WebSocket（飞书那条长连接是飞书自己的事件通道，不是本机服务）。会话历史、cwd、模型、权限以 Host 为真源；这里只保存「哪个对话挂了哪个会话」。

**一份代码，两个渠道**：`src/channel.ts` 是渠道契约，`src/telegram/`、`src/lark/` 各自实现，`src/bridge.ts` 的会话逻辑两边共用。两个渠道可以同时开，各自有允许名单和挂载表；Telegram 的对话和飞书的对话是两个独立会话，不合并身份。

---

## 安装

先检查环境：

```sh
node -v     # 需要 >= 22.6
pnpm -v     # 安装走 pnpm；没有就先装
hulala --version
```

### 呼啦啦

```sh
hulala install bot
# 老版本没有这条命令时，等价写法：
hulala plugin --profile tui add @colinagent/hulala-bot
```

`hulala install bot` 只是把 profile 名（`tui`）和包名填好的快捷方式，安装仍由 DSH 的 `runPluginCommand` 完成。

### DSH（Web / Desktop / TUI）

```sh
dsh plugin --profile tui add @colinagent/hulala-bot
```

**期望输出**：最后一行出现 `profile tui: @deepseek-ai/dsh-base, @colinagent/hulala-bot` 和 `Restart the Host for the change to take effect.`

装完核对：

```sh
hulala plugin --profile tui list    # 依赖里有 @colinagent/hulala-bot
```

卸载：`hulala plugin --profile tui remove @colinagent/hulala-bot`，然后重启 Host。

---

## 配置

配置写在 `$DSH_HOME/config/hulala-bot/config.json`：

| Host | 实际路径 |
|---|---|
| 呼啦啦 | `~/.hulala/harness/config/hulala-bot/config.json` |
| DSH | `~/.dsh/config/hulala-bot/config.json` |

用 `--init` 写，不要手写整个文件（它会校验、合并、设置 `0600` 权限）：

```sh
# 呼啦啦
hulala plugin --profile tui exec hulala-bot --init

# DSH
dsh plugin --profile tui exec hulala-bot --init
```

有终端时它会逐项提问；没有终端（或加 `--no-input`）时用参数。**两条渠道可以只配一条**，也可以都配。

### Telegram

先准备：跟 [@BotFather](https://t.me/BotFather) 说 `/newbot` 拿 token；自己的 user id 可以问 [@userinfobot](https://t.me/userinfobot)。

token 放系统钥匙串（**不要**写进 config.json）：

```bash
# macOS
security add-generic-password -U -s telegram -a bot-token -w '123456:ABC…'
# Linux
secret-tool store --label 'telegram bot' service telegram account bot-token
```

写配置：

```sh
hulala plugin --profile tui exec hulala-bot --init --no-input \
  --telegram-token-ref telegram/bot-token \
  --telegram-allowed-user 123456789 \
  --default-cwd ~/hulala-workspace/workspace
```

国内网络需要代理时加 `--proxy http://127.0.0.1:7897`（只支持 HTTP/HTTPS，SOCKS5 会在启动前报错）。

也可以临时用环境变量代替钥匙串：`TELEGRAM_BOT_TOKEN=…`，或配置里的 `tokenEnv` 指定变量名。

### 飞书 / Lark

配置由你在开发者后台完成，插件这边只填 app id 和允许名单。

1. 在 [飞书开放平台](https://open.feishu.cn)（国际版 [Lark](https://open.larksuite.com)）建一个**企业自建应用**，拿到 App ID（`cli_` + 16 位十六进制）和 App Secret。
2. 开启**机器人能力**。
3. 权限至少：`im:message`、`im:message:send_as_bot`。后台会按实际接口提示还缺哪一项。
4. **事件与回调 → 订阅方式：使用长连接接收事件**。订阅 `im.message.receive_v1`，并添加卡片回调 `card.action.trigger`。**不要**配 webhook 地址。
5. 发布版本，把可用范围设成你自己（或团队），然后在飞书里单聊机器人或把它拉进群（群里必须 @ 它）。

App secret 放钥匙串：

```bash
security add-generic-password -U -s lark -a app-secret -w '…'
```

写配置：

```sh
hulala plugin --profile tui exec hulala-bot --init --no-input \
  --lark-app-id cli_0123456789abcdef \
  --lark-app-secret-ref lark/app-secret \
  --lark-allowed-user ou_0123456789abcdef0123456789abcdef
```

国际版加 `--lark-domain lark`（Open API 指向 `open.larksuite.com`）。

**不知道自己的 open id**：先随便给机器人发一条消息，然后看日志里的

```
ignored chat=oc_… from=ou_… (not in allowlist)
```

把 `ou_…` 填进允许名单（重跑 `--init --lark-allowed-user ou_…`），重启 Host。

### `--init` 参数

| 参数 | 说明 |
|---|---|
| `--telegram-token-ref <service/account>` | 钥匙串引用，默认示例 `telegram/bot-token` |
| `--telegram-token-env <NAME>` | 改从环境变量读 token |
| `--telegram-allowed-user <id[,id]>` | 允许的 Telegram user id（可重复） |
| `--telegram-allowed-chat <id[,id]>` | 允许的 chat id |
| `--proxy <http://…>` | Telegram 走的 HTTP/HTTPS 代理 |
| `--parse-mode markdown\|plain` | Telegram 回复格式，`markdown` 失败会自动退回纯文本 |
| `--lark-app-id <cli_…>` | 飞书应用 App ID |
| `--lark-app-secret-ref <service/account>` | app secret 的钥匙串引用 |
| `--lark-app-secret-env <NAME>` | 改从环境变量读 app secret |
| `--lark-allowed-user <ou_…[,ou_…]>` | 允许的 open id |
| `--lark-allowed-chat <oc_…[,oc_…]>` | 允许的 chat id |
| `--lark-domain feishu\|lark` | 国内飞书（默认）或国际版 |
| `--default-cwd <path>` | 第一次说话时在哪个目录建会话 |
| `--no-input` | 不提问；缺参数直接报错 |

`--init` **按渠道合并**：只改它拿到的那条渠道，另一条和已有的允许名单/未知字段原样保留。所以补一个代理、加一个用户都不用重写整个文件。

### 文件结构

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
| `streamIntervalMs` | 两次流式更新的最小间隔，默认 800ms（飞书卡片有频率限制，别调太低） |

`telegram`：

| 字段 | 说明 |
|---|---|
| `tokenRef` / `tokenEnv` | 钥匙串引用或环境变量名 |
| `allowedUsers` | Telegram user id；与 `allowedChats` 都为空时拒绝启动 |
| `allowedChats` | chat id（群/频道场景） |
| `parseMode` | `markdown`（默认，失败自动回退）或 `plain` |
| `proxy` | HTTP/HTTPS CONNECT 代理；不读 `HTTPS_PROXY`，只认这一项 |
| `baseUrl` | 只给测试用 |
| `pollTimeoutSeconds` | 长轮询等待秒数，默认 25 |

`lark`：

| 字段 | 说明 |
|---|---|
| `appId` | `cli_` + 16 位十六进制；格式不对在连网前就报错 |
| `appSecretRef` / `appSecretEnv` | 钥匙串引用或环境变量名 |
| `domain` | `feishu`（默认）或 `lark` |
| `allowedUsers` | open id（`ou_…`）；与 `allowedChats` 都为空时拒绝启动 |
| `allowedChats` | chat id（`oc_…`） |
| `baseUrl` | 只给测试用 |

环境变量：`HULALA_BOT_CONFIG`（配置文件路径）、`HULALA_BOT_STATE`（状态目录）、`HULALA_BOT_LOCK_DIR`（锁目录）、`TELEGRAM_BOT_TOKEN`、`LARK_APP_SECRET`。

---

## 重启与验证

配置和插件都只在 Host 启动时读取，**改完必须重启**：

```sh
hulala host stop
hulala host start
# DSH：重启你自己的 dsh 进程
```

### 验证清单

```sh
# 1. 插件在 profile 里
hulala plugin --profile tui list
# 期望：@deepseek-ai/dsh-base, @colinagent/hulala-bot

# 2. Host 起来了
hulala host status
# 期望："state": "running"

# 3. 插件真的加载了
grep "bot starting inside the Host" ~/.hulala/logs/host.log | tail -1
# 期望：bot starting inside the Host; channels telegram
#       （配了飞书就是 channels telegram, lark）

# 4. 连接锁只有一个持有者
ls ~/.hulala-bot/*.lock
# 期望：每条渠道一个 .lock；内容是本机 Host 的 pid

# 5. 给机器人发一句话
# 期望：先出现占位消息，然后被流式替换成回答；TUI 里能看到同一个会话
```

飞书额外确认：

```sh
# 日志里有没有收到事件（首次配置时会有 ignored … not in allowlist）
tail -f ~/.hulala/harness/config/hulala-bot/logs/bridge-$(date +%F).log
```

日志位置：`~/.hulala/harness/config/hulala-bot/logs/`（DSH 在 `~/.dsh/config/hulala-bot/logs/`）。

---

## 故障排查

先看这两个地方，90% 的问题能直接定位：

```sh
tail -50 ~/.hulala/harness/config/hulala-bot/logs/bridge-$(date +%F).log
grep -i "hulala-bot" ~/.hulala/logs/host.log | tail -20
```

| 症状 / 报错原文 | 原因 | 处理 |
|---|---|---|
| `no channel configured: add a "telegram" or "lark" section` | 配置文件不存在或两段都没有 | 跑 `--init`，或检查 `HULALA_BOT_CONFIG` 指向的路径 |
| `refusing to start Telegram with an empty allowlist` | 允许名单为空（拒绝是设计行为） | 加 `--telegram-allowed-user` |
| `no Telegram bot token: set tokenRef …` | 钥匙串里没有条目，或引用名写错 | `security find-generic-password -s telegram -a bot-token -w` 确认；名字要和 `tokenRef` 一致 |
| `lark.appId must look like cli_<16 hex>` | App ID 复制错/不是自建应用 | 回开发者后台复制 `cli_` + 16 位十六进制 |
| `no Lark app secret: set lark.appSecretRef …` | 同上，secret 没进钥匙串 | 存 `lark/app-secret`，或设 `LARK_APP_SECRET` |
| `this bot is already connected from another Host (pid …)` | 另一个 Host（DSH 或旧进程）正在用同一 token/app id | 停掉那个进程；确认它已退出后删掉报错里给出的 `.lock` |
| Telegram 报 `getUpdates: Conflict: … (409)` | 两个进程在轮询同一个 bot token | 同上；另外检查有没有旧的独立桥进程 |
| `proxy CONNECT failed: 403` | 代理拒绝 CONNECT | 检查代理是否允许该目标/是否要认证（`http://user:pass@host:port`） |
| `connect ECONNREFUSED 127.0.0.1:7897` | 代理端口没开 | 启动 Clash/Surge，或改 `proxy` |
| 飞书机器人完全不回话 | ① 订阅方式不是「长连接」② 没订阅 `im.message.receive_v1` ③ 没开机器人能力 ④ 可用范围不含你 ⑤ App Secret 错 | 按这五条逐项查；secret 错会在日志里出现 `99991663` 或 `tenant_access_token` 相关错误 |
| 飞书私聊正常、群里不回 | 群里必须 @ 机器人 | @ 它再发；命令前可以带 @ |
| 飞书审批按钮没反应 | 没添加 `card.action.trigger` 回调 | 后台补上这个回调，重启 Host |
| 流式很慢 / 频繁限流 | `streamIntervalMs` 低于平台限制 | 调到 800 以上（飞书卡片更新有频率限制） |
| 回复出现 `☑️ 已处理` | 这个审批已经在另一端处理过 | 正常，不是错误 |
| 日志里 `ignored … (not in allowlist)` | 发送者不在名单里 | 用日志里的 id 补进允许名单并重启 |
| 重启后行为没变 | 插件只在启动时读配置 | 确认进程真的重启了（`hulala host status` 的 pid 变了） |

调试用的日志行会带渠道名前缀：`telegram`、`lark`。凭据在写日志前会被替换成 `<secret>`，不会出现在文件里。

---

## 命令

两个渠道命令一样：

| 命令 | 行为 |
|---|---|
| `/cwd` | 列出最近用过的目录，点一个就挂上去 |
| `/cwd <path>` | 换挂载：该目录下最近的会话，没有就新建 |
| `/new` | 在当前目录新建会话 |
| `/sessions` | 最近 10 个会话，`*` 表示当前 |
| `/switch <n>` | 切到第 n 个 |
| `/status` | 会话、目录、运行状态 |
| `/stop` | 停止当前回合 |
| `/help` | 上面这些 |

直接发文字就是提问。第一次说话会自动在 `defaultCwd` 里建会话并挂上。

审批会以按钮出现（Telegram inline keyboard / 飞书卡片按钮），只有「允许这一次 / 拒绝」。请求里没有命令行文本，只有工具名与理由。

---

## 两个渠道的差异

| | Telegram | 飞书 / Lark |
|---|---|---|
| 传输 | Bot API 长轮询 | 长连接（WebSocket） |
| 流式 | 反复编辑同一条消息 | 反复 patch 同一张卡片（飞书不能编辑文本消息） |
| 按钮 | inline keyboard | 卡片 `action` + `card.action.trigger` |
| 置顶状态栏 | 有（`📍 <目录>`） | 无；用 `/status` 看 |
| "正在输入" | 有 | 飞书没有这个 API |
| 单条上限 | 4096（内部按 4000 切） | 4000 字符一张卡片，超了续卡片 |
| 群聊 | 直接收 | 必须 @ 机器人 |

两个渠道可以同时开：各自挂各自的会话，审批同时出现在两边，先点的生效，另一边显示「已在其他端处理」。

---

## 状态与安全

- **状态目录**：`$DSH_HOME/config/hulala-bot/`，里面有 `config.json`、`bindings.json`（挂载表）、`receipts/`（去重账本，24h TTL）、`logs/`，权限 `0600`/`0700`。
- **连接锁**：`~/.hulala-bot/<凭据摘要>.lock`，不在状态目录里，所以 DSH 和呼啦啦同时装插件时也只有一个在连。
- **凭据**：只进钥匙串（或环境变量），日志写之前替换成 `<secret>`。
- **边界**：白名单是唯一口令；消息正文、工具输出、贴出的路径都会经过 Telegram / 飞书的服务器。插件不给 Host 增加权限——它能做的事，TUI 也能做；权限仍由 Host 的 preset 决定。
- **跨端取消**：插件模式下，另一端已经处理过的审批不会从这边被远程收走，只会在下次交互时显示「已在其他端处理」。

---

## 开发

```bash
node --test "tests/*.test.ts"                                  # 106 个用例
bun run typecheck
bun run build                                                  # dist/index.mjs + dist/plugin.mjs
node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>      # 对真 Host 跑一轮
```

需要 Node ≥ 22.6。飞书的 REST 用注入的 `fetch` 测，长连接用假 transport 测，测试不需要租户、不需要网络。

版本约束：`engines.dsh` 声明 DSH 兼容范围（当前 `>=0.2.2-rc.1 <0.3.0`），装载器在 import 之前校验，不满足就跳过并写进 `skippedBundles`；`@deepseek-ai/dsh-*` 必须是 peerDependencies，避免出现第二份注册表。

更细的架构与坑：见仓库里的 `AGENTS.md`。

## 许可

GPL-3.0-only。它链接的是 GPL 的 DeepSeek Harness / Hulala，不是专有代码。
