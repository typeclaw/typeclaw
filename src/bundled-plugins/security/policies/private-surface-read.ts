import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  realpathSync,
  statSync,
  type Dir,
  type Dirent,
  type Stats,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS } from '@/agent/tools-without-local-file-operands'
import {
  RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG,
  realIntendedPathSync,
} from '@/path-safety/real-intended-path'
import type { ToolFileOperands, ToolProvenance } from '@/plugin'
import {
  CANONICAL_AGENT_SECRET_FILES,
  CANONICAL_HOME_SECRET_DIRS,
  CANONICAL_HOME_SECRET_FILES,
  CONTAINER_RUNTIME_HOME,
  RUNTIME_OWNED_SECRET_DIRS,
  type HiddenPaths,
} from '@/sandbox'

import type { SecurityBlock } from '../policy'

export const GUARD_PRIVATE_SURFACE_READ = 'privateSurfaceRead'

// First-party bash is excluded: its access to hidden paths is contained by the
// bwrap sandbox (applyBashSandbox), not by blocking the call. Every OTHER tool
// is scanned, so a new file-reading tool — bundled or third-party — is covered
// the day it ships without a whitelist edit. A plugin colliding with an exempt
// first-party name does not inherit the exemption.
//
// TOOLS_WITHOUT_LOCAL_FILE_OPERANDS is the SAME set the file-operand scanner
// skips: first-party tools whose args are only remote ids/control tokens
// (channel/stream/subagent/role reads). Without this, an id equal to a working
// dir — channel_read({ workspace: "memory" }) — would resolve to /agent/memory
// and be wrongly blocked here even after the scanner cleared it. Sharing one set
// keeps both enforcement points agreeing on which tools read no local path.
const UNSCANNED_TOOLS = new Set(['bash', ...TOOLS_WITHOUT_LOCAL_FILE_OPERANDS])
const VIRTUAL_FILESYSTEM_ROOTS = ['/proc', '/sys', '/dev', '/run'] as const
const HARDLINK_SCAN_EXCLUDED_AGENT_DIRS = new Set(['.git', '.gitstore', 'node_modules'])

// The bash sandbox hides the role's private surface — the working DIRECTORIES
// (workspace/, memory/, sessions/), unconditional credential directories, and
// secret FILES (.env, secrets.json, auth.json) —
// via bwrap masks, but every non-bash tool runs in the main process, outside
// any sandbox. find_entry, look_at, and the channel attachment tools all read
// files by a caller-supplied path, so without a guard a restricted role could
// read back through them exactly what bash masking denies. This guard mirrors
// the WHOLE deny-list (dirs + files) onto all of them, honouring the PR's
// "two enforcement points, one deny-list" invariant.
//
// It covers the full deny-list rather than delegating secret files to the
// secretExfilRead guard: that guard only inspects read/grep/find/ls (not
// edit/write/look_at/channel_send) and is acknowledgement-bypassable, so
// delegating would leave canonical credential files reachable through uncovered
// tools — exactly the gap the bash masks close. secretExfilRead remains as
// independent defense in depth for the four tools it does cover.
//
// Posture is FAIL-CLOSED: it does not whitelist a known
// set of tools (that fails open the moment a new reader is added). It scans
// every arg of every non-bash tool — recursively, since paths hide in nested
// shapes like look_at's images[].path and channel_send's attachments[].path —
// and blocks any string that resolves to (a secret file) or under (a hidden
// directory) the deny-list.
export function checkPrivateSurfaceReadGuard(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    hidden: HiddenPaths
    fileOperands?: ToolFileOperands
    toolProvenance?: ToolProvenance
  },
  hooks: PrivateSurfaceIdentityScanHooks = {},
): SecurityBlock | undefined {
  const { tool, args, agentDir, hidden, fileOperands, toolProvenance } = options
  if (toolProvenance === 'first-party' && UNSCANNED_TOOLS.has(tool)) return undefined
  try {
    const { canonicalDirs, canonicalFiles, roleDirs, roleFiles } = deniedSurface(agentDir, hidden)
    const canonicalEmpty = canonicalDirs.length === 0 && canonicalFiles.length === 0
    const roleEmpty = roleDirs.length === 0 && roleFiles.length === 0
    if (canonicalEmpty && roleEmpty) return undefined
    const realpath = hooks.realpathNative ?? realpathSync.native
    const nonFile = fileOperands?.nonFile === undefined ? undefined : new Set(fileOperands.nonFile)
    const localOperands = collectLocalOperandPaths(fileOperands)

    if (!canonicalEmpty) {
      const identityScanner = createHardlinkIdentityScanner(agentDir, canonicalDirs, canonicalFiles, hooks)
      for (const candidate of collectPathCandidates(
        args,
        tool,
        undefined,
        localOperands,
        true,
        toolProvenance === 'first-party',
      )) {
        const hit = matchHidden(candidate, agentDir, canonicalDirs, canonicalFiles, identityScanner, realpath)
        if (hit !== undefined) return privateSurfacePathBlock(tool, candidate, hit)
      }
    }

    if (!roleEmpty) {
      const identityScanner = createHardlinkIdentityScanner(agentDir, roleDirs, roleFiles, hooks)
      for (const candidate of collectPathCandidates(args, tool, nonFile, localOperands)) {
        const hit = matchHidden(candidate, agentDir, roleDirs, roleFiles, identityScanner, realpath)
        if (hit !== undefined) return privateSurfacePathBlock(tool, candidate, hit)
      }
    }
    return undefined
  } catch (error) {
    hooks.onInternalError?.(error)
    return {
      block: true,
      reason: `Guard \`${GUARD_PRIVATE_SURFACE_READ}\` blocked ${tool}: an internal guard error prevented safe path validation.`,
    }
  }
}

type PrivateSurfaceIdentityOptions = {
  tool: string
  agentDir: string
  hidden: HiddenPaths
}

export type PrivateSurfaceIdentityScanHooks = {
  maxEntries?: number
  openDirectory?(directory: string): Pick<Dir, 'readSync' | 'closeSync'>
  lstat?(candidate: string): Stats
  realpathNative?(candidate: string): string
  onInternalError?(error: unknown): void
  afterEntryLstat?(candidate: string, stats: Stats): void
}

export type PrivateSurfaceIdentityVerifier = {
  check(identity: Pick<Stats, 'dev' | 'ino' | 'nlink'>): SecurityBlock | undefined
}

export function createPrivateSurfaceReadIdentityVerifier(
  options: PrivateSurfaceIdentityOptions,
  hooks: PrivateSurfaceIdentityScanHooks = {},
): PrivateSurfaceIdentityVerifier {
  const { canonicalDirs, canonicalFiles, roleDirs, roleFiles } = deniedSurface(options.agentDir, options.hidden)
  const deniedDirs = [...new Set([...canonicalDirs, ...roleDirs])]
  const deniedFiles = [...new Set([...canonicalFiles, ...roleFiles])]
  const scanner = createHardlinkIdentityScanner(options.agentDir, deniedDirs, deniedFiles, hooks)
  return {
    check(identity) {
      if (identity.nlink <= 1) return undefined
      const hit = scanner.check(identity)
      return hit === undefined ? undefined : privateSurfaceBlock(options.tool, hit)
    },
  }
}

export function checkPrivateSurfaceReadIdentityGuard(
  options: PrivateSurfaceIdentityOptions & { identity: Pick<Stats, 'dev' | 'ino' | 'nlink'> },
  hooks: PrivateSurfaceIdentityScanHooks = {},
): SecurityBlock | undefined {
  return createPrivateSurfaceReadIdentityVerifier(options, hooks).check(options.identity)
}

function createHardlinkIdentityScanner(
  agentDir: string,
  deniedDirs: readonly string[],
  deniedFiles: readonly string[],
  hooks: PrivateSurfaceIdentityScanHooks,
): HardlinkIdentityScanner {
  const lstat = hooks.lstat ?? lstatSync
  return new HardlinkIdentityScanner({
    agentDir,
    deniedDirs,
    deniedFiles,
    maxEntries: hooks.maxEntries ?? MAX_HARDLINK_IDENTITY_ENTRIES,
    openDirectory:
      hooks.openDirectory === undefined
        ? openDescriptorAnchoredDirectory
        : createPathDirectoryOpener(hooks.openDirectory, lstat),
    lstat,
    realpath: hooks.realpathNative ?? realpathSync.native,
    afterEntryLstat: hooks.afterEntryLstat,
  })
}

function deniedSurface(
  agentDir: string,
  hidden: HiddenPaths,
): { canonicalDirs: string[]; canonicalFiles: string[]; roleDirs: string[]; roleFiles: string[] } {
  return {
    canonicalDirs: [
      ...new Set([
        ...RUNTIME_OWNED_SECRET_DIRS.map((dir) => path.join(agentDir, dir)),
        // homedir() follows the live container HOME; the fixed runtime path
        // keeps the same denial deterministic in host-stage tests and any
        // partially-initialized caller whose environment has not switched yet.
        ...CANONICAL_HOME_SECRET_DIRS.map((dir) => path.join(homedir(), dir)),
        ...CANONICAL_HOME_SECRET_DIRS.map((dir) => path.join(CONTAINER_RUNTIME_HOME, dir)),
      ]),
    ],
    // Keep runtime-owned credential stores independent of role-derived
    // visibility so a partially-wired caller cannot expose raw credentials.
    canonicalFiles: [
      ...new Set([
        ...CANONICAL_AGENT_SECRET_FILES.map((file) => path.join(agentDir, file)),
        ...CANONICAL_HOME_SECRET_FILES.map((file) => path.join(homedir(), file)),
        ...CANONICAL_HOME_SECRET_FILES.map((file) => path.join(CONTAINER_RUNTIME_HOME, file)),
      ]),
    ],
    roleDirs: [...new Set(hidden.dirs)],
    roleFiles: [...new Set(hidden.files)],
  }
}

function privateSurfacePathBlock(tool: string, candidate: string, hit: string): SecurityBlock {
  return {
    block: true,
    reason: [
      `Guard \`${GUARD_PRIVATE_SURFACE_READ}\` blocked ${tool}: argument \`${candidate}\` resolves to ${hit}, which is not available to LLM tools.`,
      'The bash sandbox masks the same path. Privileged roles cannot bypass canonical agent credential files; use host-side redacted diagnostics such as `typeclaw doctor`, `typeclaw provider list`, or `typeclaw channel list` instead.',
    ].join(' '),
  }
}

function privateSurfaceBlock(tool: string, hit: string): SecurityBlock {
  return {
    block: true,
    reason: [
      `Guard \`${GUARD_PRIVATE_SURFACE_READ}\` blocked ${tool}: input inode aliases ${hit}, which is not available to LLM tools.`,
      'The bash sandbox masks the same path. Privileged roles cannot bypass canonical agent credential files; use host-side redacted diagnostics instead.',
    ].join(' '),
  }
}

// Field names whose values are ALWAYS free text (prose/queries/ids), NEVER a
// filesystem path, for EVERY tool. Scanning them caused false positives: a
// guest's `channel_reply({ text: "the memory leak" })` or `web_search({ query:
// "workspace setup" })` resolve to a bare hidden-dir name and were wrongly
// blocked. This is a DENYLIST OF KEY NAMES, not a tool whitelist: an unknown
// field on an unknown tool is still scanned (fail-closed for new path-bearing
// readers); we only skip values whose KEY is universally free text. `command`
// is here because bash (its only user) is already exempt via UNSCANNED_TOOLS.
//
// `glob` and `pattern` are deliberately ABSENT — they are tool-dependent (a
// glob/path-filter in grep/find, a regex only in grep) and handled by
// FREE_TEXT_KEYS_BY_TOOL below.
const NON_PATH_KEYS = new Set([
  'text',
  'query',
  'prompt',
  'selector',
  'url',
  'message',
  'body',
  'content',
  'command',
  'reason',
  'subject',
  'description',
  'title',
  'name',
  // edit tool: replacement text is free-form and may quote a hidden path.
  'oldText',
  'newText',
  // memory append tool: fragment topic is free text.
  'topic',
])

const PATH_KEYS = /(?:^|[_-])(path|filepath|file)$/i
const CAMEL_PATH_KEYS = /(?:Path|Filepath|File)$/
const MAX_HARDLINK_IDENTITY_ENTRIES = 4_096

// Keys that are free text in SPECIFIC tools but path-bearing in others, so a
// global denylist would either over-block or open a bypass. Scoped per tool:
//   - grep.pattern  : a regex/search string (e.g. "sessions"), NOT a path.
// Notably NOT listed (and therefore SCANNED):
//   - grep.glob / find.pattern : both are glob path-filters resolved RELATIVE
//     to the search root, so `grep({ path: '.', glob: 'workspace/**' })` and
//     `find({ path: '.', pattern: 'workspace/**' })` reach a hidden subtree.
//     Exempting them let the only hidden-identifying arg through (the bypass a
//     review caught). They have no false-positive risk: path.resolve treats
//     glob metacharacters as literal, so `*.ts` -> `/agent/*.ts` (passes) while
//     `workspace/**` -> `/agent/workspace/**` (correctly blocked).
// Fail-closed: only the listed tool's listed key is exempted; an unknown tool
// (or grep gaining a new key) scans everything.
const FREE_TEXT_KEYS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  grep: new Set(['pattern']),
  // These channel tools use filename only as attachment display metadata. The
  // corresponding attachments[].path is scanned independently where present.
  channel_send: new Set(['filename']),
  channel_reply: new Set(['filename']),
  channel_fetch_attachment: new Set(['filename']),
}

// Canonical credential checks normally scan every field, including generic
// prose keys on unknown tools, because an unclassified plugin argument may
// dereference a local file. These channel tools have an explicit schema:
// addressing and message fields are remote identifiers or prose, while only
// attachments[].path can read a local file. Keep this per-tool and per-key so
// future tools remain fail-closed by default.
const CANONICAL_FREE_TEXT_KEYS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  channel_send: new Set(['adapter', 'workspace', 'chat', 'thread', 'text', 'filename']),
  channel_reply: new Set(['text', 'filename']),
}

// Unlike channel fields, edit replacement text is nested. Match its complete
// operand path so another field with the same key remains fail-closed.
const CANONICAL_FREE_TEXT_OPERANDS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  edit: new Set(['edits.oldText', 'edits.newText']),
  write: new Set(['content']),
}

// Trim before the `file:` test: an exempt prose key otherwise lets a
// leading-whitespace `file:  file://…/memory` URI slip past the scan (the value
// is not path-shaped and `isFileUrl` misses it), reaching a fetcher that trims
// before parsing. Returns the trimmed URI so callers scan the real target.
function trimmedFileUri(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.toLocaleLowerCase().startsWith('file:') ? trimmed : undefined
}

// Recursively collects strings that could be paths, skipping values under a
// universally-free-text key or a tool-scoped free-text key. Explicit path-like
// keys still win, and file:// values are normalized before matching. matchHidden then
// realpath-resolves each candidate and fires only on one landing inside a
// hidden directory. Fail-closed by design: a bare path-bearing value equal to a
// hidden dir name (e.g. `path: "memory"`) is still blocked. `underExempt`
// propagates so nested values under an exempt key (e.g. a structured pattern)
// stay exempt; top-level strings and array elements carry no key and are always
// scanned (so attachments[].path is collected).
//
// `nonFile` holds the tool author's declared control-token operand PATHS
// (`fileOperands.nonFile`, trusted metadata). A string at exactly one of those
// operand paths is skipped, mirroring the file-operand scanner so the two
// enforcement points agree — an id like `{ tenant: "memory" }` on a tool that
// declared `nonFile: ['tenant']` is not blocked here. Scoped by EXACT operand
// path (not key name), so an undeclared key still fails closed; `input`/
// `output`/`create`/`destructive` are never exemptions — they FORCE a scan (a
// declared real-file path that resolves under a hidden dir must still block).
// `localOperands` holds the declared `input`/`output`/`create`/`destructive`
// operand PATHS. A string at one of those paths is ALWAYS scanned, overriding
// both the prose-key exemptions above and any `nonFile` claim on the same path.
// Without that override the two exemption layers compose into a bypass: a tool
// declaring a real local operand under a universally-free-text key (`query`,
// `content`, `text`, `name`, ...) would have its value skipped here as prose,
// then dereferenced downstream — so `{ input: ['query'], query: 'memory/x' }`
// would reach a hidden directory the role cannot see. Declaring a path as a
// local file is exactly the claim that it is NOT prose.
function collectLocalOperandPaths(operands: ToolFileOperands | undefined): ReadonlySet<string> | undefined {
  if (operands === undefined) return undefined
  const paths = new Set([
    ...(operands.input ?? []),
    ...(operands.output ?? []),
    ...(operands.create ?? []),
    ...(operands.destructive ?? []),
  ])
  return paths.size === 0 ? undefined : paths
}

function collectPathCandidates(
  value: unknown,
  tool: string,
  nonFile?: ReadonlySet<string>,
  localOperands?: ReadonlySet<string>,
  disableExemptions = false,
  canonicalToolSemantics = false,
): string[] {
  const out: string[] = []
  walk(value, out, tool, false, nonFile, localOperands, '', disableExemptions, canonicalToolSemantics)
  return out
}

function walk(
  value: unknown,
  out: string[],
  tool: string,
  underExempt: boolean,
  nonFile: ReadonlySet<string> | undefined,
  localOperands: ReadonlySet<string> | undefined,
  operandPath: string,
  disableExemptions: boolean,
  canonicalToolSemantics: boolean,
  key?: string,
): void {
  if (typeof value === 'string') {
    if (!disableExemptions || canonicalToolSemantics) {
      const declaredLocal = localOperands?.has(operandPath) === true
      if (!declaredLocal) {
        if (nonFile?.has(operandPath) === true) return
        const isFileUrl = trimmedFileUri(value) !== undefined
        if (underExempt && !isPathKey(key) && !isFileUrl) return
      }
    }
    const normalized = normalizeCandidate(value)
    if (normalized !== undefined) out.push(normalized)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(
        item,
        out,
        tool,
        underExempt,
        nonFile,
        localOperands,
        operandPath,
        disableExemptions,
        canonicalToolSemantics,
        key,
      )
    }
    return
  }
  if (value !== null && typeof value === 'object') {
    const toolFreeText = FREE_TEXT_KEYS_BY_TOOL[tool]
    const canonicalToolFreeText = canonicalToolSemantics ? CANONICAL_FREE_TEXT_KEYS_BY_TOOL[tool] : undefined
    const canonicalToolFreeTextOperands = canonicalToolSemantics
      ? CANONICAL_FREE_TEXT_OPERANDS_BY_TOOL[tool]
      : undefined
    for (const [childKey, item] of Object.entries(value)) {
      const childPath = operandPath === '' ? childKey : `${operandPath}.${childKey}`
      const keyIsExempt =
        (!disableExemptions && (NON_PATH_KEYS.has(childKey) || (toolFreeText?.has(childKey) ?? false))) ||
        (canonicalToolFreeText?.has(childKey) ?? false) ||
        (canonicalToolFreeTextOperands?.has(childPath) ?? false)
      walk(
        item,
        out,
        tool,
        underExempt || keyIsExempt,
        nonFile,
        localOperands,
        childPath,
        disableExemptions,
        canonicalToolSemantics,
        childKey,
      )
    }
  }
}

// Resolving both sides against agentDir defeats traversal (workspace/../workspace/x),
// relative forms (./workspace), and absolute restatements. Secret files match on
// exact equality; hidden directories match the dir itself or anything under it,
// using a trailing slash so `workspace` does not also match a sibling
// `workspace-notes`.
//
// Symlink defense: lexical path.resolve is NOT enough. A restricted role can
// plant `public/leak -> ../.env` (or `-> ../memory`) via sandboxed bash, then
// read it back through a non-bash tool whose path lexically lands in the
// guest-visible `public/`. So we resolve the candidate's REAL path
// (realpathRealIntendedPath follows symlinks on every existing path component)
// before matching. Both sides are realpath'd because agentDir itself may sit
// under a symlink (e.g. /tmp -> /private/tmp on macOS); comparing a real
// candidate against a lexical deny-list would never match.
function matchHidden(
  candidate: string,
  agentDir: string,
  deniedDirs: string[],
  deniedFiles: string[],
  identityScanner: HardlinkIdentityScanner,
  realpath: (candidate: string) => string,
): string | undefined {
  const lexicalHit = matchLexicallyDenied(candidate, agentDir, deniedDirs, deniedFiles)
  if (lexicalHit !== undefined) return lexicalHit
  const lexical = path.resolve(agentDir, candidate)
  const resolved = realpathRealIntendedPath(lexical, realpath)
  const virtualRoot = virtualFilesystemRoot(lexical) ?? virtualFilesystemRoot(resolved)
  if (virtualRoot !== undefined) return `${virtualRoot}, a virtual or process-backed filesystem`
  for (const file of deniedFiles) {
    if (resolved === realpathRealIntendedPath(file, realpath) || hasSameFileIdentity(resolved, file)) return file
  }
  for (const dir of deniedDirs) {
    const realDir = realpathRealIntendedPath(dir, realpath)
    // realpathRealIntendedPath joins with the platform separator, so the
    // under-dir test must use path.sep too — a hardcoded "/" never matches the
    // "\"-joined paths a win32 test runner produces.
    if (resolved === realDir || resolved.startsWith(`${realDir}${path.sep}`)) return dir
  }
  const identity = fileIdentity(resolved)
  if (identity !== undefined && identity.nlink > 1) {
    const hit = identityScanner.check(identity)
    if (hit !== undefined) return hit
  }
  return undefined
}

function matchLexicallyDenied(
  candidate: string,
  agentDir: string,
  deniedDirs: readonly string[],
  deniedFiles: readonly string[],
): string | undefined {
  const absolute = portableAbsolute(agentDir, candidate)
  const virtualRoot = virtualFilesystemRoot(absolute)
  if (virtualRoot !== undefined) return `${virtualRoot}, a virtual or process-backed filesystem`
  for (const file of deniedFiles) {
    if (portableEqual(absolute, portableAbsolute(agentDir, file))) return file
  }
  for (const dir of deniedDirs) {
    const root = portableAbsolute(agentDir, dir)
    if (portableEqual(absolute, root) || portableInside(root, absolute)) return dir
  }
  return undefined
}

function portableAbsolute(agentDir: string, candidate: string): string {
  const normalized = candidate.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) return path.posix.normalize(normalized)
  if (normalized.startsWith('/')) return path.posix.normalize(normalized)
  return path.posix.resolve(agentDir.replaceAll('\\', '/'), normalized)
}

function portableEqual(left: string, right: string): boolean {
  const windows =
    /^[A-Za-z]:\//.test(left) || left.startsWith('//') || /^[A-Za-z]:\//.test(right) || right.startsWith('//')
  return windows ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right
}

function portableInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith('/') ? parent : `${parent}/`
  return portableEqual(child.slice(0, normalizedParent.length), normalizedParent)
}

function virtualFilesystemRoot(candidate: string): string | undefined {
  const normalized = candidate.replaceAll('\\', '/')
  for (const root of VIRTUAL_FILESYSTEM_ROOTS) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return root
  }
  return undefined
}

function fileIdentity(candidate: string): Pick<Stats, 'dev' | 'ino' | 'nlink'> | undefined {
  try {
    const stats = lstatSync(candidate)
    return stats.isFile() ? stats : undefined
  } catch {
    return undefined
  }
}

type HardlinkDirectory = {
  readSync(): Dirent | null
  statSync(): Stats
  lstatEntrySync(name: string): Stats
  openChildSync(name: string): HardlinkDirectory
  finishSync(): void
  closeSync(): void
}

type OpenedHardlinkDirectory = { reader: HardlinkDirectory; census: Stats }

function createPathDirectoryOpener(
  openDirectory: (directory: string) => Pick<Dir, 'readSync' | 'closeSync'>,
  lstat: (candidate: string) => Stats,
): (directory: string) => HardlinkDirectory {
  const openPath = (directory: string): HardlinkDirectory => {
    const reader = openDirectory(directory)
    let finished = false
    return {
      readSync: () => reader.readSync(),
      statSync: () => lstat(directory),
      lstatEntrySync: (name) => lstat(path.join(directory, name)),
      openChildSync: (name) => openPath(path.join(directory, name)),
      finishSync() {
        if (finished) return
        finished = true
        reader.closeSync()
      },
      closeSync() {
        if (!finished) reader.closeSync()
        finished = true
      },
    }
  }
  return openPath
}

function openDescriptorAnchoredDirectory(directory: string): HardlinkDirectory {
  if (process.platform !== 'linux') {
    throw new Error('hardlink identity traversal requires Linux descriptor anchoring')
  }
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const anchor = `/proc/self/fd/${descriptor}`
  let reader: Dir
  try {
    reader = opendirSync(anchor)
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
  let closed = false
  let finished = false
  return {
    readSync: () => reader.readSync(),
    statSync: () => fstatSync(descriptor),
    lstatEntrySync: (name) => lstatSync(path.join(anchor, name)),
    openChildSync: (name) => openDescriptorAnchoredDirectory(path.join(anchor, name)),
    finishSync() {
      if (finished) return
      finished = true
      reader.closeSync()
    },
    closeSync() {
      if (closed) return
      closed = true
      let closeError: unknown
      if (!finished) {
        try {
          reader.closeSync()
        } catch (error) {
          closeError = error
        }
      }
      try {
        closeSync(descriptor)
      } catch (error) {
        closeError ??= error
      }
      if (closeError !== undefined) throw closeError
    },
  }
}

type HardlinkIdentityScannerOptions = {
  agentDir: string
  deniedDirs: readonly string[]
  deniedFiles: readonly string[]
  maxEntries: number
  openDirectory(directory: string): HardlinkDirectory
  lstat(candidate: string): Stats
  realpath(candidate: string): string
  afterEntryLstat?(candidate: string, stats: Stats): void
}

class HardlinkIdentityScanner {
  private remaining: number
  private readonly visibleCounts = new Map<string, number>()
  private readonly deniedIdentities = new Map<string, string>()
  private readonly observedEntries = new Set<string>()
  private readonly openedDirectories = new Set<string>()
  private visibleScanned = false
  private deniedScanned = false
  private visibleFailure: string | undefined
  private deniedFailure: string | undefined
  private deniedFilesScanned = false

  constructor(private readonly options: HardlinkIdentityScannerOptions) {
    this.remaining = options.maxEntries
  }

  check(identity: Pick<Stats, 'dev' | 'ino' | 'nlink'>): string | undefined {
    const key = identityKey(identity)
    this.scanDeniedFiles()
    if (this.deniedFailure !== undefined) return this.deniedFailure
    const deniedFile = this.deniedIdentities.get(key)
    if (deniedFile !== undefined) return deniedFile

    this.scanDeniedTrees()
    const deniedAlias = this.deniedIdentities.get(key)
    if (deniedAlias !== undefined) return deniedAlias
    if (this.deniedFailure !== undefined) return this.deniedFailure

    this.scanVisibleTree()
    if (this.visibleFailure !== undefined) return this.visibleFailure
    if ((this.visibleCounts.get(key) ?? 0) >= identity.nlink) return undefined
    return 'hardlink identities could not be fully accounted within the agent tree'
  }

  private scanDeniedFiles(): void {
    if (this.deniedFilesScanned) return
    this.deniedFilesScanned = true
    for (const file of this.options.deniedFiles) {
      try {
        const stats = this.options.lstat(file)
        if (stats.isFile()) this.deniedIdentities.set(identityKey(stats), file)
      } catch (error) {
        if (isNotFoundError(error)) continue
        this.deniedFailure = `denied-file hardlink identity could not be read: ${file}`
        return
      }
    }
  }

  private scanVisibleTree(): void {
    if (this.visibleScanned) return
    this.visibleScanned = true
    const root = realpathRealIntendedPath(this.options.agentDir, this.options.realpath)
    const deniedRoots = this.options.deniedDirs.map((dir) => realpathRealIntendedPath(dir, this.options.realpath))
    const deniedFiles = new Set(
      this.options.deniedFiles.map((file) => realpathRealIntendedPath(file, this.options.realpath)),
    )
    const rootStats = this.readRootStats(root, 'visible')
    if (rootStats === undefined) return
    const rootDirectory = this.openVerifiedDirectory(root, rootStats, 'visible')
    if (rootDirectory === undefined) return
    const pending: Array<{
      directory: string
      reader: HardlinkDirectory
      identity: Pick<Stats, 'dev' | 'ino'>
      census: Stats
      agentRoot: boolean
    }> = [{ directory: root, ...rootDirectory, identity: rootStats, agentRoot: true }]
    const opened: Array<{ directory: string; reader: HardlinkDirectory; census: Stats }> = [
      { directory: root, ...rootDirectory },
    ]
    let scanCompleted = false
    try {
      while (pending.length > 0) {
        const current = pending.pop()
        if (current === undefined) break
        const completed = this.forEachEntry(current, 'visible', (entry, stats) => {
          const entryPath = path.join(current.directory, entry.name)
          if (current.agentRoot && HARDLINK_SCAN_EXCLUDED_AGENT_DIRS.has(entry.name)) return true
          if (deniedFiles.has(entryPath) || deniedRoots.some((deniedRoot) => isPathAtOrBelow(entryPath, deniedRoot))) {
            return true
          }
          if (stats.isDirectory()) {
            const child = this.openVerifiedChild(current, entry.name, stats, 'visible')
            if (child === undefined) return false
            const openedChild = { directory: entryPath, ...child }
            pending.push({ ...openedChild, identity: stats, agentRoot: false })
            opened.push(openedChild)
          } else if (stats.isFile()) {
            this.recordVisibleFile(stats)
          }
          return true
        })
        if (!completed) return
      }
      scanCompleted = true
    } finally {
      this.verifyAndCloseDirectories(opened, 'visible', scanCompleted)
    }
  }

  private scanDeniedTrees(): void {
    if (this.deniedScanned) return
    this.deniedScanned = true
    for (const deniedDir of this.options.deniedDirs) {
      let rootStats: Stats
      let root: string
      try {
        root = realpathRealIntendedPath(deniedDir, this.options.realpath)
        rootStats = this.options.lstat(root)
      } catch (error) {
        if (isNotFoundError(error)) continue
        this.deniedFailure = `denied-directory hardlink identity could not be read: ${deniedDir}`
        return
      }
      if (!rootStats.isDirectory()) {
        this.deniedFailure = `denied-directory hardlink identity root is not a directory: ${deniedDir}`
        return
      }
      const rootDirectory = this.openVerifiedDirectory(root, rootStats, 'denied')
      if (rootDirectory === undefined) return
      const pending: Array<{
        directory: string
        reader: HardlinkDirectory
        identity: Pick<Stats, 'dev' | 'ino'>
        census: Stats
      }> = [{ directory: root, ...rootDirectory, identity: rootStats }]
      const opened: Array<{ directory: string; reader: HardlinkDirectory; census: Stats }> = [
        { directory: root, ...rootDirectory },
      ]
      let scanCompleted = false
      try {
        while (pending.length > 0) {
          const current = pending.pop()
          if (current === undefined) break
          const completed = this.forEachEntry(current, 'denied', (entry, stats) => {
            const entryPath = path.join(current.directory, entry.name)
            if (stats.isDirectory()) {
              const child = this.openVerifiedChild(current, entry.name, stats, 'denied')
              if (child === undefined) return false
              const openedChild = { directory: entryPath, ...child }
              pending.push({ ...openedChild, identity: stats })
              opened.push(openedChild)
            } else if (stats.isFile()) {
              this.recordDeniedFile(stats, deniedDir)
            }
            return true
          })
          if (!completed) return
        }
        scanCompleted = true
      } finally {
        this.verifyAndCloseDirectories(opened, 'denied', scanCompleted)
      }
    }
  }

  private forEachEntry(
    current: {
      directory: string
      reader: HardlinkDirectory
      identity: Pick<Stats, 'dev' | 'ino'>
    },
    surface: 'visible' | 'denied',
    visit: (entry: Dirent, stats: Stats) => boolean,
  ): boolean {
    let completed = true
    try {
      while (true) {
        const entry = current.reader.readSync()
        if (entry === null) break
        if (!this.consumeEntry(surface)) {
          completed = false
          break
        }
        if (!this.claimEntryObservation(current.identity, entry.name, surface)) {
          completed = false
          break
        }
        let stats: Stats
        try {
          stats = current.reader.lstatEntrySync(entry.name)
          this.options.afterEntryLstat?.(path.join(current.directory, entry.name), stats)
        } catch {
          this.recordEntryFailure(path.join(current.directory, entry.name), surface)
          completed = false
          break
        }
        if (!visit(entry, stats)) {
          completed = false
          break
        }
        try {
          const confirmed = current.reader.lstatEntrySync(entry.name)
          if (!sameDirectoryEntry(stats, confirmed)) {
            this.recordEntryFailure(path.join(current.directory, entry.name), surface)
            completed = false
            break
          }
        } catch {
          this.recordEntryFailure(path.join(current.directory, entry.name), surface)
          completed = false
          break
        }
      }
    } catch {
      this.recordDirectoryFailure(current.directory, surface)
      completed = false
    } finally {
      try {
        current.reader.finishSync()
      } catch {
        this.recordDirectoryFailure(current.directory, surface)
        completed = false
      }
    }
    return completed
  }

  private readRootStats(directory: string, surface: 'visible' | 'denied'): Stats | undefined {
    try {
      const stats = this.options.lstat(directory)
      if (!stats.isDirectory()) {
        this.recordDirectoryFailure(directory, surface)
        return undefined
      }
      return stats
    } catch {
      this.recordDirectoryFailure(directory, surface)
      return undefined
    }
  }

  private openVerifiedDirectory(
    directory: string,
    expected: Pick<Stats, 'dev' | 'ino'>,
    surface: 'visible' | 'denied',
  ): OpenedHardlinkDirectory | undefined {
    let reader: HardlinkDirectory | undefined
    try {
      reader = this.options.openDirectory(directory)
      const opened = reader.statSync()
      if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
        this.recordDirectoryFailure(directory, surface)
        reader.closeSync()
        return undefined
      }
      if (!this.claimDirectoryIdentity(opened, directory, surface)) {
        reader.closeSync()
        return undefined
      }
      return { reader, census: opened }
    } catch {
      try {
        reader?.closeSync()
      } catch {}
      this.recordDirectoryFailure(directory, surface)
      return undefined
    }
  }

  private openVerifiedChild(
    parent: { directory: string; reader: HardlinkDirectory },
    name: string,
    expected: Pick<Stats, 'dev' | 'ino'>,
    surface: 'visible' | 'denied',
  ): OpenedHardlinkDirectory | undefined {
    const directory = path.join(parent.directory, name)
    let reader: HardlinkDirectory | undefined
    try {
      reader = parent.reader.openChildSync(name)
      const opened = reader.statSync()
      if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
        this.recordDirectoryFailure(directory, surface)
        reader.closeSync()
        return undefined
      }
      if (!this.claimDirectoryIdentity(opened, directory, surface)) {
        reader.closeSync()
        return undefined
      }
      return { reader, census: opened }
    } catch {
      try {
        reader?.closeSync()
      } catch {}
      this.recordDirectoryFailure(directory, surface)
      return undefined
    }
  }

  private verifyAndCloseDirectories(
    opened: Array<{ directory: string; reader: HardlinkDirectory; census: Stats }>,
    surface: 'visible' | 'denied',
    verify: boolean,
  ): void {
    for (const current of opened.reverse()) {
      if (verify) {
        try {
          if (!sameDirectoryCensus(current.census, current.reader.statSync())) {
            this.recordDirectoryFailure(current.directory, surface)
          }
        } catch {
          this.recordDirectoryFailure(current.directory, surface)
        }
      }
      try {
        current.reader.closeSync()
      } catch {
        this.recordDirectoryFailure(current.directory, surface)
      }
    }
  }

  private recordDirectoryFailure(directory: string, surface: 'visible' | 'denied'): void {
    const reason = `${surface} hardlink identity directory could not be read: ${directory}`
    if (surface === 'visible') this.visibleFailure = reason
    else this.deniedFailure = reason
  }

  private consumeEntry(surface: 'visible' | 'denied'): boolean {
    if (this.remaining > 0) {
      this.remaining -= 1
      return true
    }
    const reason = `hardlink identity entry limit exceeded (${this.options.maxEntries})`
    if (surface === 'visible') this.visibleFailure = reason
    else this.deniedFailure = reason
    return false
  }

  private recordEntryFailure(candidate: string, surface: 'visible' | 'denied'): void {
    const reason = `${surface} hardlink identity could not be read: ${candidate}`
    if (surface === 'visible') this.visibleFailure = reason
    else this.deniedFailure = reason
  }

  private claimDirectoryIdentity(
    identity: Pick<Stats, 'dev' | 'ino'>,
    directory: string,
    surface: 'visible' | 'denied',
  ): boolean {
    const key = identityKey(identity)
    if (this.openedDirectories.has(key)) {
      this.recordDirectoryFailure(directory, surface)
      return false
    }
    this.openedDirectories.add(key)
    return true
  }

  private claimEntryObservation(
    directoryIdentity: Pick<Stats, 'dev' | 'ino'>,
    name: string,
    surface: 'visible' | 'denied',
  ): boolean {
    const key = `${identityKey(directoryIdentity)}:${JSON.stringify(name)}`
    if (this.observedEntries.has(key)) {
      this.recordEntryFailure(name, surface)
      return false
    }
    this.observedEntries.add(key)
    return true
  }

  private recordVisibleFile(stats: Stats): void {
    const key = identityKey(stats)
    this.visibleCounts.set(key, (this.visibleCounts.get(key) ?? 0) + 1)
  }

  private recordDeniedFile(stats: Stats, deniedRoot: string): void {
    this.deniedIdentities.set(identityKey(stats), deniedRoot)
  }
}

function identityKey(identity: Pick<Stats, 'dev' | 'ino'>): string {
  return `${identity.dev}:${identity.ino}`
}

function sameDirectoryEntry(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.nlink === after.nlink
  )
}

function sameDirectoryCensus(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

function isPathAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function isPathKey(key: string | undefined): boolean {
  return key !== undefined && (PATH_KEYS.test(key) || CAMEL_PATH_KEYS.test(key))
}

function normalizeCandidate(value: string): string | undefined {
  const uri = trimmedFileUri(value)
  if (uri === undefined) return value
  try {
    const url = new URL(uri)
    const pathname = decodeURIComponent(url.pathname)
    if (url.hostname !== '') return `//${url.hostname}${pathname}`
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1)
    // Keep synthetic POSIX container paths platform-independent. fileURLToPath
    // would reinterpret file:///agent/... through the Windows host grammar.
    if (pathname.startsWith('/agent/') || pathname === '/agent') return pathname
    return fileURLToPath(uri)
  } catch {
    return value
  }
}

function hasSameFileIdentity(candidate: string, deniedFile: string): boolean {
  try {
    const candidateStats = statSync(candidate)
    const deniedStats = statSync(deniedFile)
    return candidateStats.dev === deniedStats.dev && candidateStats.ino === deniedStats.ino
  } catch {
    return false
  }
}

// Sync keeps the guard synchronous; the cost is one syscall per existing
// component, negligible at the tool-call boundary. The broader errno recovery
// is confined to this denylist matcher; guard plugin write policies retain the
// allowlist-oriented default. See @/path-safety/real-intended-path.
function realpathRealIntendedPath(absolutePath: string, realpath: (candidate: string) => string): string {
  return realIntendedPathSync(absolutePath, realpath, {
    recoverable: RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG,
    onExhausted: 'return-input',
  })
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
