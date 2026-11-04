import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validateDependencyBins, type DependencyBinIssue, type ResolvedDependencyBin } from '@/dependencies'

export const DEPENDENCY_BIN_DIR_NAME = 'typeclaw-dependency-bin'
export const DEPENDENCY_BIN_SANDBOX_DIR = `/tmp/${DEPENDENCY_BIN_DIR_NAME}`
export const DEPENDENCY_BIN_SANDBOX_PATH = `${DEPENDENCY_BIN_SANDBOX_DIR}:/usr/local/bin:/usr/bin:/bin`

export type DependencyBinReconciliation = {
  wrapperDir: string
  resolutions: ResolvedDependencyBin[]
  unavailable: Extract<ResolvedDependencyBin, { kind: 'unavailable' }>[]
  issues: DependencyBinIssue[]
  protectedFiles: string[]
}

const reconciliationLocks = new Map<string, Promise<void>>()

export async function reconcileDependencyBinWrappers(options: {
  agentDir: string
  sessionTmp: string
  baselineDirs?: readonly string[]
  // Runtime-provided commands (bin name -> entrypoint), e.g. the TypeVault CLI
  // TypeClaw itself ships. Never derived from the agent's package.json.
  runtimeBins?: Readonly<Record<string, string>>
}): Promise<DependencyBinReconciliation> {
  const dir = join(options.sessionTmp, DEPENDENCY_BIN_DIR_NAME)
  const previous = reconciliationLocks.get(dir) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => gate)
  reconciliationLocks.set(dir, queued)
  await previous
  try {
    return await reconcileDependencyBinWrappersUnlocked(options, dir)
  } finally {
    release()
    if (reconciliationLocks.get(dir) === queued) reconciliationLocks.delete(dir)
  }
}

async function reconcileDependencyBinWrappersUnlocked(
  options: {
    agentDir: string
    sessionTmp: string
    baselineDirs?: readonly string[]
    runtimeBins?: Readonly<Record<string, string>>
  },
  dir: string,
): Promise<DependencyBinReconciliation> {
  const validation = await validateDependencyBins(options.agentDir, options.baselineDirs)
  await ensureWrapperDir(dir)
  const wrappers = new Map<string, string>()
  for (const resolution of validation.resolutions) {
    if (resolution.kind !== 'package' || wrappers.has(resolution.declaration.bin)) continue
    wrappers.set(resolution.declaration.bin, renderWrapper(resolution.containerEntrypoint))
  }
  for (const [bin, entrypoint] of Object.entries(options.runtimeBins ?? {})) {
    if (!wrappers.has(bin)) wrappers.set(bin, renderWrapper(entrypoint))
  }
  for (const entry of await readdir(dir).catch(() => [])) {
    if (entry.startsWith('.')) continue
    if (!wrappers.has(entry)) await rm(join(dir, entry), { recursive: true, force: true })
  }
  for (const [bin, contents] of wrappers) {
    const path = join(dir, bin)
    if (await isCurrentWrapper(path, contents)) continue
    const temporary = join(dir, `.${bin}.${randomUUID()}.tmp`)
    await writeFile(temporary, contents, { mode: 0o755, flag: 'wx' })
    await rename(temporary, path).catch(async (error) => {
      await rm(temporary, { force: true })
      // POSIX rename replaces atomically, but Windows can fail while a concurrent
      // reconcile holds the destination. Losing that race is benign as long as the
      // winner wrote the identical wrapper.
      if (await isCurrentWrapper(path, contents)) return
      throw error
    })
  }
  return {
    wrapperDir: dir,
    resolutions: validation.resolutions,
    unavailable: validation.unavailable,
    issues: validation.issues,
    protectedFiles: validation.protectedFiles,
  }
}

export function dependencyBinUnavailableHint(
  command: string,
  reconciliation: DependencyBinReconciliation,
): string | undefined {
  const unavailable = reconciliation.unavailable.find((entry) => commandInvokesBin(command, entry.declaration.bin))
  if (unavailable === undefined) return undefined
  const declaration = unavailable.declaration
  return `[typeclaw:capability-unavailable capability=dependency-bin dependency=${declaration.package} bin=${declaration.bin} action=operator-install]`
}

async function ensureWrapperDir(dir: string): Promise<void> {
  const existing = await lstat(dir).catch(() => undefined)
  if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) {
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

async function isCurrentWrapper(path: string, expected: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
  if (handle === undefined) return false
  try {
    const [contents, info] = await Promise.all([handle.readFile('utf8'), handle.stat()])
    // Windows has no POSIX permission bits, so requiring 0o755 there would make
    // every wrapper look stale and defeat both idempotence and race recovery.
    const modeMatches = process.platform === 'win32' || (info.mode & 0o777) === 0o755
    return info.isFile() && modeMatches && contents === expected
  } finally {
    await handle.close()
  }
}

function renderWrapper(entrypoint: string): string {
  return `#!/bin/sh\nexec bun ${shellQuote(entrypoint)} "$@"\n`
}

function commandInvokesBin(command: string, bin: string): boolean {
  const escaped = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[;&|()\\n]\\s*)${escaped}(?:\\s|$)`).test(command)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
