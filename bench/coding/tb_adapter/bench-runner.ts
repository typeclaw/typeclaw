import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession } from '@/agent/index'
import { type CreateSessionForSubagent, invokeSubagent, type SubagentRegistry } from '@/agent/subagents'
import { createHookBus } from '@/plugin/hooks'
import { emptyRegistry } from '@/plugin/registry'

// Runs typeclaw's REAL agent tool loop headless against a task dir, then exits —
// so the agent can run its code, see failures, and fix them (unlike the planner).
//
// Load-bearing directory split: process.cwd() MUST stay at the typeclaw agent dir
// (config loads eagerly at import; codex auth via secrets.json loads lazily — both
// break if cwd moves). Tools are pointed at the TASK dir via plugins.agentDir.
// emptyRegistry + createHookBus is the minimal plugin wiring createSession needs.

const SYSTEM_PROMPT = [
  'You are a coding agent solving a benchmark task.',
  'Your shell and file tools already operate in the task directory.',
  'Create and edit files at the EXACT paths the task specifies (usually absolute paths like /app/...).',
  'Do NOT create a workspace/ subdirectory and do NOT nest outputs.',
  'Run your solution, observe failures (missing dependencies, errors, wrong output),',
  'install or fix as needed, and iterate until the task passes. Then stop.',
].join(' ')

async function main(): Promise<number> {
  const taskDir = process.argv[2]
  const prompt = process.argv[3]
  if (!taskDir || !prompt) {
    process.stderr.write('usage: bun run bench-runner.ts <taskDir> <prompt>\n')
    return 2
  }

  const registry: SubagentRegistry = {
    task: { systemPrompt: SYSTEM_PROMPT, visibility: 'internal' },
  }

  const createSessionForSubagent: CreateSessionForSubagent = async (subagent, options) => {
    const sessionManager = SessionManager.inMemory()
    const hooks = createHookBus()
    const origin = { kind: 'subagent' as const, subagent: options?.name ?? 'task', parentSessionId: 'bench' }
    const session = await createSession({
      sessionManager,
      systemPromptOverride: subagent.systemPrompt,
      origin,
      customTools: [],
      plugins: { registry: emptyRegistry(), hooks, sessionId: sessionManager.getSessionId(), agentDir: taskDir },
    })
    return { session, hooks, sessionId: sessionManager.getSessionId(), agentDir: taskDir, origin }
  }

  let providerError: string | undefined
  await invokeSubagent('task', {
    registry,
    createSessionForSubagent,
    agentDir: taskDir,
    userPrompt: prompt,
    onProviderError: (msg) => {
      providerError = msg
    },
  })

  if (providerError !== undefined) {
    process.stderr.write(`provider error: ${providerError}\n`)
    return 1
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
