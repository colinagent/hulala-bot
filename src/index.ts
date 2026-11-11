/**
 * Entry point: setup for the Host plugin.
 *
 * The bridge itself is a Host plugin (`src/host/plugin.ts`), loaded by whichever
 * Host installed the bundle. This binary exists for the one thing that cannot be
 * done from inside a running Host: writing the configuration file a plugin has
 * no terminal to ask about.
 *
 *     dsh plugin --profile tui exec dsh-telegram --init
 *     hulala plugin --profile tui exec dsh-telegram --init
 *
 * @module dsh-telegram/index
 */
import { runInit } from './init.ts'

const arguments_ = process.argv.slice(2)

if (arguments_.includes('--help') || arguments_.length === 0) {
  console.log([
    'dsh-telegram — Telegram bridge for DeepSeek Harness',
    '',
    'This package runs inside a Host as a plugin. The only command here writes',
    'the configuration that plugin needs:',
    '',
    '  dsh-telegram --init --allowed-user <telegram id> [--token-ref telegram/bot-token]',
    '  dsh-telegram --init --no-input ...        # never prompt',
    '',
    'Install it with one of:',
    '  dsh plugin --profile tui add @colinagent/dsh-telegram',
    '  hulala plugin --profile tui add @colinagent/dsh-telegram',
  ].join('\n'))
  process.exit(0)
}

if (arguments_.includes('--init')) {
  // Setup is a one-shot: never fall through into something long-running.
  process.exit(await runInit(arguments_.slice(arguments_.indexOf('--init') + 1)))
}

console.error(`unknown arguments: ${arguments_.join(' ')}\ntry --help`)
process.exit(1)
