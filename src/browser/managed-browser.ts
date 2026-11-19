import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { createAndOpenAnchoredDirectory } from '@/agent/tool-file-safety'
import { getProcBindSafetyVerdict, resolveProcSelfExe } from '@/sandbox/availability'
import { buildSandboxedCommand } from '@/sandbox/build'
import { BROWSER_PROFILE_RELATIVE_DIR } from '@/sandbox/canonical-secrets'
import { rejectHardlinkAliases } from '@/sandbox/hidden-paths'
import type { SandboxMount, SandboxProcStrategy } from '@/sandbox/policy'
import { shellQuote } from '@/sandbox/quote'

import { createBrowserSessions } from './agent-tabs'
import { startSocksEgress } from './egress'
import { BSK_BIN, CHROME_LAUNCHER, type BrowserConfig, extensionDir } from './registry'
import { cdpWebSocketUrl, startCdpRelay, startTokenStreamRelay } from './relay'
import { devtoolsSocket, egressSocket, type SandboxEntryConfig } from './sandbox-entry'

// Runtime-private (container /tmp is not the model's /tmp: sandboxed bash binds
// a per-session directory over it), so the sockets stay out of bash. The profile
// lives in the agent folder so logins survive restarts; it is masked from every
// model tool as a runtime-owned secret dir.
const RUN_DIR = '/tmp/typeclaw-browser'
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const
const HEALTHY_RESET_MS = 5 * 60_000
const TAB_REAP_INTERVAL_MS = 60_000

export type ManagedBrowserLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export type ManagedBrowser = {
  cdpUrl: string
  filesDir: string
  // Loopback address of the token-gated BrowserSkill daemon relay.
  bskRelay: string | undefined
  token: string
  // Same access as `cdpUrl`, but the tabs opened through it close when
  // `endSession` is called for that session.
  sessionCdpUrl: (sessionId: string) => string
  endSession: (sessionId: string) => Promise<void>
  stop: () => Promise<void>
}

// Workspace-relative so roles that can see workspace/ (the same tier that holds
// `browser.shared` by default) can exchange uploads and downloads with Chrome.
export function browserFilesRoot(agentDir: string): string {
  return join(agentDir, 'workspace', '.typeclaw-browser')
}

export async function startManagedBrowser(options: {
  agentDir: string
  browser: BrowserConfig
  logger: ManagedBrowserLogger
}): Promise<ManagedBrowser> {
  const { agentDir, browser, logger } = options
  const filesDir = join(browserFilesRoot(agentDir), 'files')
  // Runtime-private: the daemon socket has no auth of its own, so bash reaches
  // it only through the token relay below, never by pointing BSK_HOME here.
  const bskHome = browser.extensions.includes('browserskill') ? join(RUN_DIR, 'bsk') : undefined
  await rm(RUN_DIR, { recursive: true, force: true })
  await mkdir(join(RUN_DIR, 'home'), { recursive: true })
  if (bskHome !== undefined) await mkdir(bskHome, { recursive: true, mode: 0o700 })
  // Workspace is model-writable, so a component could be a planted symlink to
  // the agent root. Open each component no-follow and bind the held descriptor,
  // so Chrome gets exactly the directory validated here for the whole boot.
  const exchange = await createAndOpenAnchoredDirectory(filesDir)
  const profileDir = join(agentDir, BROWSER_PROFILE_RELATIVE_DIR)
  const profile = await createAndOpenAnchoredDirectory(profileDir)
  // Bash skips the bounded per-call alias scan for the profile (see
  // isCanonicalSecretDir), so refuse a pre-existing alias here, before Chrome writes.
  await rejectHardlinkAliases(profileDir).catch(async (error: unknown) => {
    await profile.close()
    throw error
  })

  const egress = await startSocksEgress(egressSocket(RUN_DIR))
  const entry: SandboxEntryConfig = {
    chrome: CHROME_LAUNCHER,
    runDir: RUN_DIR,
    profileDir,
    downloadsDir: filesDir,
    extensionDirs: browser.extensions.map((id) => extensionDir(id)),
    headless: process.env['DISPLAY'] === undefined,
    ...(bskHome === undefined ? {} : { bsk: { home: bskHome } }),
  }
  const launch = await buildLaunch(entry, filesDir, profileDir)
  const token = randomBytes(32).toString('hex')
  const sessions = createBrowserSessions(devtoolsSocket(RUN_DIR))
  const relay = await startCdpRelay({ token, upstreamSocket: devtoolsSocket(RUN_DIR), sessions: sessions.relay })
  const observer = sessions.observe(cdpWebSocketUrl(relay.port, token))
  const reaper = setInterval(() => {
    sessions.reap().then(
      ({ closed, failed }) => {
        if (closed > 0) logger.info(`closed ${closed} idle browser tab(s) no script was using`)
        if (failed > 0) logger.warn(`could not close ${failed} browser tab(s); retrying on the next sweep`)
      },
      (error: unknown) => logger.warn(`browser tab cleanup failed: ${String(error)}`),
    )
  }, TAB_REAP_INTERVAL_MS)
  reaper.unref()
  const bskRelay =
    bskHome === undefined
      ? undefined
      : await startTokenStreamRelay({
          token,
          upstreamSocket: join(bskHome, 'run', 'daemon.sock'),
          describe: () => Bun.file(join(bskHome, 'daemon.json')).text(),
        })

  let stopped = false
  let child: ReturnType<typeof Bun.spawn> | undefined
  const supervise = async (): Promise<void> => {
    let attempt = 0
    while (!stopped) {
      const startedAt = Date.now()
      child = Bun.spawn(launch.argv, { env: launch.env, stdio: ['ignore', 'ignore', 'pipe', exchange.fd, profile.fd] })
      void waitUntilReady(devtoolsSocket(RUN_DIR)).then(
        () => {
          logger.info(`managed browser ready (engines: ${browser.engines.join(', ') || 'none'})`)
          if (bskHome !== undefined) void reportBrowserSkill(bskHome, logger)
        },
        (error: unknown) => logger.warn(`managed browser not ready: ${String(error)}`),
      )
      const code = await child.exited
      if (stopped) return
      const stderr = await new Response(child.stderr as ReadableStream).text().catch(() => '')
      if (Date.now() - startedAt > HEALTHY_RESET_MS) attempt = 0
      const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)]!
      attempt += 1
      logger.warn(
        `managed browser exited with code ${code}; restarting in ${delay / 1000}s` +
          (stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-3).join(' | ')}`),
      )
      await Bun.sleep(delay)
    }
  }
  void supervise()

  return {
    cdpUrl: cdpWebSocketUrl(relay.port, token),
    filesDir,
    bskRelay: bskRelay === undefined ? undefined : `127.0.0.1:${bskRelay.port}`,
    token,
    sessionCdpUrl: (sessionId) => cdpWebSocketUrl(relay.port, sessions.tokenFor(sessionId)),
    endSession: async (sessionId) => {
      relay.disconnect(sessionId)
      const closed = await sessions.end(sessionId)
      if (closed > 0) logger.info(`closed ${closed} browser tab(s) left open by session ${sessionId}`)
    },
    stop: async () => {
      stopped = true
      observer.stop()
      clearInterval(reaper)
      child?.kill()
      await Promise.allSettled([relay.close(), egress.close(), bskRelay?.close(), exchange.close(), profile.close()])
    },
  }
}

async function buildLaunch(
  entry: SandboxEntryConfig,
  filesDir: string,
  profileDir: string,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  const entryFile = await realpath(join(import.meta.dir, 'sandbox-entry.ts'))
  const mounts: SandboxMount[] = [
    { type: 'bind', source: RUN_DIR, dest: RUN_DIR },
    // fd 3 is the anchored exchange directory passed in the spawn's stdio.
    { type: 'bind-fd', fd: 3, dest: filesDir },
    { type: 'bind-fd', fd: 4, dest: profileDir },
    { type: 'ro-bind', source: dirname(entryFile), dest: dirname(entryFile) },
  ]
  if (existsSync('/tmp/.X11-unix')) mounts.push({ type: 'ro-bind', source: '/tmp/.X11-unix', dest: '/tmp/.X11-unix' })
  const proc: SandboxProcStrategy = (await getProcBindSafetyVerdict()) === 'safe' ? 'proc-bind' : 'tmpfs'
  const display = process.env['DISPLAY']
  const { argv, spawnEnv } = buildSandboxedCommand(
    `exec bun ${shellQuote(entryFile)} ${shellQuote(JSON.stringify(entry))}`,
    {
      network: 'none',
      proc,
      procSelfExe: resolveProcSelfExe(),
      mounts,
      cwd: RUN_DIR,
      env: { set: { HOME: join(RUN_DIR, 'home'), ...(display === undefined ? {} : { DISPLAY: display }) } },
    },
  )
  return { argv, env: spawnEnv }
}

async function waitUntilReady(socket: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1/json/version', { unix: socket } as RequestInit)
      if (response.ok) return
      lastError = new Error(`DevTools answered ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(READY_POLL_MS)
  }
  throw new Error(`DevTools did not answer within ${READY_TIMEOUT_MS / 1000}s (${String(lastError)})`)
}

// Operator-log only: a disconnected extension degrades one tool, so it never
// becomes a channel message.
async function reportBrowserSkill(bskHome: string, logger: ManagedBrowserLogger): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = Bun.spawn([BSK_BIN, 'status', '--json'], {
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', BSK_HOME: bskHome, BSK_AUTO_START: '0' },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(status.stdout).text()
    await status.exited
    try {
      const parsed = JSON.parse(out) as { browsers?: unknown[] }
      if ((parsed.browsers?.length ?? 0) > 0) {
        logger.info('BrowserSkill extension connected')
        return
      }
    } catch {
      // daemon not answering yet; retry below
    }
    await Bun.sleep(1_000)
  }
  logger.warn('BrowserSkill extension did not connect to its daemon; bsk commands will fail until it does')
}
