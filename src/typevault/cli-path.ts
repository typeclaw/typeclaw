import { dirname, join } from 'node:path'

// Resolved without importing the SDK, so the bash sandbox can wrap the CLI
// without loading typevault on every agent.
export function typevaultCliPath(): string {
  return join(dirname(Bun.resolveSync('typevault', import.meta.dir)), 'cli', 'index.ts')
}

export function typevaultBashCliPath(): string {
  return join(import.meta.dir, 'bash-cli.ts')
}
