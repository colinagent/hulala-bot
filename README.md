# hulala-bot

Put the DeepSeek Harness agent running on this machine on **Telegram** and **Feishu / Lark**. Send one sentence from your phone, the local Host runs it, and the answer streams back into the same conversation; `/cwd` changes which session that conversation is mounted to — the same thing switching sessions in the TUI does.

Native DSH and Hulala attach the same way: **install it as a Host plugin**, put it in a profile, and it lives and dies with the Host. This file is also the npm page; the Chinese version lives in [docs/README.zh-CN.md](https://github.com/colinagent/hulala-bot/blob/main/docs/README.zh-CN.md).

---

## Let an AI set it up

This file is written to be an AI's instruction sheet: commands, configuration fields, expected output and exact error strings are all here. Send this to your assistant (Claude Code, Cursor, ChatGPT — anything that can run commands):

```text
Set up hulala-bot for me (a plugin that connects Telegram / Feishu to the local
DeepSeek Harness). First read https://github.com/colinagent/hulala-bot in full,
then work through it in order:

1. Check the environment: node -v (>=22.6), pnpm -v, hulala --version
2. Install the plugin as described in "Install" (hulala install bot on Hulala;
   hulala plugin if that command does not exist yet)
3. Write config.json as described in "Configure". Credentials go into the OS
   keychain only — never ask me to paste a token into the chat, never write one
   into config.json
4. Restart the Host
5. Walk the verification checklist and paste the real output of every step
6. If a step fails, match the exact text against "Troubleshooting". Do not guess.

Rules: invent no commands, config fields, scopes or events beyond this README;
stop and ask me when something is missing.
```

The three rules the README backs up:

1. **Credentials live in the keychain.** The config file only holds `tokenRef` / `appSecretRef` (`<service>/<account>`).
2. **The allowlist cannot be empty.** The bot refuses to start without one; it is not a step that can be skipped.
3. **Restart the Host after any config change.** The plugin reads its config at startup; there is no hot reload.

---

## What it is

**One Host plugin** that patches no line of DSH. It runs inside the Host process and calls host services directly:

```
ctx.sessionController.list / create / prompt / follow   → sessions and streaming
ctx.workspaceController.create                          → working directory
ctx.on('approval/request', (req, next) => …)            → approvals
```

No port, no token exchange, no cookie, no local WebSocket (the Feishu long connection is Feishu's own event channel, not a server on this machine). Sessions, history, cwd, models and permissions stay the Host's; this plugin stores only which conversation is mounted to which session.

**One code path, two channels**: `src/channel.ts` is the channel contract, `src/telegram/` and `src/lark/` implement it, and the session logic in `src/bridge.ts` is shared. Both channels can run at once, each with its own allowlist and mount table; a Telegram conversation and a Feishu conversation are separate sessions, with no identity merging.

---

## Install

Check the environment first:

```sh
node -v     # >= 22.6
pnpm -v     # the install goes through pnpm; install it if missing
hulala --version
```

### Hulala

```sh
hulala install bot
# On an older Hulala without that command, the equivalent is:
hulala plugin --profile tui add @colinagent/hulala-bot
```

`hulala install bot` only fills in the profile name (`tui`) and the package name; the install still runs through DSH's `runPluginCommand`.

### DSH (Web / Desktop / TUI)

```sh
dsh plugin --profile tui add @colinagent/hulala-bot
```

**Expected output**: a final `profile tui: @deepseek-ai/dsh-base, @colinagent/hulala-bot` and `Restart the Host for the change to take effect.`

Confirm:

```sh
hulala plugin --profile tui list    # @colinagent/hulala-bot is in the dependencies
```

Uninstall: `hulala plugin --profile tui remove @colinagent/hulala-bot`, then restart the Host.

Updating takes two commands, because `add` alone keeps the range already in the profile and will not move an existing install:

```sh
hulala plugin --profile tui remove @colinagent/hulala-bot
hulala install bot          # or: hulala plugin --profile tui add @colinagent/hulala-bot
hulala host stop && hulala host start
```

---

## Configure

The configuration lives in `$DSH_HOME/config/hulala-bot/config.json`:

| Host | Actual path |
|---|---|
| Hulala | `~/.hulala/harness/config/hulala-bot/config.json` |
| DSH | `~/.dsh/config/hulala-bot/config.json` |

Write it with `--init` rather than by hand — it validates, merges, and sets `0600`:

```sh
# Hulala
hulala plugin --profile tui exec hulala-bot --init

# DSH
dsh plugin --profile tui exec hulala-bot --init
```

With a terminal it asks one question at a time; without one (or with `--no-input`) it takes flags. **Configure one channel or both** — a missing section simply does not start.

### Telegram

Prepare: `/newbot` to [@BotFather](https://t.me/BotFather) for a token; your own user id from [@userinfobot](https://t.me/userinfobot).

Put the token in the OS keychain (**never** in `config.json`):

```bash
# macOS
security add-generic-password -U -s telegram -a bot-token -w '123456:ABC…'
# Linux
secret-tool store --label 'telegram bot' service telegram account bot-token
```

Write the config:

```sh
hulala plugin --profile tui exec hulala-bot --init --no-input \
  --telegram-token-ref telegram/bot-token \
  --telegram-allowed-user 123456789 \
  --default-cwd ~/hulala-workspace/workspace
```

On a network that cannot reach `api.telegram.org`, add `--proxy http://127.0.0.1:7897` (HTTP/HTTPS only; SOCKS5 is rejected before startup).

Environment variables can stand in for the keychain: `TELEGRAM_BOT_TOKEN=…`, or point `tokenEnv` at your own variable.

### Feishu / Lark

You create the app in the developer console; this plugin only needs the app id and an allowlist.

1. Create a **self-built enterprise app** at [Feishu Open Platform](https://open.feishu.cn) (international: [Lark](https://open.larksuite.com)) and copy the App ID (`cli_` + 16 hex) and App Secret.
2. Enable the **bot capability**.
3. Scopes. The event `im.message.receive_v1` is authorized **per chat type**, so a group scope does not deliver private messages:

   | What it is for | Console name | Scope |
   |---|---|---|
   | Private chat, user → bot | 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` |
   | Group, @-mentioning the bot | 获取群组中其他机器人和用户@当前机器人的消息 | `im:message.group_at_msg.include_bot:readonly` |
   | Group, every message (optional, sensitive) | 获取群组中所有消息 | `im:message.group_msg` |
   | Replying | 以应用的身份发消息 | `im:message:send_as_bot` |
   | Reading history / listing chats (optional) | 获取与发送单聊、群组消息 | `im:message`, `im:chat:readonly` |

   The first three are what makes Feishu **push** `im.message.receive_v1`; they are alternatives per chat type, so having only the group scope leaves private messages undelivered. `im:message` is a REST **data** scope and does not deliver events. Search the console by the Chinese name or switch the filter to permission id.

   **Adding a scope requires a new app version and a publish.** It takes effect on the next message; the Host does not need a restart.

4. **Events and Callbacks → subscription mode: receive events through a long connection.** Subscribe to `im.message.receive_v1` and add the `card.action.trigger` callback. **Do not** configure a webhook URL.
5. **In a group, the bot only receives real mentions.** Type `@`, wait for the member list, and pick the bot; a hand-typed `@Hulala` is plain text and Feishu delivers nothing. Private chats need no mention.
6. Publish a version, set its availability to yourself (or your team), then message the bot or add it to a group.

Checklist before the first message:

- [ ] Bot capability on
- [ ] `im:message.p2p_msg:readonly` for private chat
- [ ] `im:message.group_at_msg.include_bot:readonly` for group @ (optionally `im:message.group_msg`)
- [ ] `im:message:send_as_bot` for replies
- [ ] Subscription mode: long connection; event `im.message.receive_v1`; callback `card.action.trigger`
- [ ] New version published, availability includes you
- [ ] In a group: the `@` was picked from the member list, not typed

Put the app secret in the keychain:

```bash
security add-generic-password -U -s lark -a app-secret -w '…'
```

Write the config:

```sh
hulala plugin --profile tui exec hulala-bot --init --no-input \
  --lark-app-id cli_0123456789abcdef \
  --lark-app-secret-ref lark/app-secret \
  --lark-allowed-user ou_0123456789abcdef0123456789abcdef
```

International Lark: add `--lark-domain lark` (the Open API moves to `open.larksuite.com`).

**Finding your open id**: message the bot once and read the log:

```
ignored chat=oc_… from=ou_… (not in allowlist)
```

Put that `ou_…` into the allowlist (`--init --lark-allowed-user ou_…`) and restart the Host.

### `--init` flags

| Flag | Meaning |
|---|---|
| `--telegram-token-ref <service/account>` | Keychain reference; the documented name is `telegram/bot-token` |
| `--telegram-token-env <NAME>` | Read the token from an environment variable instead |
| `--telegram-allowed-user <id[,id]>` | Allowed Telegram user ids (repeatable) |
| `--telegram-allowed-chat <id[,id]>` | Allowed chat ids |
| `--proxy <http://…>` | HTTP/HTTPS proxy for Telegram |
| `--parse-mode markdown\|plain` | Telegram formatting; `markdown` falls back to plain text on rejection |
| `--lark-app-id <cli_…>` | Feishu app id |
| `--lark-app-secret-ref <service/account>` | Keychain reference for the app secret |
| `--lark-app-secret-env <NAME>` | Read the app secret from an environment variable |
| `--lark-allowed-user <ou_…[,ou_…]>` | Allowed open ids |
| `--lark-allowed-chat <oc_…[,oc_…]>` | Allowed chat ids |
| `--lark-domain feishu\|lark` | Feishu (default) or international Lark |
| `--default-cwd <path>` | Where the first message creates its session |
| `--no-input` | Never prompt; missing values are errors |

`--init` **merges per channel**: it rewrites only the channel whose flags it got, and keeps the other channel, existing allowlists and unknown fields. Adding a proxy or one more user never wipes the rest of the file.

### File shape

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

Top level:

| Field | Meaning |
|---|---|
| `defaultCwd` | Where the first message creates its session |
| `streamIntervalMs` | Minimum gap between two streaming edits, default 800ms (Feishu cards are rate limited — do not go low) |

`telegram`:

| Field | Meaning |
|---|---|
| `tokenRef` / `tokenEnv` | Keychain reference or environment variable name |
| `allowedUsers` | Telegram user ids; startup is refused when this and `allowedChats` are both empty |
| `allowedChats` | Chat ids (groups/channels) |
| `parseMode` | `markdown` (default, falls back on rejection) or `plain` |
| `proxy` | HTTP/HTTPS CONNECT proxy; `HTTPS_PROXY` is not read, this is the only switch |
| `baseUrl` | Tests only |
| `pollTimeoutSeconds` | Long-poll hold, default 25 |

`lark`:

| Field | Meaning |
|---|---|
| `appId` | `cli_` + 16 hex; a bad shape fails before any network call |
| `appSecretRef` / `appSecretEnv` | Keychain reference or environment variable name |
| `domain` | `feishu` (default) or `lark` |
| `allowedUsers` | Open ids (`ou_…`); startup is refused when this and `allowedChats` are both empty |
| `allowedChats` | Chat ids (`oc_…`) |
| `baseUrl` | Tests only |

Environment variables: `HULALA_BOT_CONFIG` (config path), `HULALA_BOT_STATE` (state directory), `HULALA_BOT_LOCK_DIR` (lock directory), `TELEGRAM_BOT_TOKEN`, `LARK_APP_SECRET`.

---

## Restart and verify

The plugin reads both the profile and the config at Host startup, so **restart after any change**:

```sh
hulala host stop
hulala host start
# DSH: restart your own dsh process
```

### Checklist

```sh
# 1. The plugin is in the profile
hulala plugin --profile tui list
# Expect: @deepseek-ai/dsh-base, @colinagent/hulala-bot

# 2. The Host is up
hulala host status
# Expect: "state": "running"

# 3. The plugin actually loaded
grep "bot starting inside the Host" ~/.hulala/logs/host.log | tail -1
# Expect: bot starting inside the Host; channels telegram
#         (with Feishu configured: channels telegram, lark)

# 4. Exactly one lock holder per credential
ls ~/.hulala-bot/*.lock
# Expect: one .lock per channel; contents are the local Host pid

# 5. Message the bot
# Expect: a placeholder appears, then gets replaced by the streaming answer;
#         the same session is visible in the TUI
```

Feishu extras:

```sh
# Watch inbound events (the first run logs "ignored … not in allowlist")
tail -f ~/.hulala/harness/config/hulala-bot/logs/bridge-$(date +%F).log
```

Logs live in `~/.hulala/harness/config/hulala-bot/logs/` (DSH: `~/.dsh/config/hulala-bot/logs/`).

---

## Troubleshooting

These two places explain most failures:

```sh
tail -50 ~/.hulala/harness/config/hulala-bot/logs/bridge-$(date +%F).log
grep -i "hulala-bot" ~/.hulala/logs/host.log | tail -20
```

| Symptom / exact text | Cause | Fix |
|---|---|---|
| `no channel configured: add a "telegram" or "lark" section` | No config file, or neither section | Run `--init`, or check what `HULALA_BOT_CONFIG` points at |
| `refusing to start Telegram with an empty allowlist` | Empty allowlist (refusal is by design) | Add `--telegram-allowed-user` |
| `no Telegram bot token: set tokenRef …` | No keychain entry, or the reference name differs | Check with `security find-generic-password -s telegram -a bot-token -w`; names must match `tokenRef` |
| `lark.appId must look like cli_<16 hex>` | Wrong app id pasted, or not a self-built app | Copy `cli_` + 16 hex from the developer console |
| `no Lark app secret: set lark.appSecretRef …` | Secret not in the keychain | Store `lark/app-secret`, or set `LARK_APP_SECRET` |
| `this bot is already connected from another Host (pid …)` | Another Host (DSH or a stale process) uses the same token/app id | Stop it; once it is gone, remove the `.lock` path named in the error |
| Telegram `getUpdates: Conflict: … (409)` | Two processes polling one bot token | Same as above; also look for an old standalone bridge process |
| `proxy CONNECT failed: 403` | The proxy refused CONNECT | Check the proxy allows the target or needs auth (`http://user:pass@host:port`) |
| `connect ECONNREFUSED 127.0.0.1:7897` | Nothing listening on the proxy port | Start Clash/Surge, or change `proxy` |
| Feishu bot never answers | ① subscription mode is not "long connection" ② `im.message.receive_v1` not subscribed ③ bot capability off ④ availability excludes you ⑤ wrong app secret | Check all five; a wrong secret shows up as `99991663` / `tenant_access_token` errors in the log |
| Feishu group message ignored | The `@` was typed, not picked — plain text is not a mention, and Feishu does not deliver it | Type `@`, pick the bot from the member list, then send |
| Feishu private chat ignored while groups work | Only the group scope is granted. Private chat needs `im:message.p2p_msg:readonly`, and adding it requires a new published version | Add the scope, publish a version, send again |
| Feishu message arrives but the bot never replies | Check the log for `placeholder send failed` / `reply chunk failed` | Usually a missing `im:message:send_as_bot` or the bot was removed from the chat |
| Feishu approval buttons do nothing | The `card.action.trigger` callback is missing | Add it in the console and restart the Host |
| Streaming is slow / rate limited | `streamIntervalMs` is below the platform limit | Keep it at 800 or higher (Feishu card updates are rate limited) |
| A reply says `☑️ 已处理` | That approval was already handled on another surface | Expected, not an error |
| Log says `ignored … (not in allowlist)` | The sender is not allowlisted | Add that id to the allowlist and restart |
| Nothing changed after a restart | The plugin only reads config at startup | Confirm the process really restarted (the pid in `hulala host status` changed) |

Log lines from channels are prefixed with `telegram` or `lark`. Credentials are replaced with `<secret>` before anything is written.

---

## Commands

The same commands on both channels:

| Command | Behaviour |
|---|---|
| `/cwd` | List recently used directories; tap one to mount it |
| `/cwd <path>` | Move to that directory with a new session (resume with `/sessions` + `/switch`) |
| `/new` | Create a session in the current directory |
| `/sessions` | Last 10 sessions, `*` marks the current one |
| `/switch <n>` | Switch to the n-th |
| `/status` | Session, directory, running state |
| `/stop` | Cancel the running turn |
| `/help` | All of the above |

Plain text is a prompt. The first message creates a session under `defaultCwd` and mounts it — **one session per conversation**, so a private chat never echoes into a group. Sharing is explicit: `/cwd <path>` mounts the newest session under that directory, and `/switch` picks one from the list.

Approvals arrive as buttons (Telegram inline keyboard / Feishu card actions): "allow once" or "reject". The request carries the tool name and reason, not the command line; showing the exact command would require a `callId` lookup in the session log.

---

## How the channels differ

| | Telegram | Feishu / Lark |
|---|---|---|
| Transport | Bot API long polling | Long connection (WebSocket) |
| Streaming | Edits one message | Patches one card (Feishu cannot edit text messages) |
| Buttons | Inline keyboard | Card `action` + `card.action.trigger` |
| Pinned status | Yes (`📍 <directory>`) | No; use `/status` |
| Typing indicator | Yes | Feishu has no such API |
| Message limit | 4096 (split at 4000) | 4000 chars per card, then another card |
| Groups | Any message | Must @-mention the bot |

Both channels can run together: each mounts its own sessions, approvals appear on both, the first answer wins, and the other surface shows that it was handled elsewhere.

---

## State and safety

- **State directory**: `$DSH_HOME/config/hulala-bot/` — `config.json`, `bindings.json` (mount table), `receipts/` (de-duplication, 24h TTL), `logs/`; permissions `0600`/`0700`.
- **Connection lock**: `~/.hulala-bot/<digest>.lock`, outside every state directory, so DSH and Hulala with the same plugin still connect only once.
- **Credentials**: keychain (or environment) only; redacted as `<secret>` before logging.
- **Boundary**: the allowlist is the only password; message text, tool output and paths pass through Telegram's or Feishu's servers. The plugin grants the Host no new authority — anything it can do, the TUI can do; permissions still come from the Host's preset.
- **Cross-surface cancellation**: in plugin mode an approval already handled elsewhere is not withdrawn from this surface; it shows "handled elsewhere" on the next interaction.

---

## Development

```bash
node --test "tests/*.test.ts"                                  # 108 tests
bun run typecheck
bun run build                                                  # dist/index.mjs + dist/plugin.mjs
node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>      # one round against a real Host
```

Node ≥ 22.6. Feishu REST is tested against an injected `fetch`, the long connection against a fake transport — no tenant, no network.

Version gate: `engines.dsh` declares the DSH range (`>=0.2.2-rc.1 <0.3.0`); the loader checks before import, skips incompatible bundles and reports them in `skippedBundles`; `@deepseek-ai/dsh-*` must stay peer dependencies so no second registry appears.

Deeper architecture and traps: `AGENTS.md` in the repository.

## License

GPL-3.0-only. It links GPL DeepSeek Harness / Hulala, not proprietary code.
