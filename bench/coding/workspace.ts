import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type PreparedWorkspace = {
  path: string
  cleanup?: () => Promise<void>
}

export type WorkspaceProvider = {
  prepare: (runIndex: number) => Promise<PreparedWorkspace>
}

export type DockerRun = (args: string[]) => Promise<void>

// Seeds a UNIQUE, clean path inside the agent container BEFORE each turn, so the
// agent and verifier operate on the same fresh filesystem and run N never sees
// run N-1's artifacts. `rm -rf` then `mkdir` guarantees no stale files even if a
// path is reused; `docker cp <task>/. :<path>` copies contents, not the dir.
export function makeContainerWorkspaceProvider(
  container: string,
  hostTaskDir: string,
  baseDir = '/tmp',
  docker: DockerRun = defaultDockerRun,
): WorkspaceProvider {
  return {
    async prepare(runIndex) {
      const path = `${baseDir}/bench-run-${runIndex}`
      await docker(['exec', container, 'rm', '-rf', path])
      await docker(['exec', container, 'mkdir', '-p', path])
      await docker(['cp', `${hostTaskDir}/.`, `${container}:${path}`])
      return { path, cleanup: () => docker(['exec', container, 'rm', '-rf', path]) }
    },
  }
}

export function makeHostWorkspaceProvider(taskDir: string): WorkspaceProvider {
  return {
    async prepare() {
      const path = await mkdtemp(join(tmpdir(), 'bench-run-'))
      await cp(taskDir, path, { recursive: true })
      return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
    },
  }
}

const defaultDockerRun: DockerRun = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} failed: ${stderr}`))))
  })
