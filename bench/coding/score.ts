import { runTask, type TurnResult } from './client'
import type { Task } from './task'
import { runVerifier, type VerifyResult, type VerifyRunner } from './verify'
import type { PreparedWorkspace, WorkspaceProvider } from './workspace'

export type RunOutcome = {
  turn: TurnResult
  verify: VerifyResult
  passed: boolean
}

export type TaskScore = {
  taskId: string
  runs: number
  passAt1: number
  passHatK: boolean
  passRate: number
  outcomes: RunOutcome[]
}

export type ScoreTaskOptions = {
  task: Task
  url: string
  runs?: number
  verify?: VerifyRunner
  runTurn?: (url: string, prompt: string) => Promise<TurnResult>
  // Yields a fresh, isolated workspace per attempt, SEEDED BEFORE the agent turn.
  // The agent is prompted with the returned path and the verifier runs in that
  // same path — so run N never inherits run N-1's files and pass^k stays honest.
  workspaceProvider?: WorkspaceProvider
}

// pass@1 = first run passed. pass^k = ALL k runs passed — the reliability
// metric, since agent runs are non-deterministic and single runs are noisy.
export async function scoreTask(options: ScoreTaskOptions): Promise<TaskScore> {
  const runs = options.runs ?? 3
  const verify = options.verify ?? runVerifier
  const runTurn = options.runTurn ?? ((url, prompt) => runTask({ url, prompt }))

  const outcomes: RunOutcome[] = []
  for (let i = 0; i < runs; i += 1) {
    const fallback: PreparedWorkspace = { path: options.task.dir }
    const workspace = await (options.workspaceProvider?.prepare(i) ?? Promise.resolve(fallback))
    try {
      const prompt = workspaceInstruction(options.task.instruction, workspace.path)
      const turn = await runTurn(options.url, prompt)
      const verifyResult = await verify(options.task.verifyCommand, workspace.path, options.task.timeoutMs)
      outcomes.push({ turn, verify: verifyResult, passed: verifyResult.passed })
    } finally {
      await workspace.cleanup?.()
    }
  }

  const passes = outcomes.filter((o) => o.passed).length
  return {
    taskId: options.task.id,
    runs,
    passAt1: outcomes[0]?.passed ? 1 : 0,
    passHatK: passes === runs,
    passRate: runs === 0 ? 0 : passes / runs,
    outcomes,
  }
}

function workspaceInstruction(instruction: string, workspace: string): string {
  return `${instruction}\n\nWork in this directory: ${workspace}`
}
