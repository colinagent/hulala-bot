# dsh-telegram

把一台机器上正在运行的 DeepSeek Harness Host 接到 Telegram：手机发一句话，Host 里的 agent 执行，回复以单条消息流式编辑回来；`/cwd` 切换这个对话挂载哪个会话，和 TUI 里切换会话是同一件事。

## 它是什么，不是什么

**是一个 peer**，和 TUI、Desktop、Web 同级——通过 Host 的 HTTP/WS 载体连上去，声明 `interactions=answer`，用 `$mount(Session, Workspace)` 拿会话与工作区，用 `session.follow` 收流式回复与审批请求。

不是：

- 不是 Host 内的 Cordis 插件或 profile 行（那样就拿不到 peer 身份，waterfall 会被 Gateway 丢弃）；
- 不改、不 patch、不 fork DeepSeek Harness，`~/code/refs/deepseek-harness` 是只读参考；
- 不自己拉起 Host，只 attach（当前发现路径：`~/.hulala/server/host/endpoint.json`）；
- 不发明会话租约/接管/独占。多端同时挂同一个会话、审批同时出现在多端、先答生效其余变「已在其他端处理」，都是 DSH 官方客户端本来的语义。

会话历史、cwd、模型、权限以 Host 为真源；这里只持久化「哪个 chat 挂了哪个会话」、去重账本和日志。

## 命令

```bash
node src/index.ts --self-check     # 发现 Host、鉴权、挂载服务、发一条测试消息
node src/index.ts                  # 前台跑
node --test "tests/*.test.ts"      # 61 个用例，FakeHost + 真 HTTP 的 FakeTelegram
bun run typecheck
bun build src/index.ts --target=node --format=esm --outfile=dist/index.mjs
```

需要 Node ≥ 22.6（本机 24.x）。`bun:test` 与 tsc 的类型定义冲突，测试用 `node --test`。

## 目录

| 路径 | 职责 |
|---|---|
| `src/host/attach.ts` | 发现 endpoint.json → `/connect` 换 cookie → 等连接就绪 |
| `src/host/turn.ts` | 回合跟踪、工具调用的中文标签 |
| `src/telegram/api.ts` | Bot API（429 `retry_after`、可中断的长轮询） |
| `src/telegram/reply.ts` | 单条消息流式编辑、typing 续期、失败降级 |
| `src/telegram/ledger.ts` | update 去重账本（24h TTL） |
| `src/render/` | MarkdownV2 投影、fence 感知分片 |
| `src/store/bindings.ts` | chat → session 挂载表 |
| `src/bridge.ts` | 命令、挂载、流式、审批卡片、回调 |

状态在 `~/.hulala/config/dsh-telegram/`：`config.json`、`bindings.json`、`receipts/`、`logs/`、`bridge.lock`，全部 `0600`/`0700`。bot token 只存系统钥匙串（`service=telegram, account=bot-token`），不进配置文件、不进日志。

## 三个不显然的坑

1. **必须 `ctx.typert.contexts.registerClient('agent', { identity: () => undefined, resolve: () => ctx })`**，否则 waterfall 会被 Gateway 静默丢弃——不报错，只是永远收不到。
2. **`const on = ctx.remote.$on` 会丢 Cordis shadow-method 的 `this`**，报错会说「requires interactions=answer」，实际是解绑了。永远写成 `ctx.remote.$on(...)`。
3. **本机默认 permission preset 直接放行危险命令**，所以 `rm -rf` 不会触发审批卡片；真机验审批要先切到 `workspace-write`。

## 兼容性现状

载体和发现路径都还绑定在 Hulala Host 上：`~/.hulala/server/host/endpoint.json`，以及 Hulala 的 `hulalaHost` 插件提供的 `/connect?token=…&interactions=answer` cookie 流程。上游 `deepseek-harness` 的 `apps/desktop-host`、`apps/web` 是否暴露同类载体，需要单独核实后才能声称「DSH Web/Desktop 用户也能用」。

## 约定

- 单实例：`bridge.lock` 里放 pid。两个轮询器抢同一个 bot token 会让 Telegram 回 409 并随机丢 update，和「消息丢了」不可区分。
- 提交前跑 `node --test`；`dist/` 不进版本库。
- 许可 GPL-3.0-only。私有仓不复制这里的源码。
