# hulala-bot

把一台机器上正在运行的 DeepSeek Harness Host 接到 **Telegram** 和 **飞书 / Lark**：手机发一句话，Host 里的 agent 执行，回复流式回来；`/cwd` 切换这个对话挂载哪个会话，和 TUI 里切换会话是同一件事。

## 它是什么，不是什么

**一个 Host 插件，两条渠道，一套会话逻辑**：

- `src/host/plugin.ts` 跑在 Host 进程内，直接调 `sessionController` / `workspaceController`，用 `ctx.on('approval/request')` 应答审批；
- `src/host/local-remote.ts` 把宿主服务包成 `ctx.remote` 的形状，`bridge.ts` 不认识第二种载体；
- `src/channel.ts` 是渠道契约，`src/telegram/`、`src/lark/` 各自实现；`src/bridge.ts` 只管会话、命令、审批，不知道 markdown 方言和 id 形状；
- 没有端口、token、cookie，也没有独立进程可启动。飞书的长连接是飞书自己的事件通道，不是本机服务。

不是：

- 不改、不 patch、不 fork DeepSeek Harness，`~/note/projects/refs/deepseek-harness` 是只读参考；
- 不发明会话租约/接管/独占，也不做跨渠道身份合并。多端同时挂同一个会话是 DSH 官方语义；Telegram 的对话和飞书的对话是两个独立会话；
- 不自己拉起 Host，也不自带守护逻辑：Host 起，bot 起；Host 停，bot 停。

会话历史、cwd、模型、权限以 Host 为真源；这里只持久化「哪个对话挂了哪个会话」、去重账本和日志。

## 命令

```bash
node --test "tests/*.test.ts"      # 106 个用例；假 Host + FakeTelegram + 假飞书平台/transport
bun run typecheck
bun run build                      # dist/index.mjs（--init）与 dist/plugin.mjs（Host 插件）
node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>   # 对真 Host 跑一轮
```

需要 Node ≥ 22.6。`bun:test` 与 tsc 的类型定义冲突，测试用 `node --test`。

## 目录

| 路径 | 职责 |
|---|---|
| `src/host/plugin.ts` | Host 插件入口：按配置建渠道、起 bridge、随 Host 释放 |
| `src/host/local-remote.ts` | 把宿主服务包成 `bridge.ts` 认识的那几个调用 |
| `src/host/turn.ts` | 回合跟踪、工具调用的中文标签 |
| `src/channel.ts` | 渠道契约（`ChatKey`、`Outgoing`、`InboundEvent`） |
| `src/bridge.ts` | 命令、挂载、流式、审批卡片、回调 |
| `src/reply.ts` | 渠道无关的流式消息：节流、预览、失败降级、超长续发 |
| `src/telegram/api.ts` | Bot API（429 `retry_after`、可中断的长轮询） |
| `src/telegram/channel.ts` | MarkdownV2、inline keyboard、置顶状态、typing、update 去重 |
| `src/telegram/proxy.ts` | HTTP/HTTPS CONNECT 隧道 fetch（两个渠道共用） |
| `src/lark/api.ts` | 开放平台 REST：tenant token 缓存、发卡片、patch 卡片、撤回 |
| `src/lark/channel.ts` | 飞书渠道：卡片、open id 白名单、回调 toast |
| `src/lark/card.ts` | 卡片 JSON、`@_user_N` 清理 |
| `src/lark/ws.ts` | 官方 SDK 的长连接，事件收敛成 `LarkMessageEvent` / `LarkActionEvent` |
| `src/store/ledger.ts` | 入站去重账本（24h TTL，字符串 id，两个渠道共用） |
| `src/store/bindings.ts` | `渠道:chat[:topic]` → session 挂载表 |
| `src/store/lock.ts` | 凭据级连接锁（跨 home） |
| `src/render/` | MarkdownV2 投影、fence 感知分片 |

状态目录是 `$DSH_HOME/config/hulala-bot/`（DSH 是 `~/.dsh`，呼啦啦是 `~/.hulala/harness`）；`config.json`、`bindings.json`、`receipts/`、`logs/` 都在里面，`0600`/`0700`。**连接锁不在状态目录**：按 token / app id 摘要放在 `~/.hulala-bot/<hash>.lock`，这样 DSH 与呼啦啦两边都装了插件时也只有一个在连。凭据只存系统钥匙串，不进配置文件、不进日志；配置用 `--init` 写，拒绝空允许名单。`telegram.proxy` 是 HTTP/HTTPS CONNECT 代理（`http://127.0.0.1:7897` 这种），单列一项而不是读环境变量：Host 的环境属于用户，插件不该偷偷改 `HTTPS_PROXY`。

## 版本约束

`package.json` 的 `engines.dsh`（`>=0.2.2-rc.1 <0.3.0`）。装载器在 import 之前校验，不匹配就跳过并向 `skippedBundles` 报告；`@deepseek-ai/dsh-*` 必须是 **peerDependencies**，否则 profile 里会出现第二份，`Remote` 注册表就分裂了。`@larksuiteoapi/node-sdk` 只在长连接里动态 import，构建时标记为 external，所以只装 Telegram 的机器也用得上 `--init`。

改 DSH 依赖版本时跟着上游 minor 走，并在真机上重跑 `scripts/spike-host.ts`。

## 三个不显然的坑

1. **必须 `ctx.typert.contexts.registerClient('agent', { identity: () => undefined, resolve: () => ctx })`**，否则 waterfall 会被 Gateway 静默丢弃——不报错，只是永远收不到。
2. **`const on = ctx.remote.$on` 会丢 Cordis shadow-method 的 `this`**，报错会说「requires interactions=answer」，实际是解绑了。永远写成 `ctx.remote.$on(...)`。
3. **本机默认 permission preset 直接放行危险命令**，所以 `rm -rf` 不会触发审批卡片；真机验审批要先切到 `workspace-write`。

## 飞书的三个硬约束

1. **文本消息改不了**。流式只能走交互卡片 + `PATCH /open-apis/im/v1/messages/:message_id`，所以每一轮都是一张卡片，未完成时反复 patch。没有置顶状态栏、没有 typing 指示。
2. **事件必须走长连接**。Host 只绑 loopback，webhook 需要公网入口；长连接是唯一符合本地优先的订阅方式，同时要求后台把订阅方式设成「使用长连接」。
3. **群聊只收 @ 消息**，文本里带 `@_user_1` 占位符；`stripMentions` 在解析命令前清掉，否则 `/cwd` 永远不是命令。

## 约定

- 单实例：锁按凭据摘要放在 `~/.hulala-bot/<hash>.lock`，跨 home 生效。两个 Telegram 轮询器抢同一个 token 会回 409 并随机丢 update；两个飞书长连接会分掉同一条事件流，都和「消息丢了」不可区分。
- 白名单按渠道各判一次：`allowedUsers` 或 `allowedChats` 任一命中即可，两个都空时该渠道拒绝启动。不在名单里的消息会打一行 `ignored … (not in allowlist)`，这也是用户发现自己的 open id 的方式。
- 提交前跑 `node --test`；`dist/` 不进版本库。
- 许可 GPL-3.0-only。私有仓不复制这里的源码。
