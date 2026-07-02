import { runTask } from './client'
import { resolveHostPort, resolveTuiToken } from './docker-discovery'

export type CodingRunArgs = {
  container: string
  prompt: string
  host?: string
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args === null) {
    process.stderr.write('usage: bun run coding/run.ts --container <name> --prompt <text> [--host 127.0.0.1]\n')
    return 2
  }

  const host = args.host ?? '127.0.0.1'
  const port = await resolveHostPort(args.container)
  const token = await resolveTuiToken(args.container)
  const url = `ws://${host}:${port}?token=${token}`

  const result = await runTask({ url, prompt: args.prompt })

  process.stdout.write(
    JSON.stringify(
      {
        error: result.error,
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({ name: call.name, isError: call.isError ?? false })),
        usage: result.usage,
      },
      null,
      2,
    ) + '\n',
  )
  return result.error === null ? 0 : 1
}

function parseArgs(argv: string[]): CodingRunArgs | null {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) return null
    values.set(key.slice(2), value)
  }
  const container = values.get('container')
  const prompt = values.get('prompt')
  if (container === undefined || prompt === undefined) return null
  return { container, prompt, host: values.get('host') }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
