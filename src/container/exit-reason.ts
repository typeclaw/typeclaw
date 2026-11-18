import { relative } from 'node:path'

import { sealExitForAgent, type LastWordsDeath } from '@/last-words/file'

import type { DockerExec } from './shared'

export type ContainerExit = NonNullable<Awaited<ReturnType<typeof inspectContainerExit>>>

// OOMKilled is container-wide: a killed subprocess can set it even when the runtime survives.
// `finishedAt` identifies one stop of a container: Docker keeps the container ID across
// restarts, so ID alone cannot tell a repeated observation of the same exit from a new one.
export async function inspectContainerExit(
  exec: DockerExec,
  name: string,
): Promise<
  | { kind: 'running'; containerId: string }
  | {
      kind: 'stopped'
      containerId: string
      finishedAt: string
      exitCode: number
      oomKilled: boolean
      reason: string | null
    }
  | null
> {
  try {
    const result = await exec([
      'inspect',
      '--format',
      '{{.Id}}|{{.State.Running}}|{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.HostConfig.Memory}}|{{.State.FinishedAt}}',
      name,
    ])
    if (result.exitCode !== 0) return null
    const match = /^([0-9a-f]{64})\|(true|false)\|(true|false)\|(\d+)\|(\d+)\|(\S+)$/.exec(result.stdout.trim())
    if (!match) return null
    const containerId = match[1]!
    if (match[2] === 'true') return { kind: 'running', containerId }
    const limitBytes = Number(match[5])
    const limit =
      Number.isSafeInteger(limitBytes) && limitBytes > 0
        ? ` (likely container memory limit ${Math.ceil(limitBytes / (1024 * 1024))} MiB)`
        : ''
    const exitCode = Number(match[4])
    const reason =
      match[3] === 'true'
        ? exitCode === 137
          ? `agent runtime was SIGKILLed (137) and the container recorded an OOM kill during this run${limit}. Restart the agent and reduce memory-heavy parallel work.`
          : `agent runtime exited with code ${exitCode}; an OOM kill occurred in the container earlier in this run${limit}; a subprocess may have been killed. Restart the agent and reduce memory-heavy parallel work.`
        : exitCode === 137
          ? 'agent runtime exited with SIGKILL (137); Docker did not report an OOM kill.'
          : null
    return { kind: 'stopped', containerId, finishedAt: match[6]!, exitCode, oomKilled: match[3] === 'true', reason }
  } catch {
    return null
  }
}

export function sealObservedExit(
  agentDir: string,
  exit: Extract<ContainerExit, { kind: 'stopped' }>,
  archivedLog: string | null,
  observedBy: LastWordsDeath['observedBy'],
  options: { operatorStop?: boolean } = {},
): void {
  sealExitForAgent(
    agentDir,
    {
      finishedAt: exit.finishedAt,
      exitCode: exit.exitCode,
      oomKilled: exit.oomKilled,
      reason: exit.reason,
      log: archivedLog === null ? null : relative(agentDir, archivedLog),
    },
    observedBy,
    options,
  )
}
