/**
 * Entry point: setup for the Host plugin.
 *
 * The bridge itself is a Host plugin (`src/host/plugin.ts`), loaded by whichever
 * Host installed the bundle. This binary exists for the one thing that cannot be
 * done from inside a running Host: writing the configuration file a plugin has
 * no terminal to ask about.
 *
 *     dsh plugin --profile tui exec hulala-bot --init
 *     hulala plugin --profile tui exec hulala-bot --init
 *
 * @module hulala-bot/index
 */
import { runInit } from './init.ts'

const arguments_ = process.argv.slice(2)

if (arguments_.includes('--help') || arguments_.length === 0) {
  console.log([
    'hulala-bot — your agent on Telegram and Lark',
    '',
    'This package runs inside a Host as a plugin. The only command here writes',
    'the configuration that plugin needs:',
    '',
    '  hulala-bot --init --no-input \\',
    '    --telegram-token-ref telegram/bot-token --telegram-allowed-user <id>',
    '  hulala-bot --init --no-input \\',
    '    --lark-app-id cli_<16 hex> --lark-app-secret-ref lark/app-secret \\',
    '    --lark-allowed-user ou_<id> [--lark-domain feishu|lark]',
    '',
    'Both channels may be configured in one file; --init rewrites only the',
    'channel whose flags it was given. Telegram options: --proxy, --parse-mode.',
    'Global options: --default-cwd <path>.',
    '',
    'Install it with one of:',
    '  dsh plugin --profile tui add @colinagent/hulala-bot',
    '  hulala plugin --profile tui add @colinagent/hulala-bot',
    '  hulala install bot            # the same thing, on a Hulala install',
  ].join('\n'))
  process.exit(0)
}

if (arguments_.includes('--init')) {
  // Setup is a one-shot: never fall through into something long-running.
  try {
    process.exit(await runInit(arguments_.slice(arguments_.indexOf('--init') + 1)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

console.error(`unknown arguments: ${arguments_.join(' ')}\ntry --help`)
process.exit(1)
