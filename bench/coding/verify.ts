import { spawn } from 'node:child_process'

export type VerifyResult = {
  passed: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export type VerifyRunner = (command: string[], cwd: string, timeoutMs: number) => Promise<VerifyResult>

// Verifies in the ALREADY-PREPARED workspace via `docker exec -w <cwd>`. It does
// NOT copy the task in — seeding is the workspace provider's job, done before the
// agent turn. Copying here would overwrite the agent's output with the seed.
export function makeContainerVerifier(container: string): VerifyRunner {
  return (command, cwd, timeoutMs) => runProcess('docker', ['exec', '-w', cwd, container, ...command], timeoutMs)
}

export const runVerifier: VerifyRunner = (command, cwd, timeoutMs) => {
  const [bin, ...args] = command
  if (bin === undefined) {
    return Promise.resolve({ passed: false, exitCode: 1, stdout: '', stderr: 'empty verify command' })
  }
  return runProcess(bin, args, timeoutMs, cwd)
}

function runProcess(bin: string, args: string[], timeoutMs: number, cwd?: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)

    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ passed: false, exitCode: 1, stdout, stderr: `${stderr}${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const exitCode = code ?? 1
      resolve({ passed: exitCode === 0, exitCode, stdout, stderr })
    })
  })
}
