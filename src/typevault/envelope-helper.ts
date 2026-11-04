import { requireSecretsEntry, writeSecretsEntry } from './vault'

const [op, agentDir] = process.argv.slice(2)

try {
  if (agentDir === undefined) throw new Error('usage: envelope-helper.ts <read|write> <agentDir>')
  if (op === 'read') {
    process.stdout.write(await requireSecretsEntry(agentDir))
  } else if (op === 'write') {
    await writeSecretsEntry(agentDir, await Bun.stdin.text())
  } else {
    throw new Error(`unknown operation: ${op}`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
