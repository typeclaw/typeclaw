import { runTask } from './client'
import { resolveHostPort, resolveTuiToken } from './docker-discovery'
import { buildReport, writeReport } from './report'
import { scoreTask } from './score'
import { loadTaskSuite } from './task'
import { makeContainerWorkspaceProvider } from './workspace'

export type CodingRunArgs = {
  container: string
  host?: string
  prompt?: string
  suite?: string
  runs?: number
  resultsDir?: string
}

const USAGE =
  'usage: bun run coding/run.ts --container <name> (--prompt <text> | --suite <dir> [--runs 3] [--results ./results])\n'

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args === null || (args.suite === undefined && args.prompt === undefined)) {
    process.stderr.write(USAGE)
    return 2
  }

  const url = await resolveUrl(args.container, args.host)
  return args.suite !== undefined ? runSuite(args, url) : runSinglePrompt(args.prompt!, url)
}

async function runSinglePrompt(prompt: string, url: string): Promise<number> {
  const result = await runTask({ url, prompt })
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

async function runSuite(args: CodingRunArgs, url: string): Promise<number> {
  const runs = args.runs ?? 3
  const tasks = await loadTaskSuite(args.suite!)
  const scores = []
  for (const task of tasks) {
    const workspaceProvider = makeContainerWorkspaceProvider(args.container, task.dir)
    scores.push(await scoreTask({ task, url, runs, workspaceProvider }))
  }

  const report = buildReport({ suite: args.suite!, container: args.container, runsPerTask: runs, scores })
  const path = await writeReport(args.resultsDir ?? './results', report)

  process.stdout.write(`${JSON.stringify(report, null, 2)}\nwrote ${path}\n`)
  return report.passHatKRate === 1 ? 0 : 1
}

async function resolveUrl(container: string, host?: string): Promise<string> {
  const port = await resolveHostPort(container)
  const token = await resolveTuiToken(container)
  return `ws://${host ?? '127.0.0.1'}:${port}?token=${token}`
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
  if (container === undefined) return null

  const runsRaw = values.get('runs')
  const runs = runsRaw === undefined ? undefined : Number(runsRaw)
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) return null

  return {
    container,
    host: values.get('host'),
    prompt: values.get('prompt'),
    suite: values.get('suite'),
    runs,
    resultsDir: values.get('results'),
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
