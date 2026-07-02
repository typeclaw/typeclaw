import { spawn } from 'node:child_process'

export type VerifyResult = {
  passed: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export type VerifyRunner = (command: string[], cwd: string, timeoutMs: number) => Promise<VerifyResult>

export const runVerifier: VerifyRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const [bin, ...args] = command
    if (bin === undefined) {
      resolve({ passed: false, exitCode: 1, stdout: '', stderr: 'empty verify command' })
      return
    }

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
