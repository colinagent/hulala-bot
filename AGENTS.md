# dsh-telegram

把一台机器上正在运行的 DeepSeek Harness Host 接到 Telegram：手机发一句话，Host 里的 agent 执行，回复以单条消息流式编辑回来；`/cwd` 切换这个对话挂载哪个会话，和 TUI 里切换会话是同一件事。

## 它是什么，不是什么

**两种接法，一套业务逻辑**：

- **插件**（`src/host/plugin.ts`）：宿主内，直接调 `sessionController` / `workspaceController`，`ctx.on('approval/request')` 应答审批。DSH 原生 Web/Desktop 用户用这条。
- **peer**（`src/host/attach.ts`）：独立进程，走 `/connect` + `/api/remote.mux`。Hulala Host 用这条（GPL 代码不进专有进程，且桥要跨 Host 重启常驻）。

两者都通过 `HostBackend` 交给同一个 `bridge.ts`；`src/host/local-remote.ts` 把宿主服务包成 `ctx.remote` 的形状，所以业务代码没有分叉。

不是：

- 不是 peer-only：插件形态是官方支持的 `dsh plugin add` 路径，`engines.dsh` 在启动前校验版本；
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

**协议层兼容上游 DSH，只有「发现」绑在 Hulala 上。**

已经核实（`deepseek-harness` 2026-11-11 master，0.2.2-rc.2）：

- `/connect`、`?token=…&interactions=answer`、`Set-Cookie`、`/api/remote.mux` 全部是上游 `@deepseek-ai/dsh-client-connection` 的实现（`connect-protocol.ts` 的 `CONNECT_PATH`、`browser-auth.ts` 的 `TOKEN_QUERY`/`COOKIE_PREFIX`、`api/gateway` 的 `REMOTE_STREAM_MUX_PATH`）。
- `$mount(SessionRemote)` / `$mount(WorkspaceRemote)` 直接 import 自 `@deepseek-ai/dsh-api-*-controller/remote`，版本对齐即协议对齐。
- 桌面端不是 IPC-only：`apps/desktop-host` 用 `--host 127.0.0.1 --port 0` 起同一个 Web 应用，再把 URL 经 IPC 交给 Electron。网页端把带 token 的 URL 打到 stdout（`packages/bundle/web-app`）。

缺的只有发现：上游没有 `endpoint.json`，桌面把 URL 只交给 Electron，网页只打印。`src/host/attach.ts` 里的 `endpointPath()` 因此写死了 `~/.hulala/server/host/endpoint.json`。cookie 名不写死——用的是响应里的 `Set-Cookie`，所以 Hulala 的 `hulala_<uuid>` 和上游的 `dsh-auth-` 都能用。

## 约定

- 单实例：`bridge.lock` 里放 pid。两个轮询器抢同一个 bot token 会让 Telegram 回 409 并随机丢 update，和「消息丢了」不可区分。
- 提交前跑 `node --test`；`dist/` 不进版本库。
- 许可 GPL-3.0-only。私有仓不复制这里的源码。
