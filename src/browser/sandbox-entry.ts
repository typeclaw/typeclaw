import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'

import { BSK_BIN, BSK_DAEMON_PORT } from './registry'

// Runs INSIDE the browser's bwrap sandbox, which has no network namespace of
// its own beyond loopback and no view of /agent outside the browser files
// directory. It bridges two filesystem sockets (which cross network
// namespaces) to the private loopback: egress for Chrome's SOCKS proxy, and the
// DevTools socket the runtime's token relay dials. Exits when Chrome exits so
// the runtime supervisor restarts the whole set.

export type SandboxEntryConfig = {
  chrome: string
  runDir: string
  profileDir: string
  downloadsDir: string
  extensionDirs: string[]
  // Without an X display (docker.file.xvfb off) Chrome must run headless or it exits at startup.
  headless: boolean
  bsk?: { home: string }
}

const SOCKS_PORT = 1080
const DEVTOOLS_PORT = 9222

export function egressSocket(runDir: string): string {
  return join(runDir, 'egress.sock')
}

export function devtoolsSocket(runDir: string): string {
  return join(runDir, 'devtools.sock')
}

export function chromeArgs(config: SandboxEntryConfig): string[] {
  const args = [
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${config.profileDir}`,
    `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
    // Chromium sends loopback direct by default, which here is the sandbox's own
    // empty loopback; route it through the bridge so container dev servers load.
    // The BrowserSkill daemon is the one service that lives on sandbox loopback.
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${BSK_DAEMON_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080',
  ]
  // Headed Chrome quits once its last window closes, and a session closing its
  // last tab would restart the browser and drop every session-cookie login.
  if (config.headless) args.push('--headless=new')
  else args.push('--keep-alive-for-test')
  if (config.extensionDirs.length > 0) {
    const list = config.extensionDirs.join(',')
    args.push(`--load-extension=${list}`, `--disable-extensions-except=${list}`)
  }
  args.push('about:blank')
  return args
}

async function main(config: SandboxEntryConfig): Promise<void> {
  await clearSingletonLocks(config.profileDir)
  await writeDownloadPreference(config)
  await rm(devtoolsSocket(config.runDir), { force: true })
  const servers = [
    bridge(`127.0.0.1:${SOCKS_PORT}`, () => connect(egressSocket(config.runDir)), { port: SOCKS_PORT }),
    bridge(devtoolsSocket(config.runDir), () => connect({ host: '127.0.0.1', port: DEVTOOLS_PORT }), {
      path: devtoolsSocket(config.runDir),
    }),
  ]
  await Promise.all(servers.map((s) => s.listening))

  const chrome = Bun.spawn([config.chrome, ...chromeArgs(config)], { stdout: 'ignore', stderr: 'ignore' })
  const bsk =
    config.bsk === undefined
      ? undefined
      : Bun.spawn([BSK_BIN, 'daemon', 'start', '--foreground'], {
          env: { ...process.env, BSK_HOME: config.bsk.home, BSK_AUTO_START: '0' },
          stdout: 'ignore',
          stderr: 'ignore',
        })
  const code = await chrome.exited
  bsk?.kill()
  process.exit(code)
}

function bridge(
  label: string,
  dial: () => Socket,
  listen: { port: number } | { path: string },
): { listening: Promise<void> } {
  const server = createServer((inbound) => {
    const outbound = dial()
    inbound.pipe(outbound)
    outbound.pipe(inbound)
    const close = (): void => {
      inbound.destroy()
      outbound.destroy()
    }
    inbound.on('error', close)
    outbound.on('error', close)
    inbound.on('close', close)
    outbound.on('close', close)
  })
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`${label}: ${String(error)}`)))
    if ('port' in listen) server.listen(listen.port, '127.0.0.1', () => resolve())
    else server.listen(listen.path, () => resolve())
  })
  return { listening }
}

// Downloads land in the browser files directory, which privileged bash sees at
// the same path; Chrome's default ~/Downloads would be lost on the sandbox tmpfs.
// Merged into the persisted Preferences so the rest of the profile's settings survive.
export async function writeDownloadPreference(config: SandboxEntryConfig): Promise<void> {
  const defaultProfile = join(config.profileDir, 'Default')
  await mkdir(defaultProfile, { recursive: true })
  await mkdir(config.downloadsDir, { recursive: true })
  const file = join(defaultProfile, 'Preferences')
  const existing = await readPreferences(file)
  const preferences = {
    ...existing,
    download: { ...asRecord(existing['download']), default_directory: config.downloadsDir, prompt_for_download: false },
    savefile: { ...asRecord(existing['savefile']), default_directory: config.downloadsDir },
  }
  // Same-directory temp + rename: an interrupted boot never leaves a truncated file.
  const temp = `${file}.typeclaw-tmp`
  await writeFile(temp, JSON.stringify(preferences))
  await rename(temp, file)
}

// A malformed file must not keep Chrome down on every boot: set it aside for
// diagnosis and start from empty preferences.
async function readPreferences(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    // fall through to quarantine
  }
  await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
  return {}
}

// The profile outlives the container, and Chrome refuses a profile whose lock
// names another host (every container has a new hostname). Whatever Chrome held
// it before has exited, since this entry only runs after the previous one did.
export async function clearSingletonLocks(profileDir: string): Promise<void> {
  await Promise.all(
    ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) => rm(join(profileDir, name), { force: true })),
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

if (import.meta.main) {
  await main(JSON.parse(process.argv[2] ?? '{}') as SandboxEntryConfig)
}
