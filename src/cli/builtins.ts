// Single source of truth for the top-level `typeclaw` subcommands that the
// CLI dispatches via citty. Plugin commands MUST NOT shadow these names.
// `src/cli/index.ts` consumes this for argv interception; `src/plugin/registry.ts`
// consumes it to reject plugin commands that collide.
export const BUILTIN_COMMAND_NAMES = [
  'init',
  'run',
  'tui',
  'start',
  'stop',
  'restart',
  'status',
  'reload',
  'logs',
  'inspect',
  'dreams',
  'shell',
  'compose',
  'channel',
  'cron',
  'tunnel',
  'role',
  'provider',
  'model',
  'mount',
  'doctor',
  'usage',
  'update',
  'dev-dep',
  '_hostd',
] as const

export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number]
