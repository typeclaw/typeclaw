import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path, { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from './canonical-secrets'

const execFileAsync = promisify(execFile)

export type WritableZones = {
  dirs: string[]
  files: string[]
}

export type ProtectedZones = {
  dirs: string[]
  files: string[]
}

// SECURITY: a blanket RW bind is coarser than the write/edit guards, so this set
// is deliberately NARROWER than the write/edit allowlist — only genuinely
// free-write scratch zones. `.agents/skills` and `packages` are excluded: the
// former is validated (SKILL.md shape, name, frontmatter) by the skillAuthoring
// guard and the latter holds executable plugin code; bash must not get blanket
// RW to either. Skill authoring and package writes go through the guarded
// write/edit tool only.
// `.git` is writable so a member can `git add`/`git commit` their own edits.
// This is the AGENT'S OWN repo, not a shared/upstream one, so writing history
// is not a privilege boundary: a low-trust role staging a tracked path it
// cannot edit in the worktree (e.g. via `git update-index --cacheinfo` plumbing)
// only writes the agent's own history — content the backup runner already
// force-commits on idle regardless. So we deliberately do NOT try to confine
// commit *content* to the worktree write-allowlist; that boundary governs the
// working tree, not the object database.
//
// The one thing writable `.git` must NOT grant is code execution in the
// UNSANDBOXED runtime (backup/dreaming commit the same .git out of band): a
// planted `.git/hooks/*` or a `core.hooksPath` in `.git/config` would fire there
// as a higher-privilege process. resolveProtectedZones re-binds `.git/hooks` and
// `.git/config` read-only (after the writable .git bind, last-op-wins) to close
// exactly that escalation.
const WRITABLE_DIRS = ['workspace', 'public', 'mounts', '.git'] as const

// SECURITY: configured writable paths (`sandbox.writablePaths`) may NOT resolve
// onto these. `.git` carries the hook/config escalation surface; `.env` and
// `secrets.json`/`auth.json` are credential files; `sessions`/`memory` are the agent's
// private surface (masked from low-trust roles by hidden-paths); `.typeclaw`
// holds system-managed home persistence; `node_modules` is executable
// dependency code. Granting blanket RW to any of these via config would defeat
// the very guards the narrow built-in set exists to preserve. The agent root
// itself is also rejected (a writablePaths of '' or '.') — an RW bind of the
// whole tree erases the read-only confinement wholesale.
const FORBIDDEN_WRITABLE_ROOTS = [
  '.git',
  ...CANONICAL_AGENT_SECRET_FILES,
  'sessions',
  'memory',
  '.typeclaw',
  ...CANONICAL_AGENT_SECRET_DIRS,
  'node_modules',
] as const

// Bash may EDIT these when present; creating a MISSING root file goes through
// write/edit (bwrap cannot RW-bind a non-existent source without pre-creating it).
//
// SECURITY: the semantically-guarded managed files (`cron.json`, `typeclaw.json`)
// are deliberately EXCLUDED. Those two are the only files gated by the
// managedConfig / cronPromotion guards, which fire on the `write`/`edit` tools
// only. Granting bash a blanket RW bind to them opened a bypass: an agent
// blocked from writing cron.json through the guarded tools could just
// `echo … > cron.json` from bash and defeat the guard entirely. Keeping them off
// this list forces every mutation of a guarded file through the one guarded path
// (the write/edit tool), so a managed file has exactly one mutation boundary.
// `package.json` stays off this list: confined roles do not reshape the agent
// package. Root-writable roles edit it, `bun.lock`, and node_modules through
// their full agent-root bind.
const WRITABLE_ROOT_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'] as const

// SECURITY: the symlink rejection is load-bearing. An RW bind follows symlinks,
// so a `workspace -> /etc` symlink at a zone root would grant write access to an
// outside path. (Symlinks INSIDE a real zone are already safe — the kernel
// resolves them to the read-only parent mount.)
//
// `configuredWritablePaths` are operator-chosen agent-relative dirs from
// `sandbox.writablePaths`. They join the built-in dirs through the SAME
// existence + symlink filter, plus the extra guardrails in
// `resolveConfiguredWritableDirs`: each must resolve inside agentDir and must
// not land on a forbidden root. A path that fails any check is dropped, never
// throws — a stale config should degrade the one bad entry, not abort sandboxing.
export async function resolveWritableZones(
  agentDir: string,
  configuredWritablePaths: readonly string[] = [],
): Promise<WritableZones> {
  const builtinDirs = await collectExisting(
    WRITABLE_DIRS.map((d) => join(agentDir, d)),
    'dir',
  )
  const configuredDirs = await resolveConfiguredWritableDirs(agentDir, configuredWritablePaths)
  const files = await collectExisting(
    WRITABLE_ROOT_FILES.map((f) => join(agentDir, f)),
    'file',
  )
  return { dirs: dedupe([...builtinDirs, ...configuredDirs]), files }
}

// SECURITY: validation is on the REAL path, not the lexical one. A lexical-only
// check (resolve + isInside) is bypassable by a symlinked INTERMEDIATE component:
// with `/agent/alias -> /tmp/outside` (or `-> /agent/sessions`) and a config of
// `alias/sub`, the lexical path `/agent/alias/sub` passes isInside and the
// forbidden-root check, while the bwrap `--bind` follows the ancestor symlink to
// write outside /agent (or onto a forbidden root). The zone-root lstat alone
// can't see it — lstat of the final component follows ancestor symlinks. So we
// realpath BOTH the candidate and agentDir (+ the forbidden roots) and validate
// the resolved targets. A path whose real form escapes agentDir or lands on a
// real forbidden root is dropped. realpath also rejects the final component
// being a symlink (its real target is re-checked), subsuming the prior lstat.
async function resolveConfiguredWritableDirs(agentDir: string, configured: readonly string[]): Promise<string[]> {
  const realAgentDir = await realpathOrUndefined(agentDir)
  if (realAgentDir === undefined) return []
  const realForbidden = await resolveRealForbiddenRoots(agentDir)

  const accepted: string[] = []
  for (const rel of configured) {
    const absolute = resolve(agentDir, rel)
    // Cheap lexical pre-filter: reject obvious escapes before touching the disk.
    if (absolute === agentDir || !isInside(agentDir, absolute)) continue
    const real = await realpathOrUndefined(absolute)
    if (real === undefined) continue
    if (!(await isRealEntry(real, 'dir'))) continue
    if (real === realAgentDir || !isInside(realAgentDir, real)) continue
    if (realForbidden.some((root) => real === root || isInside(root, real))) continue
    // Bind the lexical (caller-facing) path; bwrap resolves it to `real` itself.
    accepted.push(absolute)
  }
  return accepted
}

async function resolveRealForbiddenRoots(agentDir: string): Promise<string[]> {
  const resolved: string[] = []
  for (const root of FORBIDDEN_WRITABLE_ROOTS) {
    const real = await realpathOrUndefined(join(agentDir, root))
    if (real !== undefined) resolved.push(real)
  }
  return resolved
}

async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target)
  } catch {
    return undefined
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

// Read-only re-protections rendered on top of the writable .git bind. Unlike
// the writable resolvers, this MUST NOT drop absent entries: .git is writable,
// so a path absent at jail-build time would otherwise be CREATED by sandboxed
// bash (e.g. a planted .git/hooks/pre-commit) and then executed by the
// unsandboxed runtime git ops. So we ensure each protected path exists first,
// then always RO-bind it — a read-only bind of a real dir blocks creating
// children inside it (EROFS), and a read-only bind of config keeps its real
// content readable (commits need user.name/email) while blocking mutation.
//
// We also resolve the effective core.hooksPath from the real (about-to-be-RO)
// config: if it already points at a writable location (e.g. workspace/hooks),
// the .git/hooks RO-bind alone would not cover it, so that dir is protected too.
//
// node_modules is deliberately NOT protected. The agent package is the agent's
// to grow: root-writable roles run `bun add`/`bun install` there. Those roles
// can already load their own code into the runtime through a local plugin under
// packages/, so a read-only dependency tree guarded nothing they lacked, and
// confined roles never get a writable bind over it (their root stays read-only
// and node_modules is a forbidden writable path). Host installs never run its
// lifecycle scripts (src/init/run-bun-install.ts).
export async function resolveProtectedZones(agentDir: string): Promise<ProtectedZones> {
  const layout = await resolveGitControlLayout(agentDir)
  if (layout === undefined) return { dirs: [], files: [] }

  const dirs = [await ensureProtectedDir(layout.defaultHooksDir)]
  const files: string[] = []
  for (const configFile of layout.configFiles) files.push(await ensureProtectedFile(configFile))
  if (layout.gitEntryFile !== undefined) files.push(layout.gitEntryFile)

  const hooksPathDir = await resolveEffectiveHooksPath(agentDir, layout)
  if (hooksPathDir !== undefined && !dirs.includes(hooksPathDir)) {
    dirs.push(await ensureProtectedDir(hooksPathDir))
  }

  return { dirs: dedupe(dirs), files: dedupe(files) }
}

export async function isGitControlPath(agentDir: string, candidate: string): Promise<boolean> {
  const absolute = resolve(agentDir, candidate)
  const real = await realpathOrUndefined(absolute)
  const candidates = real === undefined ? [absolute] : [absolute, real]
  const lexicalGit = join(agentDir, '.git')
  const lexicalGitstore = join(agentDir, '.gitstore')
  if (candidates.some((path) => isLexicalGitControlPath(path, lexicalGit, lexicalGitstore))) {
    return true
  }

  const layout = await resolveGitControlLayout(agentDir)
  if (layout === undefined) return false
  if (candidates.some((path) => layout.configFiles.includes(path))) return true
  if (candidates.some((path) => path === layout.defaultHooksDir || isInside(layout.defaultHooksDir, path))) return true
  const effectiveHooks = await resolveEffectiveHooksPath(agentDir, layout)
  return (
    effectiveHooks !== undefined && candidates.some((path) => path === effectiveHooks || isInside(effectiveHooks, path))
  )
}

function isLexicalGitControlPath(candidate: string, dotGit: string, gitstore: string): boolean {
  return (
    candidate === dotGit ||
    candidate === join(dotGit, 'config') ||
    candidate === join(dotGit, 'hooks') ||
    isInside(join(dotGit, 'hooks'), candidate) ||
    candidate === join(gitstore, 'config') ||
    candidate === join(gitstore, 'hooks') ||
    isInside(join(gitstore, 'hooks'), candidate)
  )
}

type GitControlLayout = {
  gitEntryFile?: string
  gitDir: string
  defaultHooksDir: string
  configFiles: string[]
}

async function resolveGitControlLayout(agentDir: string): Promise<GitControlLayout | undefined> {
  const dotGit = join(agentDir, '.git')
  const gitstore = join(agentDir, '.gitstore')
  let gitDir: string
  let gitEntryFile: string | undefined

  const dotGitStats = await lstatOrUndefined(dotGit)
  if (dotGitStats?.isDirectory()) {
    gitDir = dotGit
  } else if (dotGitStats?.isFile()) {
    const pointer = await readFile(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer)
    if (match?.[1] === undefined) throw new Error(`sandbox: invalid worktree gitdir pointer ${dotGit}`)
    gitDir = resolve(agentDir, match[1])
    await assertRealDirectory(gitDir)
    gitEntryFile = dotGit
  } else {
    const gitstoreStats = await lstatOrUndefined(gitstore)
    if (!gitstoreStats?.isDirectory()) return undefined
    gitDir = gitstore
  }

  const commonDir = await resolveCommonGitDir(gitDir)
  const rootConfigFiles = [join(commonDir, 'config')]
  const worktreeConfig = join(gitDir, 'config.worktree')
  if (await isRealEntry(worktreeConfig, 'file')) rootConfigFiles.push(worktreeConfig)
  const configFiles = await resolveLocalConfigFiles(agentDir, gitDir, rootConfigFiles)
  return { gitEntryFile, gitDir, defaultHooksDir: join(commonDir, 'hooks'), configFiles }
}

async function resolveLocalConfigFiles(agentDir: string, gitDir: string, roots: readonly string[]): Promise<string[]> {
  if (!(await isRealEntry(roots[0] as string, 'file'))) return roots.map((root) => resolve(root))
  const result = await execLocalGitConfig(
    agentDir,
    gitDir,
    roots[0] as string,
    ['--includes', '--show-origin', '--null', '--name-only', '--list'],
    256 * 1024,
  )
  const fields = result.stdout.split('\0').filter((field) => field !== '')
  const origins: string[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const origin = fields[index]
    if (origin === undefined || !origin.startsWith('file:')) continue
    const configFile = resolve(origin.slice('file:'.length))
    if (configFile === agentDir || isInside(agentDir, configFile)) origins.push(configFile)
  }
  return dedupe([...roots.map((root) => resolve(root)), ...origins])
}

async function resolveCommonGitDir(gitDir: string): Promise<string> {
  try {
    const relative = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    if (relative.length === 0) return gitDir
    const commonDir = resolve(gitDir, relative)
    await assertRealDirectory(commonDir)
    return commonDir
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return gitDir
    throw error
  }
}

async function assertRealDirectory(target: string): Promise<void> {
  const stats = await lstat(target)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`sandbox: refusing non-directory git control root ${target}`)
  }
}

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Fail closed: a symlink at a protected path would make the RO bind follow it
// elsewhere, so reject it rather than silently protect the wrong target.
async function ensureProtectedDir(target: string): Promise<string> {
  await mkdir(target, { recursive: true })
  await assertNotSymlink(target)
  return target
}

async function ensureProtectedFile(target: string): Promise<string> {
  if (!(await isRealEntry(target, 'file'))) {
    try {
      await writeFile(target, '', { flag: 'wx' })
    } catch {
      // Lost a race (or it appeared); the symlink check below still guards it.
    }
  }
  await assertNotSymlink(target)
  return target
}

async function assertNotSymlink(target: string): Promise<void> {
  const stats = await lstat(target)
  if (stats.isSymbolicLink()) {
    throw new Error(`sandbox: refusing to protect symlinked path ${target}`)
  }
}

// Ask Git to parse the effective value so quoting, escapes, comments, include,
// and includeIf semantics exactly match the process that may later run hooks.
// Global/system config and prompt-driven helpers are disabled so only the
// repository-owned config graph can influence the result.
async function resolveEffectiveHooksPath(agentDir: string, layout: GitControlLayout): Promise<string | undefined> {
  let raw: string
  try {
    const result = await execLocalGitConfig(
      agentDir,
      layout.gitDir,
      layout.configFiles[0] as string,
      ['--includes', '--path', '--get', 'core.hooksPath'],
      64 * 1024,
    )
    raw = result.stdout.trim()
  } catch (error) {
    const code = (error as { code?: number | string }).code
    if (code === 1) return undefined
    throw error
  }
  if (raw.length === 0) return undefined
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(agentDir, raw)
  return isInside(agentDir, resolved) ? resolved : undefined
}

function gitConfigEnv(agentDir: string, gitDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: agentDir,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: agentDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

async function execLocalGitConfig(
  agentDir: string,
  gitDir: string,
  rootConfig: string,
  args: string[],
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string }> {
  const options = { env: gitConfigEnv(agentDir, gitDir), maxBuffer }
  try {
    return await execFileAsync(
      'git',
      [`--git-dir=${gitDir}`, `--work-tree=${agentDir}`, 'config', '--local', ...args],
      options,
    )
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    if (!stderr.includes('--local can only be used inside a git repository')) throw error
    return execFileAsync(
      'git',
      [`--git-dir=${gitDir}`, `--work-tree=${agentDir}`, 'config', '--file', rootConfig, ...args],
      options,
    )
  }
}

// SECURITY: a writable RW bind renders AFTER the masks and last-op-wins, so an
// RW bind on a masked path would re-expose the real (hidden) directory. Drop any
// writable zone that is, or is nested under, a masked path so the confidentiality
// boundary survives — e.g. a guest's masked `workspace/` is never re-exposed RW.
export function subtractMasked(writable: WritableZones, masked: { dirs: string[]; files: string[] }): WritableZones {
  const maskedDirs = masked.dirs
  const isMasked = (target: string): boolean =>
    masked.files.includes(target) || maskedDirs.some((dir) => target === dir || isInside(dir, target))
  return {
    dirs: writable.dirs.filter((dir) => !isMasked(dir)),
    files: writable.files.filter((file) => !isMasked(file)),
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function collectExisting(paths: string[], kind: 'dir' | 'file'): Promise<string[]> {
  const checks = await Promise.all(paths.map((p) => isRealEntry(p, kind)))
  return paths.filter((_, i) => checks[i])
}

async function isRealEntry(path: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return false
    return kind === 'dir' ? stats.isDirectory() : stats.isFile()
  } catch {
    return false
  }
}
