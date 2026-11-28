import { type BashSandboxBoundary, prepareBashSandbox } from '@/agent/bash-sandbox'
import type { SessionOrigin } from '@/agent/session-origin'
import type { PermissionService } from '@/permissions/permissions'
import { shellQuote } from '@/sandbox/quote'

export type DependencyInstallResult = { ok: true } | { ok: false; reason: string }

// The host install skips every lifecycle script (src/init/run-bun-install.ts),
// so a dependency whose CLI downloads its native binary in postinstall arrives
// without it, and a host-side download would fetch the host platform's build
// anyway. Boot finishes the trusted scripts here, on the container's platform,
// inside the same root-writable sandbox model bash gets, so a script never sees
// runtime credentials. Untrusted packages stay skipped, as bun does by default.
// --frozen-lockfile keeps boot from rewriting the agent's bun.lock. The
// runtime's own bun is bound into the sandbox, so use it rather than PATH.
const INSTALL_COMMAND = `${shellQuote(process.execPath)} install --linker=hoisted --frozen-lockfile`
const INSTALL_TIMEOUT_MS = 300_000
const INSTALL_ORIGIN: SessionOrigin = { kind: 'system', component: 'dependency-install' }
const INSTALL_SESSION_ID = 'dependency-install'

export async function installAgentDependencies(options: {
  agentDir: string
  permissions: PermissionService
  boundary?: BashSandboxBoundary
  timeoutMs?: number
}): Promise<DependencyInstallResult> {
  const { agentDir } = options
  let prepared: Awaited<ReturnType<typeof prepareBashSandbox>>
  try {
    prepared = await prepareBashSandbox({
      command: INSTALL_COMMAND,
      permissions: options.permissions,
      origin: INSTALL_ORIGIN,
      agentDir,
      sessionId: INSTALL_SESSION_ID,
      ...(options.boundary !== undefined ? { boundary: options.boundary } : {}),
    })
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  }
  try {
    await prepared.verify()
    const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
    const proc = Bun.spawn(['/bin/sh', '-c', prepared.commandString], {
      cwd: agentDir,
      env: prepared.spawnEnv ?? process.env,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    try {
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      if (timedOut) return { ok: false, reason: `bun install timed out after ${timeoutMs / 1000}s` }
      if (code === 0) return { ok: true }
      return { ok: false, reason: `bun install exited with code ${code}: ${stderr.trim() || 'no stderr'}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  } finally {
    await prepared.cleanup()
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
