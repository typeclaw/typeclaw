#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { CLI_VERSION } from '../init/cli-version'
import { findAgentDir } from '../init/find-agent-dir'
import { runStartupMigrations } from '../migrations'
import { BUILTIN_COMMAND_NAMES } from './builtins'
import type { PluginCommandDispatchOutcome } from './plugin-commands-dispatch'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    version: CLI_VERSION,
    description: 'TypeClaw agent runtime',
  },
  subCommands: {
    init: () => import('./init').then((m) => m.init),
    run: () => import('./run').then((m) => m.run),
    tui: () => import('./tui').then((m) => m.tui),
    start: () => import('./start').then((m) => m.startCommand),
    stop: () => import('./stop').then((m) => m.stopCommand),
    restart: () => import('./restart').then((m) => m.restartCommand),
    status: () => import('./status').then((m) => m.statusCommand),
    reload: () => import('./reload').then((m) => m.reload),
    logs: () => import('./logs').then((m) => m.logsCommand),
    inspect: () => import('./inspect').then((m) => m.inspectCommand),
    dreams: () => import('./dreams').then((m) => m.dreamsCommand),
    shell: () => import('./shell').then((m) => m.shellCommand),
    compose: () => import('./compose').then((m) => m.composeCommand),
    channel: () => import('./channel').then((m) => m.channelCommand),
    cron: () => import('./cron').then((m) => m.cronCommand),
    tunnel: () => import('./tunnel').then((m) => m.tunnelCommand),
    role: () => import('./role').then((m) => m.roleCommand),
    provider: () => import('./provider').then((m) => m.providerCommand),
    model: () => import('./model').then((m) => m.modelCommand),
    mount: () => import('./mount').then((m) => m.mountCommand),
    doctor: () => import('./doctor').then((m) => m.doctorCommand),
    usage: () => import('./usage').then((m) => m.usageCommand),
    update: () => import('./update').then((m) => m.updateCommand),
    'dev-dep': () => import('./dev-dep').then((m) => m.devDepCommand),
    _hostd: () => import('./hostd').then((m) => m.hostdCommand),
  },
})

// #673's v1->v2 secrets migration was wired only into the container-stage boot
// path (src/run/index.ts), so host CLI commands that read secrets.json directly
// (model/provider list -> tryReadProvidersSync -> v2-only parser) still hard-fail
// on a never-booted v1 folder. Run it once per host invocation here — at the
// dispatch boundary, NOT in the parse path, which would recreate the read-time
// shim #638 deliberately removed.
let hostStartupMigrationsDone = false

// `run` is the container stage and owns its own migration. Bare flag
// invocations (`--help`, `-h`, `--version`, `-v`, no command) are
// informational, exit before reading secrets, and must NOT rewrite secrets.json
// or emit migration warnings — so only a real subcommand triggers the migration.
function shouldRunHostStartupMigrations(commandName: string | undefined): boolean {
  if (commandName === undefined || commandName === 'run') return false
  return !commandName.startsWith('-')
}

function runHostStartupMigrationsOnce(commandName: string | undefined): void {
  if (hostStartupMigrationsDone) return
  hostStartupMigrationsDone = true
  if (!shouldRunHostStartupMigrations(commandName)) return
  const agentDir = findAgentDir(process.cwd())
  if (agentDir === null) return
  try {
    runStartupMigrations(agentDir)
  } catch (err) {
    // runStartupMigrations isolates per-migration throws; this guards only the
    // unexpected so a migration error can never block the host command itself.
    console.warn(`[migration] host startup migration error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWithPluginDispatch(): Promise<void> {
  const argv = process.argv.slice(2)
  const first = argv[0]

  runHostStartupMigrationsOnce(first)

  if (first === '--help' || first === '-h') {
    // citty calls process.exit() after rendering help, so anything we print
    // AFTER `runMain(main)` is never reached. Print the plugin commands
    // section first; citty's own help follows and the user reads top-down.
    const { renderPluginCommandsSection } = await import('./plugin-command-help')
    const { discoverCommands } = await import('./plugin-commands')
    const discovery = await discoverCommands({ cwd: process.cwd() })
    const section = renderPluginCommandsSection(discovery.commands)
    if (section !== null) process.stdout.write(`${section}\n\n`)
    await runMain(main)
    return
  }

  if (
    first !== undefined &&
    !first.startsWith('-') &&
    !BUILTIN_COMMAND_NAMES.includes(first as (typeof BUILTIN_COMMAND_NAMES)[number])
  ) {
    // Lazy: the dispatch chain statically pulls in @/config, @/plugin, zod, and
    // @/container (~190ms). Only plugin (non-builtin) commands need it, so we
    // defer the import to keep builtin commands and bare flags fast.
    const { dispatchPluginCommand } = await import('./plugin-commands-dispatch')
    const outcome = await dispatchPluginCommand({ name: first, rawArgs: argv.slice(1), cwd: process.cwd() })
    if (outcome.kind === 'dispatched') {
      process.exit(outcome.exitCode)
    }
    if (outcome.kind === 'error') {
      process.stderr.write(`${outcome.message}\n`)
      process.exit(outcome.exitCode)
    }
    // outcome.kind === 'not-found' → fall through to citty for unknown-command error
  }
  await runMain(main)
}

export type { PluginCommandDispatchOutcome }

await runWithPluginDispatch()
