import { hooklessGitArgs } from './hookless'

export type RunGitResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type DrainableProcess = {
  stdout: { text: () => Promise<string> }
  stderr: { text: () => Promise<string> }
  exited: Promise<number>
}

// `proc.exited` only signals child termination; it does not consume or close
// the piped stdout/stderr streams. A stream left undrained holds its parent
// read-end fd until GC finalizes it, so awaiting exit alone lets fds accumulate
// under memory pressure (delayed GC) — the leak this helper exists to stop.
// Draining both streams to EOF makes `runGit` own the full resource lifecycle:
// it does not resolve until the process has exited AND both pipes are closed.
// Both reads are STARTED before we await, so neither can be starved by the
// other (Bun v1.3.14 buffers subprocess output internally, so this is about
// deterministic fd release, not an OS pipe-capacity deadlock).
async function collectProcessOutput(proc: DrainableProcess): Promise<RunGitResult> {
  const stdoutDrain = proc.stdout.text()
  const stderrDrain = proc.stderr.text()
  const exited = proc.exited
  const [exitCode, stdout, stderr] = await Promise.all([exited, stdoutDrain, stderrDrain])
  return { exitCode, stdout, stderr }
}

export async function runGit(
  bun: { spawn: typeof Bun.spawn },
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunGitResult> {
  const proc = bun.spawn({
    cmd: ['git', ...hooklessGitArgs(args)],
    cwd,
    // Omitting env makes Bun use the launch-time environment, missing identity
    // variables the runtime sets later (the linked GitHub account).
    env: options.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const drainable: DrainableProcess = {
    stdout: { text: () => Bun.readableStreamToText(proc.stdout) },
    stderr: { text: () => Bun.readableStreamToText(proc.stderr) },
    exited: proc.exited,
  }
  try {
    return await collectProcessOutput(drainable)
  } catch (drainErr) {
    // A pipe-read rejection must not escape while the child may still be
    // running: kill it, then let exit and both drains settle so no fd is left
    // dangling behind the error.
    proc.kill()
    await Promise.allSettled([drainable.exited, drainable.stdout.text(), drainable.stderr.text()])
    throw drainErr
  }
}

export const _internal = { collectProcessOutput }
