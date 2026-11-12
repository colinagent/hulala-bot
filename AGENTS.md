# dsh-telegram

把一台机器上正在运行的 DeepSeek Harness Host 接到 Telegram：手机发一句话，Host 里的 agent 执行，回复以单条消息流式编辑回来；`/cwd` 切换这个对话挂载哪个会话，和 TUI 里切换会话是同一件事。

## 它是什么，不是什么

**一个 Host 插件，一套业务逻辑**（`src/host/plugin.ts`）：

- 跑在 Host 进程内，直接调 `sessionController` / `workspaceController`，用
  `ctx.on('approval/request')` 应答审批；
- `src/host/local-remote.ts` 把宿主服务包成 `ctx.remote` 的形状，`bridge.ts` 不认识第二种载体；
- 没有端口、token、cookie、WebSocket，也没有独立进程可启动。

不是：

- 不改、不 patch、不 fork DeepSeek Harness，`~/code/refs/deepseek-harness` 是只读参考；
- 不发明会话租约/接管/独占。多端同时挂同一个会话是 DSH 官方语义；
- 不自己拉起 Host，也不自带守护逻辑：Host 起，桥起；Host 停，桥停。

会话历史、cwd、模型、权限以 Host 为真源；这里只持久化「哪个 chat 挂了哪个会话」、去重账本和日志。

## 命令

```bash
node --test "tests/*.test.ts"      # 73 个用例，假 Host + 真 HTTP 的 FakeTelegram
bun run typecheck
bun run build                      # dist/index.mjs（--init）与 dist/plugin.mjs（Host 插件）
node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>   # 对真 Host 跑一轮
```

需要 Node ≥ 22.6（本机 24.x）。`bun:test` 与 tsc 的类型定义冲突，测试用 `node --test`。

## 目录

| 路径 | 职责 |
|---|---|
| `src/host/plugin.ts` | Host 插件入口：注入服务、起桥、随 Host 释放 |
| `src/host/local-remote.ts` | 把宿主服务包成 `bridge.ts` 认识的那几个调用 |
| `src/host/turn.ts` | 回合跟踪、工具调用的中文标签 |
| `src/telegram/api.ts` | Bot API（429 `retry_after`、可中断的长轮询） |
| `src/telegram/reply.ts` | 单条消息流式编辑、typing 续期、失败降级 |
| `src/telegram/ledger.ts` | update 去重账本（24h TTL） |
| `src/render/` | MarkdownV2 投影、fence 感知分片 |
| `src/store/bindings.ts` | chat → session 挂载表 |
| `src/bridge.ts` | 命令、挂载、流式、审批卡片、回调 |

状态目录是 `$DSH_HOME/config/dsh-telegram/`（DSH 是 `~/.dsh`，呼啦啦是 `~/.hulala/harness`）；`config.json`、`bindings.json`、`receipts/`、`logs/` 都在里面，`0600`/`0700`。**轮询锁不在状态目录**：按 bot token 摘要放在 `~/.dsh-telegram/<hash>.lock`，这样 DSH 与呼啦啦两边都装了插件时也只有一个在轮询。bot token 只存系统钥匙串，不进配置文件、不进日志；配置用 `--init` 写，拒绝空允许名单。`config.json` 的 `proxy` 是 HTTP/HTTPS CONNECT 代理（`http://127.0.0.1:7897` 这种），单列一项而不是读环境变量：Host 的环境属于用户，插件不该偷偷改 `HTTPS_PROXY`。

## 版本约束

`package.json` 的 `engines.dsh`（`>=0.2.2-rc.1 <0.3.0`）。装载器在 import 之前校验，不匹配就跳过并向 `skippedBundles` 报告；`@deepseek-ai/dsh-*` 必须是 **peerDependencies**，否则 profile 里会出现第二份，`Remote` 注册表就分裂了。

改 DSH 依赖版本时跟着上游 minor 走，并在真机上重跑 `scripts/spike-host.ts`。

## 三个不显然的坑

1. **必须 `ctx.typert.contexts.registerClient('agent', { identity: () => undefined, resolve: () => ctx })`**，否则 waterfall 会被 Gateway 静默丢弃——不报错，只是永远收不到。
2. **`const on = ctx.remote.$on` 会丢 Cordis shadow-method 的 `this`**，报错会说「requires interactions=answer」，实际是解绑了。永远写成 `ctx.remote.$on(...)`。
3. **本机默认 permission preset 直接放行危险命令**，所以 `rm -rf` 不会触发审批卡片；真机验审批要先切到 `workspace-write`。

## 兼容性现状

**只依赖 DSH 的宿主服务面**：`sessionController` 的 `list/create/prompt/follow`、
`workspaceController.create`、`approval/request` 的 waterfall 语义。不再有载体、端口、
token、cookie 或独立进程——那些随 peer 形态一起删掉了。

版本由 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.1 <0.3.0`）声明，装载器在 import
之前校验；`@deepseek-ai/dsh-*` 必须是 **peerDependencies**，否则 profile 里会出现第二份
注册表。

呼啦啦与 DSH 都用同一条 `plugin` 入口安装：

```sh
dsh plugin --profile tui add @colinagent/dsh-telegram
hulala plugin --profile tui add @colinagent/dsh-telegram
```

## 约定

- 单实例：锁按 bot token 的摘要放在 `~/.dsh-telegram/<hash>.lock`，跨 home 生效。两个轮询器抢同一个 token 会让 Telegram 回 409 并随机丢 update，和「消息丢了」不可区分。
- 提交前跑 `node --test`；`dist/` 不进版本库。
- 许可 GPL-3.0-only。私有仓不复制这里的源码。
