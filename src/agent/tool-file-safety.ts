import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, constants, createWriteStream, fstatSync, lstatSync, openSync, statSync, type Stats } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import {
  checkPrivateSurfaceReadGuard,
  createPrivateSurfaceReadIdentityVerifier,
  type PrivateSurfaceIdentityVerifier,
} from '@/bundled-plugins/security/policies/private-surface-read'
import {
  closeConfigWindow,
  configRecoveryGuards,
  configRecoveryPending,
  concurrentCallGuards,
  contentOf,
  identityOf,
  MANAGED_CONFIG_FILES,
  noteConfigRollbackSync,
  noteConfigWriteSync,
  openConfigWindow,
  readConfigEntrySync,
  readConfigForWriteSync,
  readValidatedConfigFileSync,
  recordConfigCommitSync,
  restoreConfigEntrySync,
  runWithConfigBaseline,
  sameConfigContent,
  setConfigRecovery,
  setTrustedConfigEntry,
  trustedConfigState,
  writeConfigInPlaceSync,
  type ConfigCallGuard,
  type ConfigFileEntry,
  type ConfigFileIdentity,
} from '@/config/config-commits'
import { withConfigFileLock } from '@/config/config-file-lock'
import type { ToolFileOperands, ToolLogger, ToolProvenance, ToolResult } from '@/plugin'
import { CANONICAL_AGENT_SECRET_FILES } from '@/sandbox/canonical-secrets'
import type { HiddenPaths } from '@/sandbox/hidden-paths'

import { normalizeFileReference } from './file-reference'
import { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS } from './tools-without-local-file-operands'

export { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS }

type Rewrite = { original: string; pinned: string }
type FileTarget = { get(): string; original: string; set(value: string): void; uri: boolean }
type OutputTarget = { target: FileTarget; mode: 'reserved' | 'exclusive-create' }
type VerifiedInput = {
  target: FileTarget
  original: string
  resolved: string
  dev: number
  ino: number
  size: number
  kind: 'file' | 'directory'
}

export const TOOL_INPUT_MAX_BYTES = {
  // read supports offset/limit browsing, so permit large source files while
  // bounding the immutable whole-object snapshot.
  read: 64 * 1024 * 1024,
  // Keep local images on the same budget as look_at's bounded URL fetch.
  look_at: 20 * 1024 * 1024,
  // Preserve common channel upload sizes without allowing unbounded copies.
  channel_upload: 100 * 1024 * 1024,
} as const

export const TOOL_INPUT_MAX_COUNT = {
  read: 1,
  look_at: 16,
  channel_upload: 32,
} as const

export const PINNED_SNAPSHOT_GLOBAL_MAX_BYTES = TOOL_INPUT_MAX_BYTES.channel_upload
export const PINNED_SNAPSHOT_GLOBAL_MAX_COUNT = TOOL_INPUT_MAX_COUNT.channel_upload
export const PINNED_SNAPSHOT_MAX_WAITERS = 32
const TOOL_OUTPUT_MAX_COUNT = 32
export const TREE_SNAPSHOT_MAX_ENTRIES = 4096
// Names-only snapshots (ls/find) write empty placeholders, so an entry costs an
// inode, not a copy; a long-lived agent's workspace easily outgrows 4096.
const TREE_NAMES_SNAPSHOT_MAX_ENTRIES = 65_536
// fd reads these to honor ignore rules, so find needs their real contents.
const FIND_IGNORE_FILE_NAMES = new Set(['.gitignore', '.ignore', '.fdignore'])
// ripgrep's own binary heuristic: a NUL in the leading block. rg skips such
// files during recursive search, so grep snapshots them as empty placeholders.
// rg transcodes BOM-prefixed UTF-16 before that check, so those stay searchable.
const BINARY_SNIFF_BYTES = 8192
const AGENT_ROOT_SNAPSHOT_EXCLUDED_DIRS = new Set(['.git', '.gitstore', 'node_modules'])

export const TOOL_INPUT_TEMP_PREFIX = 'typeclaw-tool-input-'

export type PinnedToolFiles = {
  restoreResult(result: ToolResult): ToolResult
  cleanup(): Promise<void>
}

type PinnedOutputTarget = PinnedToolFiles & {
  rollback(): Promise<void>
}

// Test-only seam: pauses between budget acquisition and source open/stream so a
// test can grow a file post-authorization deterministically, without racing the
// scheduler. Production never passes hooks.
export type EnforceAndPinToolFilesHooks = {
  afterBudgetAcquire?(): void | Promise<void>
  pinnedSnapshotBudgetForTests?: ReturnType<typeof createPinnedSnapshotBudgetForTests>
}

export async function enforceAndPinToolFiles(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    tempRoot?: string
    genericInputs?: boolean
    fileOperands?: ToolFileOperands
    hidden?: HiddenPaths
    logger?: Pick<ToolLogger, 'warn'>
    signal?: AbortSignal
    toolProvenance?: ToolProvenance
  },
  hooks: EnforceAndPinToolFilesHooks = {},
): Promise<PinnedToolFiles> {
  if (options.signal?.aborted === true) throw abortError(options.signal)
  const maxCount = maxInputCount(options.tool)
  const targets = fileTargets(
    options.tool,
    options.args,
    maxCount,
    options.genericInputs === true,
    options.fileOperands,
    options.agentDir,
    options.logger,
    options.toolProvenance,
  )
  enforceCanonicalSecretDenial(options)
  const outputs = outputTargets(options.tool, options.args, TOOL_OUTPUT_MAX_COUNT, options.fileOperands)
  if (targets.length === 0) return outputs.length === 0 ? noPinnedFiles() : await pinOutputTargets(options, outputs)

  let dir: string | undefined
  const rewrites: Rewrite[] = []
  const omittedLinks: { root: string; count: number; names: string[] }[] = []
  const verified: VerifiedInput[] = []
  const maxBytes = maxInputBytes(options.tool)
  const identityOptions = {
    tool: options.tool,
    agentDir: options.agentDir,
    hidden: options.hidden ?? { dirs: [], files: [] },
  }
  const initialIdentityVerifier = createPrivateSurfaceReadIdentityVerifier(identityOptions)
  let lease: BudgetLease | undefined
  try {
    let declaredBytes = 0
    for (const target of targets) {
      const original = target.get()
      const absolute = path.resolve(options.agentDir, original)
      const resolved = await realpath(absolute).catch((error) => {
        if (isNotFoundError(error)) throw new Error(`tool input did not exist while being authorized: ${original}`)
        throw error
      })
      enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
      const inspected = await stat(resolved)
      const kind = inspected.isFile()
        ? 'file'
        : inspected.isDirectory() && isTreeInputTool(options.tool)
          ? 'directory'
          : undefined
      if (kind === undefined) throw new Error(`tool input is not a supported regular file or directory: ${original}`)
      if (kind === 'file') {
        assertRegularInputFile(inspected, original)
        enforceInputIdentityDenial(initialIdentityVerifier, inspected)
      }
      if (kind === 'file' && inspected.size > maxBytes) throw inputTooLarge(original, inspected.size, maxBytes)
      declaredBytes += kind === 'file' ? inspected.size : 0
      if (declaredBytes > maxBytes) throw aggregateInputTooLarge(declaredBytes, maxBytes)
      verified.push({ target, original, resolved, dev: inspected.dev, ino: inspected.ino, size: inspected.size, kind })
    }

    lease = await (hooks.pinnedSnapshotBudgetForTests ?? pinnedSnapshotBudget).acquire(
      declaredBytes,
      verified.length,
      options.signal,
    )
    await hooks.afterBudgetAcquire?.()
    const openedIdentityVerifier = createPrivateSurfaceReadIdentityVerifier(identityOptions)

    dir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), TOOL_INPUT_TEMP_PREFIX))
    let copiedBytes = 0
    for (let i = 0; i < verified.length; i++) {
      const input = verified[i] as VerifiedInput
      const slot = path.join(dir, String(i))
      // Files keep their original basename under a per-operand slot: tools that
      // derive a name or type from the path (channel uploads, mime sniffing by
      // extension) would otherwise see the bare index, e.g. a Discord file named `0`.
      const pinned = input.kind === 'file' ? path.join(slot, path.basename(input.original)) : slot
      if (input.kind === 'file') {
        await mkdir(slot, { mode: 0o700 })
        const source = await openInput(input.resolved, input.original)
        try {
          const opened = await source.stat()
          assertRegularInputFile(opened, input.original)
          if (opened.dev !== input.dev || opened.ino !== input.ino) {
            throw new Error(`tool input changed while waiting for snapshot capacity: ${input.original}`)
          }
          enforceInputIdentityDenial(openedIdentityVerifier, opened)
          copiedBytes += await streamSnapshot(
            source,
            pinned,
            input.original,
            maxBytes,
            copiedBytes,
            lease,
            verified.length,
            options.signal,
          )
          await chmod(pinned, 0o400)
        } finally {
          await source.close()
        }
      } else {
        const snapshot = await snapshotDirectoryTree({
          source: input,
          destination: pinned,
          agentDir: options.agentDir,
          tool: options.tool,
          maxBytes,
          previouslyCopied: copiedBytes,
          lease,
          operandCount: verified.length,
          hidden: options.hidden,
          signal: options.signal,
        })
        copiedBytes += snapshot.copied
        if (snapshot.omittedLinks.count > 0) {
          omittedLinks.push({ root: input.original, ...snapshot.omittedLinks })
        }
      }
      const executionValue = input.target.uri ? pathToFileURL(pinned).href : pinned
      input.target.set(executionValue)
      rewrites.push({ original: input.target.original, pinned: executionValue })
    }
    if (!lease.resize(copiedBytes, verified.length)) throw processBudgetGrowthExceeded(copiedBytes)
  } catch (error) {
    try {
      if (dir !== undefined) await removePinnedSnapshot(dir)
    } finally {
      lease?.release()
    }
    throw error
  }

  if (dir === undefined) return noPinnedFiles()

  let cleaned = false

  const inputPinned: PinnedToolFiles = {
    restoreResult(result) {
      let restored = result
      for (const rewrite of rewrites) restored = replaceResultPath(restored, rewrite)
      return appendSnapshotOmissions(restored, omittedLinks)
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      try {
        await removePinnedSnapshot(dir)
      } finally {
        lease?.release()
      }
    },
  }
  if (outputs.length === 0) return inputPinned

  try {
    const outputPinned = await pinOutputTargets(options, outputs)
    return composePinnedFiles([inputPinned, outputPinned])
  } catch (error) {
    await cleanupPinnedFilesReverse([inputPinned], true)
    throw error
  }
}

async function removePinnedSnapshot(root: string): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    await chmod(directory, 0o700)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name))
    }
  }
  await rm(root, { recursive: true, force: true })
}

// Canonical credential denial is the one check no operand declaration can waive:
// `fileOperands` is destructured away rather than spread through, so a tool (or a
// remote MCP server) declaring `nonFile` on an operand cannot make `secrets.json`,
// `.env`, or `~/.ssh` pass here. Role-derived private directories stay declarable
// and are enforced separately by the private-surface-read guard.
export function enforceCanonicalSecretDenial(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  toolProvenance?: ToolProvenance
}): void {
  const { tool, args, agentDir, toolProvenance } = options
  const blocked = checkPrivateSurfaceReadGuard({
    tool,
    args,
    agentDir,
    hidden: { dirs: [], files: [] },
    ...(toolProvenance !== undefined ? { toolProvenance } : {}),
  })
  if (blocked !== undefined) throw new Error(`blocked: ${blocked.reason}`)
}

function fileTargets(
  tool: string,
  args: Record<string, unknown>,
  maxCount: number,
  genericInputs: boolean,
  fileOperands: ToolFileOperands | undefined,
  agentDir: string,
  logger: Pick<ToolLogger, 'warn'> | undefined,
  toolProvenance: ToolProvenance | undefined,
): FileTarget[] {
  if (isOutputTool(tool)) return []
  // This domain operation authorizes and snapshots the selected Git root inside
  // its own credential-free sandbox. Generic file pinning cannot copy a repo.
  if (tool === 'coding_agent' && toolProvenance === 'first-party') return []
  if (toolProvenance === 'first-party' && TOOLS_WITHOUT_LOCAL_FILE_OPERANDS.has(tool)) return []
  if (tool === 'read' && typeof args.path === 'string') return [propertyTarget(args, 'path')]
  if (isTreeInputTool(tool)) {
    if (typeof args.path !== 'string') args.path = '.'
    return [propertyTarget(args, 'path')]
  }
  const targets: FileTarget[] = []
  const addPath = (value: unknown): void => {
    if (!isRecord(value) || typeof value.path !== 'string') return
    targets.push(propertyTarget(value, 'path'))
    if (targets.length > maxCount) throw inputCountTooLarge(targets.length, maxCount)
  }
  if (tool === 'look_at') {
    if (Array.isArray(args.images)) for (const image of args.images) addPath(image)
    return targets
  }
  // The only file operand for these tools is `attachments[].path`; `text` is free-form
  // prose (dates like "7/16", URLs, fractions) that must never reach the generic scan,
  // which rejects any value carrying a `/` or `\`. Return early even without attachments
  // so a text-only message is never misread as a path. Attachment pinning is unchanged.
  if (tool === 'channel_send' || tool === 'channel_reply') {
    if (Array.isArray(args.attachments)) for (const attachment of args.attachments) addPath(attachment)
    return targets
  }
  if (tool === 'channel_fetch_attachment') return targets
  // post_github_review has no local file operands: `comments[].path` are remote
  // GitHub diff anchors and the `body` fields are markdown. Scanning them as
  // generic operands either pins a real-repo anchor into a /tmp file:// path that
  // leaks into the posted review, or throws "ambiguous local file operand".
  if (tool === 'post_github_review') return targets
  if (genericInputs) collectGenericFileTargets(tool, args, targets, maxCount, fileOperands, agentDir, logger)
  return targets
}

// Exact tool + operand-path pairs for first-party PROSE operands (message
// bodies, prompts, queries, regex/CSS/jq strings) that are never a local file.
// This table is for tools that ALSO have a real file operand and so cannot be
// whole-tool exempt via TOOLS_WITHOUT_LOCAL_FILE_OPERANDS: web_fetch pins its
// `url` (non-file URLs are exempt while file: URIs still snapshot) and treats
// `query`/`selector`/`pattern` as prose. Pure control-token tools (reload, grant_role, stream_snapshot,
// channel_edit, …) live in that set instead, so they are absent here.
//
// Scoped by full operand path, NOT key name — this is the fail-closed invariant:
// an undeclared plugin/MCP reader that reuses `content`/`prompt`/`query` must
// still hit the scan and cannot inherit an exemption from a common key name.
// Plugin/MCP tools declare their own via `fileOperands.nonFile` (survives the
// runtime `__plugin_*` name prefix, which a static table here would not).
const NON_FILE_OPERANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  skip_response: new Set(['reason']),
  web_search: new Set(['query']),
  web_fetch: new Set(['url', 'query', 'selector', 'pattern']),
  todo_write: new Set(['todos.content']),
}

function isKnownNonFileOperand(tool: string, operandPath: string): boolean {
  return NON_FILE_OPERANDS[tool]?.has(operandPath) === true
}

// Detection trims first: a leading-whitespace `  file://…` is still a file
// reference to any consumer that trims before parsing, so it must be pinned or
// denied, never passed through untouched. The original untrimmed string is
// preserved on the target for result restoration; the trimmed URI is what gets
// normalized and snapshotted.
function isFileUri(value: string): boolean {
  return value.trim().toLocaleLowerCase().startsWith('file:')
}

function propertyTarget(object: Record<string, unknown>, key: string): FileTarget {
  const raw = object[key] as string
  return {
    get: () => normalizeFileReference(object[key] as string),
    original: raw,
    set: (value) => {
      object[key] = value
    },
    uri: isFileUri(raw),
  }
}

function arrayTarget(array: unknown[], index: number): FileTarget {
  const raw = array[index] as string
  return {
    get: () => normalizeFileReference(array[index] as string),
    original: raw,
    set: (value) => {
      array[index] = value
    },
    uri: isFileUri(raw),
  }
}

function outputTargets(
  tool: string,
  args: Record<string, unknown>,
  maxCount: number,
  operands: ToolFileOperands | undefined,
): OutputTarget[] {
  if (isOutputTool(tool)) {
    return typeof args.path === 'string' ? [{ target: propertyTarget(args, 'path'), mode: 'reserved' }] : []
  }
  const outputPaths = new Set(operands?.output ?? [])
  const createPaths = new Set(operands?.create ?? [])
  for (const operandPath of outputPaths) {
    if (createPaths.has(operandPath)) {
      throw new Error(`file operand ${JSON.stringify(operandPath)} cannot be both output and create`)
    }
  }
  const targets: OutputTarget[] = []
  collectDeclaredOutputTargets(args, targets, maxCount, outputPaths, 'reserved')
  collectDeclaredOutputTargets(args, targets, maxCount, createPaths, 'exclusive-create')
  return targets
}

function collectDeclaredOutputTargets(
  value: unknown,
  out: OutputTarget[],
  maxCount: number,
  declared: ReadonlySet<string>,
  mode: OutputTarget['mode'],
  parentPath = '',
): void {
  if (Array.isArray(value)) {
    const declaredOutput = declared.has(parentPath)
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (declaredOutput) {
          out.push({ target: arrayTarget(value, index), mode })
          if (out.length > maxCount) throw outputCountTooLarge(out.length, maxCount)
        }
        continue
      }
      collectDeclaredOutputTargets(item, out, maxCount, declared, mode, parentPath)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [childKey, item] of Object.entries(value)) {
    const operandPath = parentPath === '' ? childKey : `${parentPath}.${childKey}`
    if (typeof item === 'string' && declared.has(operandPath)) {
      out.push({ target: propertyTarget(value, childKey), mode })
      if (out.length > maxCount) throw outputCountTooLarge(out.length, maxCount)
      continue
    }
    collectDeclaredOutputTargets(item, out, maxCount, declared, mode, operandPath)
  }
}

function collectGenericFileTargets(
  tool: string,
  value: unknown,
  out: FileTarget[],
  maxCount: number,
  operands: ToolFileOperands | undefined,
  agentDir: string,
  logger: Pick<ToolLogger, 'warn'> | undefined,
  parentPath = '',
): void {
  if (Array.isArray(value)) {
    const declaredInput = operands?.input?.includes(parentPath) === true
    const nonInput =
      operands?.output?.includes(parentPath) === true ||
      operands?.create?.includes(parentPath) === true ||
      operands?.destructive?.includes(parentPath) === true
    const key = parentPath.split('.').at(-1) ?? parentPath
    // Precedence: declared input pins; declared output/destructive is not an
    // input; a known non-file operand is opaque (skipped, even a file: URI);
    // otherwise an explicit file: URI pins and an undeclared path-shaped value
    // fails closed. Both the static first-party table and a plugin's declared
    // `fileOperands.nonFile` are tool+operand-path scoped, so an unknown tool
    // never inherits an exemption from a common key name.
    const declaredNonFile = !declaredInput && operands?.nonFile?.includes(parentPath) === true
    const knownNonFile = !declaredInput && isKnownNonFileOperand(tool, parentPath)
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (declaredNonFile || (knownNonFile && !isFileUri(item))) continue
        if (!nonInput && (isFileUri(item) || declaredInput)) {
          out.push(arrayTarget(value, index))
          if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        } else if (!nonInput && isAmbiguousUndeclaredLocalOperand(item, agentDir, key)) {
          warnForUndeclaredExistingLocalOperand(logger, tool, parentPath, item, agentDir)
          throw new Error(
            `ambiguous local file operand at key ${JSON.stringify(parentPath)}; the tool author must declare fileOperands.input or the caller must use a file: URI`,
          )
        }
        continue
      }
      collectGenericFileTargets(tool, item, out, maxCount, operands, agentDir, logger, parentPath)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [childKey, item] of Object.entries(value)) {
    const operandPath = parentPath === '' ? childKey : `${parentPath}.${childKey}`
    if (typeof item === 'string') {
      const declaredInput = operands?.input?.includes(operandPath) === true
      const nonInput =
        operands?.output?.includes(operandPath) === true ||
        operands?.create?.includes(operandPath) === true ||
        operands?.destructive?.includes(operandPath) === true
      // Declared input wins; a known non-file operand (web_search.query,
      // web_fetch.selector, a plugin's declared `fileOperands.nonFile`, …) is
      // opaque and skipped even when its value is a file: URI; everything else
      // falls to the file:/heuristic scan below. Scoped by exact tool+operand-
      // path so an undeclared plugin reader using `content`/`prompt` still
      // fails closed.
      const declaredNonFile = !declaredInput && operands?.nonFile?.includes(operandPath) === true
      const knownNonFile = !declaredInput && isKnownNonFileOperand(tool, operandPath)
      if (declaredNonFile || (knownNonFile && !isFileUri(item))) continue
      if (!nonInput && (isFileUri(item) || declaredInput)) {
        out.push(propertyTarget(value, childKey))
        if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        continue
      }
      if (!nonInput && isAmbiguousUndeclaredLocalOperand(item, agentDir, childKey)) {
        warnForUndeclaredExistingLocalOperand(logger, tool, operandPath, item, agentDir)
        throw new Error(
          `ambiguous local file operand at key ${JSON.stringify(operandPath)}; the tool author must declare fileOperands.input or the caller must use a file: URI`,
        )
      }
    }
    collectGenericFileTargets(tool, item, out, maxCount, operands, agentDir, logger, operandPath)
  }
}

function noPinnedFiles(): PinnedToolFiles {
  return { restoreResult: (result) => result, cleanup: async () => {} }
}

function composePinnedFiles(pinned: readonly PinnedToolFiles[]): PinnedToolFiles {
  return {
    restoreResult(result) {
      return pinned.reduceRight((restored, entry) => entry.restoreResult(restored), result)
    },
    async cleanup() {
      await cleanupPinnedFilesReverse(pinned)
    },
  }
}

async function cleanupPinnedFilesReverse(pinned: readonly PinnedToolFiles[], suppressErrors = false): Promise<void> {
  let firstError: unknown
  for (let index = pinned.length - 1; index >= 0; index -= 1) {
    try {
      await pinned[index]?.cleanup()
    } catch (error) {
      firstError ??= error
    }
  }
  if (!suppressErrors && firstError !== undefined) throw firstError
}

async function openInput(absolute: string, original: string): Promise<FileHandle> {
  try {
    return await open(absolute, constants.O_RDONLY)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`tool input did not exist while being authorized: ${original}`)
    }
    throw error
  }
}

async function pinOutputTargets(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    signal?: AbortSignal
  },
  targets: OutputTarget[],
): Promise<PinnedToolFiles> {
  const pinned: PinnedOutputTarget[] = []
  try {
    for (const target of targets) pinned.push(await pinOutputTarget(options, target))
  } catch (error) {
    for (let index = pinned.length - 1; index >= 0; index -= 1) {
      await pinned[index]?.rollback().catch(() => {})
    }
    throw error
  }
  return composePinnedFiles(pinned)
}

async function pinOutputTarget(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    signal?: AbortSignal
  },
  output: OutputTarget,
): Promise<PinnedOutputTarget> {
  const { target } = output
  if (options.signal?.aborted === true) throw abortError(options.signal)
  const original = target.get()
  const absolute = path.resolve(options.agentDir, original)
  enforceCanonicalSecretDenial({ tool: options.tool, args: { path: absolute }, agentDir: options.agentDir })
  if (process.platform !== 'linux') {
    throw new Error('write/edit output authorization requires Linux inode anchoring; refusing an unanchored path')
  }
  const parent = path.dirname(absolute)
  const basename = path.basename(absolute)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | noFollow).catch((error) => {
    if (isNotFoundError(error))
      throw new Error(`write/edit parent directory does not exist for anchored output: ${parent}`)
    throw error
  })
  let targetHandle: FileHandle | undefined
  let targetIdentity: { dev: number; ino: number } | undefined
  let created = false
  let anchored: string | undefined
  try {
    const fdRoot = '/proc/self/fd'
    const resolvedParent = await realpath(`${fdRoot}/${directory.fd}`)
    enforceCanonicalSecretDenial({
      tool: options.tool,
      args: { path: path.join(resolvedParent, basename) },
      agentDir: options.agentDir,
    })
    const anchoredOutput = `${fdRoot}/${directory.fd}/${basename}`
    anchored = anchoredOutput
    if (output.mode === 'exclusive-create') {
      const existing = await open(anchoredOutput, constants.O_RDONLY | noFollow).catch((error) => {
        if (isNotFoundError(error)) return undefined
        throw error
      })
      if (existing !== undefined) {
        await existing.close()
        throw new Error(`write/edit output must not already exist: ${original}`)
      }
      target.set(anchoredOutput)
      let cleaned = false
      const finalize = async (verifyCreated: boolean): Promise<void> => {
        if (cleaned) return
        cleaned = true
        let verifyError: unknown
        if (verifyCreated) {
          try {
            await verifyExclusiveCreatedOutput({
              anchored: anchoredOutput,
              original,
              noFollow,
              tool: options.tool,
              agentDir: options.agentDir,
            })
          } catch (error) {
            verifyError = error
          }
        }
        const closeError = await directory.close().catch((error) => error)
        if (verifyError !== undefined) throw verifyError
        if (closeError !== undefined) throw closeError
      }
      return {
        restoreResult(result) {
          return replaceResultPath(result, { original, pinned: anchoredOutput })
        },
        async cleanup() {
          await finalize(true)
        },
        async rollback() {
          await finalize(false)
        },
      }
    }
    targetHandle = await open(anchoredOutput, constants.O_RDWR | noFollow).catch((error) => {
      if (isNotFoundError(error)) return undefined
      throw error
    })
    if (targetHandle === undefined) {
      targetHandle = await open(
        anchoredOutput,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o666,
      ).catch((error) => {
        if (error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ELOOP')) {
          throw new Error(`write/edit output destination changed while being authorized: ${original}`)
        }
        throw error
      })
      created = true
    }
    const inspected = await targetHandle.stat()
    if (!inspected.isFile() || inspected.nlink !== 1) {
      throw new Error(`write/edit output is not a single-link regular file: ${original}`)
    }
    const authorizedIdentity = { dev: inspected.dev, ino: inspected.ino }
    targetIdentity = authorizedIdentity
    const resolved = await realpath(`${fdRoot}/${targetHandle.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
    const executionPath = `${fdRoot}/${targetHandle.fd}`
    target.set(executionPath)
    let cleaned = false
    const finalize = async (removeCreated: boolean): Promise<void> => {
      if (cleaned) return
      cleaned = true
      let verifyError: unknown
      try {
        await verifyOutputEntry({
          anchored: anchoredOutput,
          original,
          identity: authorizedIdentity,
          noFollow,
          remove: removeCreated && created,
          tool: options.tool,
          agentDir: options.agentDir,
        })
      } catch (error) {
        verifyError = error
      }
      const outcomes = await Promise.allSettled([targetHandle?.close(), directory.close()])
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (verifyError !== undefined) throw verifyError
      if (failed?.status === 'rejected') throw failed.reason
    }
    return {
      restoreResult(result) {
        return replaceResultPath(result, { original, pinned: executionPath })
      },
      async cleanup() {
        await finalize(false)
      },
      async rollback() {
        await finalize(true)
      },
    }
  } catch (error) {
    if (created && anchored !== undefined && targetIdentity !== undefined) {
      await verifyOutputEntry({
        anchored,
        original,
        identity: targetIdentity,
        noFollow,
        remove: true,
        tool: options.tool,
        agentDir: options.agentDir,
      }).catch(() => {})
    }
    await Promise.allSettled([targetHandle?.close(), directory.close()])
    throw error
  }
}

async function verifyExclusiveCreatedOutput(options: {
  anchored: string
  original: string
  noFollow: number
  tool: string
  agentDir: string
}): Promise<void> {
  const verified = await open(options.anchored, constants.O_RDONLY | options.noFollow)
  try {
    const inspected = await verified.stat()
    if (!inspected.isFile() || inspected.nlink !== 1) {
      throw new Error(`write/edit output is not a single-link regular file: ${options.original}`)
    }
    const resolved = await realpath(`/proc/self/fd/${verified.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
  } finally {
    await verified.close()
  }
}

async function verifyOutputEntry(options: {
  anchored: string
  original: string
  identity: { dev: number; ino: number }
  noFollow: number
  remove: boolean
  tool: string
  agentDir: string
}): Promise<void> {
  const verified = await open(options.anchored, constants.O_RDONLY | options.noFollow)
  try {
    const inspected = await verified.stat()
    if (!inspected.isFile() || inspected.nlink !== 1) {
      throw new Error(`write/edit output is not a single-link regular file: ${options.original}`)
    }
    if (inspected.dev !== options.identity.dev || inspected.ino !== options.identity.ino) {
      throw new Error(`write/edit output destination changed during execution: ${options.original}`)
    }
    const resolved = await realpath(`/proc/self/fd/${verified.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
    if (options.remove) await unlink(options.anchored)
  } finally {
    await verified.close()
  }
}

export async function writeFileAnchored(options: {
  targetPath: string
  data: Uint8Array
  agentDir: string
  tool: string
}): Promise<void> {
  const absolute = path.resolve(options.targetPath)
  enforceCanonicalSecretDenial({ tool: options.tool, args: { path: absolute }, agentDir: options.agentDir })
  if (process.platform !== 'linux') {
    throw new Error('safe attachment writes require Linux inode anchoring; refusing an unanchored destination')
  }
  const parent = await createAndOpenAnchoredDirectory(path.dirname(absolute))
  let output: FileHandle | undefined
  let operationError: unknown
  let cleanupError: unknown
  try {
    const anchored = `/proc/self/fd/${parent.fd}/${path.basename(absolute)}`
    output = await open(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const opened = await output.stat()
    if (!opened.isFile() || opened.nlink !== 1)
      throw new Error('attachment destination is not a single-link regular file')
    const resolved = await realpath(`/proc/self/fd/${output.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
    await output.truncate(0)
    await output.writeFile(options.data)
  } catch (error) {
    operationError = error
  } finally {
    const outcomes = await Promise.allSettled([output?.close(), parent.close()])
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') cleanupError = failed.reason
  }
  if (operationError !== undefined) throw operationError
  if (cleanupError !== undefined) throw cleanupError
}

// The typeclaw.json and cron.json guards authorize a write/edit in tool.before,
// against the file as it was then, but the bytes land later. A stale write
// that passed that check could restore a value a privileged session has since
// changed. So a write to one of these files re-runs its guards on the exact
// bytes, against the file as it is now, and checked writes are serialized so
// no other one lands between a check and its write.
export type ManagedConfigCommitCheck = {
  agentDir: string
  signal?: AbortSignal
  check(content: string, destination: string): Promise<void>
}

// The queue serializes checked writes in this process, and each one holds the
// cross-process config file lock (src/config/config-file-lock.ts) from its check
// through its write, which host-side typeclaw config commands share. Writers
// that take no lock, namely model bash for roles that keep agent-root writes
// and hand edits, can still land between a check and its write and then be
// overwritten; see #1718. Bash is checked after the fact instead, by
// recheckManagedConfigAfterBash below.
const managedConfigCommitCheck = new AsyncLocalStorage<ManagedConfigCommitCheck | undefined>()
let checkedWrites: Promise<unknown> = Promise.resolve()

export function runWithManagedConfigCommitCheck<T>(check: ManagedConfigCommitCheck, fn: () => Promise<T>): Promise<T> {
  return managedConfigCommitCheck.run(check, fn)
}

// The bytes each checked edit of a managed file was built from.
const editBases = new WeakMap<ManagedConfigCommitCheck, Map<string, string>>()

// The edit tool's read. For typeclaw.json/cron.json it is what runtime readers
// load, so while a bash call is in flight the edit builds on the trusted bytes,
// never on that call's unchecked change; its commit then verifies, under the
// lock, that those bytes are still the trusted ones.
export async function readEditToolInput(absolutePath: string): Promise<Buffer> {
  const commit = managedConfigCommitCheck.getStore()
  const destination = commit === undefined ? undefined : await managedConfigDestination(commit.agentDir, absolutePath)
  if (commit === undefined || destination === undefined) return readFile(absolutePath)
  const base = readValidatedConfigFileSync(destination)
  const bases = editBases.get(commit) ?? new Map<string, string>()
  bases.set(destination, base)
  editBases.set(commit, bases)
  return Buffer.from(base)
}

export async function writeToolOutputNoFollow(targetPath: string, content: string): Promise<void> {
  const commit = managedConfigCommitCheck.getStore()
  const destination = commit === undefined ? undefined : await managedConfigDestination(commit.agentDir, targetPath)
  if (commit === undefined || destination === undefined) return writeOutputNoFollow(targetPath, content)
  const write = checkedWrites.then(async () => {
    commit.signal?.throwIfAborted()
    await withConfigFileLock(destination, async () => {
      // Guards decide on the managed path and read their baseline through it, so
      // the pinned descriptor must still be that entry's inode, before the check
      // and again before any byte is truncated.
      await assertPinnedEntry(targetPath, destination)
      const base = editBases.get(commit)?.get(destination)
      if (base !== undefined && readConfigForWriteSync(destination) !== base) {
        const name = path.basename(destination)
        throw new Error(
          `${name} changed after this edit read it, so the edit was not applied. Read ${name} again and retry the edit.`,
        )
      }
      // Guards authorize against the trusted bytes (during a bash window, not
      // the call's pending ones), but a write conflict is judged on the file
      // itself: an unlocked in-place edit (an operator's hand edit keeps the
      // inode) that lands while the guards run must not be overwritten. The live
      // bytes before the check are compared with the bytes on the descriptor
      // the write then goes through; an absent file must still be absent.
      const before = readConfigEntrySync(destination)
      await commit.check(content, destination)
      await assertPinnedEntry(targetPath, destination)
      const name = path.basename(destination)
      const conflict = () =>
        new Error(
          `${name} changed while this ${base === undefined ? 'write' : 'edit'} was being checked, so it was not applied. Read ${name} again and retry.`,
        )
      // A call cancelled while queued, while its guards ran, or during the entry
      // check above must not write; nothing is awaited between here and the write.
      commit.signal?.throwIfAborted()
      if (before.kind === 'missing') {
        noteConfigWriteSync(destination, content)
        await writeOutputNoFollow(targetPath, content).catch((error: unknown) => {
          throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? conflict() : error
        })
      } else {
        const live = readConfigEntrySync(destination)
        if (live.kind !== 'file' && live.kind !== 'link') throw conflict()
        noteConfigWriteSync(destination, content)
        writeConfigInPlaceSync(
          live.kind === 'link' ? live.resolved : destination,
          Buffer.from(content),
          pinnedIdentity(targetPath) ?? (live.kind === 'link' ? live.resolvedId : live.id),
          undefined,
          { bytes: contentOf(before) ?? Buffer.alloc(0), conflict },
        )
      }
      recordConfigCommitSync(destination, content)
    })
  })
  checkedWrites = write.catch(() => {})
  return write
}

// The identity of the file a pinned descriptor path names, if it is one.
function pinnedIdentity(targetPath: string): ConfigFileIdentity | undefined {
  return /^\/proc\/self\/fd\/\d+$/.test(targetPath) ? identityOf(statSync(targetPath, { bigint: true })) : undefined
}

async function assertPinnedEntry(targetPath: string, destination: string): Promise<void> {
  if (!/^\/proc\/self\/fd\/\d+$/.test(targetPath)) return
  const [pinned, entry] = await Promise.all([stat(targetPath), stat(destination).catch(() => undefined)])
  if (entry === undefined || pinned.dev !== entry.dev || pinned.ino !== entry.ino) {
    throw new Error(`${destination} was replaced after it was opened; refusing to write the stale file`)
  }
}

async function managedConfigDestination(agentDir: string, targetPath: string): Promise<string | undefined> {
  const destination = await realpath(targetPath).catch(() => path.resolve(targetPath))
  for (const file of MANAGED_CONFIG_FILES) {
    const managed = path.join(path.resolve(agentDir), file)
    if (destination === managed || destination === (await realpath(managed).catch(() => managed))) return managed
  }
  return undefined
}

// Per bash call: what each managed path looked like (lstat identity, plus the
// identity of the file a symlink names) and the newest authorized commit when
// the call started. An unchanged identity after the call costs nothing more.
export type ManagedConfigSnapshot = {
  call: symbol
  guard: ManagedConfigGuardCheck
  files: ReadonlyMap<string, { identity: CallIdentity; generation: number | undefined }>
  // When the call could not be coordinated with host typeclaw commands, the
  // managed files it must get read-only (existing regular files; the sandbox
  // can only bind those) and why.
  readOnly?: { files: string[]; reasons: string[] }
}

type CallIdentity = { link: ConfigFileIdentity | undefined; resolved: ConfigFileIdentity | undefined }

// Returns the guard's denial reason, or undefined when the content may land.
export type ManagedConfigGuardCheck = ConfigCallGuard

export type RecheckSeams = {
  writeInPlace?: (path: string, bytes: Buffer) => void
  // The rollback's read of the live file, before it restores.
  readLive?: (path: string) => ConfigFileEntry
}

export async function snapshotManagedConfigFiles(
  agentDir: string,
  guard: ManagedConfigGuardCheck,
): Promise<ManagedConfigSnapshot> {
  const call = Symbol('bash call')
  const files = new Map<string, { identity: CallIdentity; generation: number | undefined }>()
  const readOnlyFiles: string[] = []
  const reasons: string[] = []
  const refusals: string[] = []
  // A call that cannot be coordinated with host typeclaw commands gets the file
  // read-only, so it cannot leave a change no host writer or restart can see.
  const makeReadOnly = (destination: string, reason: string): void => {
    reasons.push(reason)
    const target = readOnlyTarget(destination)
    if ('path' in target) readOnlyFiles.push(target.path)
    else refusals.push(target.refuse)
  }
  try {
    for (const file of MANAGED_CONFIG_FILES) {
      const destination = path.join(path.resolve(agentDir), file)
      let opened: Awaited<ReturnType<typeof openConfigWindow>>
      try {
        opened = await openConfigWindow(destination, call, guard)
      } catch (error) {
        makeReadOnly(destination, `the ${file} check could not be prepared: ${errorMessage(error)}`)
        continue
      }
      files.set(destination, { identity: callIdentity(destination), generation: opened.generation })
      if (opened.uncoordinated !== undefined) makeReadOnly(destination, opened.uncoordinated)
    }
  } catch (error) {
    for (const destination of files.keys()) await closeConfigWindow(destination, call)
    throw error
  }
  if (refusals.length > 0) {
    // Rare and scoped to this one call: the file cannot be held read-only, and
    // running it unchecked could leave a change nothing can coordinate.
    for (const destination of files.keys()) await closeConfigWindow(destination, call)
    throw new Error(
      `[TypeClaw config guard] This command was not run: the agent could not coordinate config writes with host typeclaw commands (${reasons.join('; ')}), and ${refusals.join('; ')}. Retry the command once that is cleared.`,
    )
  }
  return { call, guard, files, ...(reasons.length > 0 ? { readOnly: { files: readOnlyFiles, reasons } } : {}) }
}

// Only a regular file at its fixed agent-root path can be held read-only: a
// read-only bind cannot stop a missing path from being created, or a symlink's
// directory entry from being replaced. It binds the path, not the inode, so the
// file must also have no other hard link that would keep its bytes writable.
function readOnlyTarget(destination: string): { path: string } | { refuse: string } {
  const name = path.basename(destination)
  let entry: Stats
  try {
    entry = lstatSync(destination)
  } catch {
    return { refuse: `${name} does not exist, so it cannot be made read-only for it` }
  }
  if (entry.isFile()) {
    return singleLinkOnOpen(destination, entry)
      ? { path: destination }
      : { refuse: `${name} has another hard link, so it cannot be made read-only for it` }
  }
  if (entry.isSymbolicLink()) return { refuse: `${name} is a symlink, so it cannot be made read-only for it` }
  return { refuse: `${name} is not a regular file, so it cannot be made read-only for it` }
}

function singleLinkOnOpen(destination: string, entry: Stats): boolean {
  if (entry.nlink !== 1) return false
  let fd: number
  try {
    fd = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return false
  }
  try {
    const opened = fstatSync(fd)
    return opened.isFile() && opened.nlink === 1 && opened.dev === entry.dev && opened.ino === entry.ino
  } finally {
    closeSync(fd)
  }
}

// Prepended to the result of a call that ran with the config files read-only.
export function readOnlyConfigNotice(snapshot: ManagedConfigSnapshot): string | undefined {
  if (snapshot.readOnly === undefined) return undefined
  return [
    `[TypeClaw config guard] typeclaw.json and cron.json were read-only for this command: the agent could not coordinate it with host typeclaw commands (${snapshot.readOnly.reasons.join('; ')}).`,
    'Any change this command tried to make to them failed. Retry it once that is cleared, or make the change with the write or edit tool.',
  ].join('\n')
}

// Model bash for roles that keep agent-root writes can rewrite typeclaw.json and
// cron.json directly, past the write/edit guards. bwrap runs every bash call
// with --die-with-parent in its own PID namespace, so each of its writes has
// landed by the time the call returns. A changed file is checked under the
// config lock, in the checked-write queue, against the newest authorized state
// (src/config/config-commits.ts), which only authorized writers can produce:
//
// - bytes equal to that state are left as they are. When an authorized writer
//   replaced a bash candidate during this call, the call is told its change to
//   the file was discarded;
// - anything else is a bash change: it runs as a `write` through this
//   session's guards, and through those of every other bash call in flight on
//   the file (a session with fewer permissions may own the change), against
//   the authorized bytes passed as their baseline, so the live file is never
//   rewritten to run them. A change every guard passes is recorded as the new
//   authorized commit. A blocked one is put back to the authorized state, in
//   place, only if the file still holds the checked bytes; if that fails, the
//   authorized view stays in force for runtime readers until the file is back.
//
// A symlinked path is followed, as loaders and the guards follow it, so a change
// to the file it names is caught too. A deleted file is left deleted: no guard
// evaluates a deletion. A directory or FIFO is never opened and is left alone.
// Returns one model-facing notice per reverted, discarded, or unrevertable file.
export async function recheckManagedConfigAfterBash(
  snapshot: ManagedConfigSnapshot,
  seams: RecheckSeams = {},
): Promise<string[]> {
  const notices: string[] = []
  try {
    for (const [destination, before] of snapshot.files) {
      // A window in recovery is re-checked even when this call left the file
      // alone, so a call that runs once the file is readable can verify it.
      if (sameCallIdentity(before.identity, callIdentity(destination)) && !configRecoveryPending(destination)) continue
      const notice = await recheckManagedEntry(destination, snapshot, before.generation, seams).catch(
        (error: unknown) =>
          `[TypeClaw config guard] Could not re-check ${path.basename(destination)} after this command: ${errorMessage(error)}`,
      )
      if (notice !== undefined) notices.push(notice)
    }
  } finally {
    for (const destination of snapshot.files.keys()) await closeConfigWindow(destination, snapshot.call)
  }
  return notices
}

async function recheckManagedEntry(
  destination: string,
  snapshot: ManagedConfigSnapshot,
  startGeneration: number | undefined,
  seams: RecheckSeams,
): Promise<string | undefined> {
  let locked = false
  const recheck = checkedWrites.then(() =>
    withConfigFileLock(destination, async () => {
      locked = true
      const live = readLiveEntry(destination)
      const { entry: trusted, commit, coordinated } = trustedConfigState(destination)
      if (sameConfigContent(live, trusted)) {
        setConfigRecovery(destination, false)
        const committedDuringCall =
          commit !== undefined && (startGeneration === undefined || commit.generation > startGeneration)
        return committedDuringCall && commit.superseded ? discardedNotice(path.basename(destination)) : undefined
      }
      if (live.kind === 'missing') {
        setTrustedConfigEntry(destination, live)
        return undefined
      }
      if (live.kind === 'other')
        return live.unreadable === true
          ? holdUnreadable(destination, producingGuards(destination, snapshot))
          : undefined
      const reason = await checkUnderEveryCall(destination, snapshot, live.bytes, contentOf(trusted))
      if (reason === undefined) {
        // Only bytes that are live are recorded: a writer that replaced them during
        // the check left bytes no check has seen.
        const now = readLiveEntry(destination)
        if (!sameConfigContent(now, live)) return holdReplaced(destination, now, producingGuards(destination, snapshot))
        recordConfigCommitSync(destination, live.bytes)
        return undefined
      }
      return revert(destination, live, trusted, reason, seams, coordinated, producingGuards(destination, snapshot))
    }),
  )
  checkedWrites = recheck.catch(() => {})
  try {
    return await recheck
  } catch (error) {
    // The lock file sits in the agent root, which this bash call could write, so
    // an unavailable lock must not leave an unchecked change in place.
    if (locked) throw error
    const live = readLiveEntry(destination)
    const { entry: trusted, coordinated } = trustedConfigState(destination)
    if (live.kind === 'other' && live.unreadable === true)
      return holdUnreadable(destination, producingGuards(destination, snapshot))
    if (sameConfigContent(live, trusted) || live.kind === 'missing' || live.kind === 'other') throw error
    return revert(
      destination,
      live,
      trusted,
      `the config file lock was unavailable, so the change could not be checked: ${errorMessage(error)}`,
      seams,
      coordinated,
      producingGuards(destination, snapshot),
    )
  }
}

// A change on a file several bash calls overlap on may belong to any of them,
// so it must pass this call's guards and those of every other call in flight.
async function checkUnderEveryCall(
  destination: string,
  snapshot: ManagedConfigSnapshot,
  candidate: Buffer,
  baseline: Buffer | undefined,
): Promise<string | undefined> {
  const run = (guard: ManagedConfigGuardCheck) =>
    runWithConfigBaseline(destination, baseline, () => guard(candidate.toString('utf8'), destination)).catch(
      (error: unknown) => `the config guard check failed: ${errorMessage(error)}`,
    )
  const own = await run(snapshot.guard)
  if (own !== undefined) return own
  for (const guard of concurrentCallGuards(destination, snapshot.call)) {
    if ((await run(guard)) !== undefined) {
      return 'a concurrent command from a session without permission to make this change was running, and config changes made while it runs must pass its checks too'
    }
  }
  // Bytes still unverified from an earlier call (left unreadable, or a failed
  // rollback) may be that call's change, so they must pass its checks too.
  for (const guard of configRecoveryGuards(destination)) {
    if ((await run(guard)) !== undefined) {
      return "the command that left this change ran in a session without permission to make it, and its change must pass that session's checks too"
    }
  }
  return undefined
}

// The calls whose bytes this check is about: this call and every other call in flight.
function producingGuards(destination: string, snapshot: ManagedConfigSnapshot): ManagedConfigGuardCheck[] {
  return [snapshot.guard, ...concurrentCallGuards(destination, snapshot.call)]
}

// A regular file whose bytes cannot be read (permissions, I/O) is not a FIFO: it
// may hold an unchecked change. The window stays in recovery, so readers keep
// the trusted bytes and its record stays published until a later check verifies
// the file or an authorized commit replaces it.
function holdUnreadable(destination: string, producers: readonly ManagedConfigGuardCheck[]): string {
  setConfigRecovery(destination, true, producers)
  const name = path.basename(destination)
  return `[TypeClaw config guard] ${name} could not be read after this command, so the agent keeps using the last checked ${name} until it is readable and checked again.`
}

// Bytes that replaced a checked change: a newer authorized commit stands, and
// anything else keeps the trusted view in recovery under the producing guards.
function holdReplaced(
  destination: string,
  now: ConfigFileEntry,
  producers: readonly ManagedConfigGuardCheck[],
): string {
  const name = path.basename(destination)
  if (sameConfigContent(now, trustedConfigState(destination).entry)) return discardedNotice(name)
  setConfigRecovery(destination, true, producers)
  return `[TypeClaw config guard] ${name} changed again while this command's change was checked, so it was left as it is now. Until a later check verifies it, the agent keeps using the last authorized ${name}, and that check also applies this command's checks.`
}

function readLiveEntry(
  destination: string,
  read: (path: string) => ConfigFileEntry = readConfigEntrySync,
): ConfigFileEntry {
  try {
    return read(destination)
  } catch {
    return { kind: 'other', id: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n }, unreadable: true }
  }
}

function discardedNotice(name: string): string {
  return [
    `[TypeClaw config guard] An authorized write committed ${name} during this command, so any change this command made to ${name} was discarded.`,
    `Redo that change with the write or edit tool, which checks ${name} before writing.`,
  ].join('\n')
}

function revert(
  destination: string,
  live: ConfigFileEntry,
  revertTo: ConfigFileEntry,
  reason: string,
  seams: RecheckSeams,
  coordinated: boolean,
  // The guards of the calls that left these bytes: a failed restore keeps them
  // with the recovery state so a later permissive call cannot approve the bytes.
  producers: readonly ManagedConfigGuardCheck[],
): string {
  const name = path.basename(destination)
  const uncoordinated = coordinated
    ? []
    : [
        `This command could not be coordinated with host typeclaw commands, so ${name} was checked against the last state the agent knew; a typeclaw command run on the host during this command may need to be run again.`,
      ]
  const now = readLiveEntry(destination, seams.readLive)
  if (now.kind === 'other' && now.unreadable === true) {
    // The rollback cannot tell what the file holds now: keep the trusted view.
    setConfigRecovery(destination, true, producers)
    return [
      `[TypeClaw config guard] The change this command made to ${name} was blocked:`,
      `blocked: ${reason}`,
      `${name} could not be read to revert it, so the agent keeps using the last checked ${name} until it is readable and checked again.`,
    ].join('\n')
  }
  if (!sameConfigContent(now, live)) {
    // Only a newer authorized commit is trusted as it stands. Any other change may
    // still carry the blocked content, so the window keeps the trusted bytes in
    // recovery and the next check also runs the guards of the calls that left it.
    if (sameConfigContent(now, trustedConfigState(destination).entry)) {
      return [
        `[TypeClaw config guard] The change this command made to ${name} was blocked:`,
        `blocked: ${reason}`,
        `${name} changed again before it could be reverted, so it was left as it is now; that change is checked on its own.`,
      ].join('\n')
    }
    setConfigRecovery(destination, true, producers)
    return [
      `[TypeClaw config guard] The change this command made to ${name} was blocked:`,
      `blocked: ${reason}`,
      `${name} changed again before it could be reverted, so it was left as it is now. Until a later check verifies it, the agent keeps using the last authorized ${name}, and that check also applies the checks this command failed.`,
    ].join('\n')
  }
  try {
    restoreConfigEntrySync(destination, now, revertTo, seams.writeInPlace)
  } catch (error) {
    noteConfigRollbackSync(destination)
    setConfigRecovery(destination, true, producers)
    return [
      `[TypeClaw config guard] The change this command made to ${name} was blocked:`,
      `blocked: ${reason}`,
      `${name} could not be restored to its state before this command (${errorMessage(error)}). It may still hold the blocked or partly written content; the agent keeps using the last authorized ${name} until it is fixed. Restore it with \`git checkout -- ${name}\` in the agent folder, then redo the allowed changes with the write or edit tool.`,
    ].join('\n')
  }
  noteConfigRollbackSync(destination)
  setConfigRecovery(destination, false)
  return [
    `[TypeClaw config guard] ${name} was reverted to its state before this command. The change this command made to it was blocked:`,
    `blocked: ${reason}`,
    `Every change this command made to ${name} was discarded, not only the blocked one. Redo the allowed changes with the write or edit tool, which check ${name} before writing; a guard that accepts an acknowledgement accepts it only there.`,
    ...uncoordinated,
  ].join('\n')
}

function callIdentity(destination: string): CallIdentity {
  return { link: statIdentity(destination, false), resolved: statIdentity(destination, true) }
}

function statIdentity(destination: string, follow: boolean): ConfigFileIdentity | undefined {
  try {
    return identityOf(follow ? statSync(destination, { bigint: true }) : lstatSync(destination, { bigint: true }))
  } catch {
    return undefined
  }
}

function sameCallIdentity(a: CallIdentity, b: CallIdentity): boolean {
  return sameIdentity(a.link, b.link) && sameIdentity(a.resolved, b.resolved)
}

function sameIdentity(a: ConfigFileIdentity | undefined, b: ConfigFileIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function writeOutputNoFollow(targetPath: string, content: string): Promise<void> {
  const trustedDescriptorPath = /^\/proc\/self\/fd\/\d+$/.test(targetPath)
  const flags = trustedDescriptorPath
    ? constants.O_WRONLY | constants.O_TRUNC
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const output = await open(targetPath, flags, 0o666)
  try {
    await output.writeFile(content, 'utf8')
  } finally {
    await output.close()
  }
}

export async function createAndOpenAnchoredDirectory(absolute: string, createMissing = true): Promise<FileHandle> {
  if (!path.isAbsolute(absolute)) throw new Error(`anchored directory must be absolute: ${absolute}`)
  const components = absolute.split(path.sep).filter(Boolean)
  let current = await open(path.parse(absolute).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const component of components) {
      const anchored = `/proc/self/fd/${current.fd}/${component}`
      let next: FileHandle
      try {
        next = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      } catch (error) {
        if (!isNotFoundError(error) || !createMissing) throw error
        await mkdir(anchored, { mode: 0o700 })
        next = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      }
      await current.close()
      current = next
    }
    return current
  } catch (error) {
    await current.close()
    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function streamSnapshot(
  source: FileHandle,
  destination: string,
  original: string,
  maxBytes: number,
  previouslyCopied: number,
  lease: BudgetLease,
  operandCount: number,
  signal?: AbortSignal,
): Promise<number> {
  let copied = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.byteLength
      if (copied > maxBytes) {
        callback(inputTooLarge(original, copied, maxBytes))
        return
      }
      if (previouslyCopied + copied > maxBytes) {
        callback(aggregateInputTooLarge(previouslyCopied + copied, maxBytes))
        return
      }
      if (!lease.resize(previouslyCopied + copied, operandCount)) {
        callback(processBudgetGrowthExceeded(previouslyCopied + copied))
        return
      }
      callback(null, chunk)
    },
  })
  // `autoClose: false` leaves the FileHandle to the caller, but the ReadStream
  // opens its OWN fd that `source.close()` never releases and GC never reclaims
  // — one leaked fd per snapshotted file, reaching EMFILE on a long-running
  // agent. Destroy the stream explicitly to free that fd deterministically.
  const readStream = source.createReadStream({ autoClose: false, start: 0 })
  try {
    await pipeline(
      readStream,
      limiter,
      createWriteStream(destination, {
        flags: 'wx',
        mode: 0o400,
      }),
      { signal },
    )
  } finally {
    readStream.destroy()
  }
  return copied
}

async function snapshotDirectoryTree(options: {
  source: VerifiedInput
  destination: string
  agentDir: string
  tool: string
  maxBytes: number
  previouslyCopied: number
  lease: BudgetLease
  operandCount: number
  hidden?: HiddenPaths
  signal?: AbortSignal
}): Promise<{ copied: number; omittedLinks: { count: number; names: string[] } }> {
  if (process.platform !== 'linux') {
    throw new Error('directory tool inputs require Linux inode anchoring; refusing an unanchored traversal')
  }
  const root = await open(options.source.resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await root.stat()
    if (opened.dev !== options.source.dev || opened.ino !== options.source.ino) {
      throw new Error(`tool input changed while waiting for snapshot capacity: ${options.source.original}`)
    }
    await mkdir(options.destination, { mode: 0o700 })
    const state = {
      copied: 0,
      entries: 0,
      omittedLinks: { count: 0, names: [] as string[] },
      mode: treeSnapshotMode(options.tool),
    }
    const identityVerifier = createPrivateSurfaceReadIdentityVerifier({
      tool: options.tool,
      agentDir: options.agentDir,
      hidden: options.hidden ?? { dirs: [], files: [] },
    })
    const openedRoot = await realpath(`/proc/self/fd/${root.fd}`)
    const realAgentDir = await realpath(options.agentDir)
    await snapshotOpenedDirectory(
      root,
      options.destination,
      options,
      state,
      identityVerifier,
      openedRoot === realAgentDir,
    )
    await chmod(options.destination, 0o500)
    return { copied: state.copied, omittedLinks: state.omittedLinks }
  } finally {
    await root.close()
  }
}

async function snapshotOpenedDirectory(
  directory: FileHandle,
  destination: string,
  options: Parameters<typeof snapshotDirectoryTree>[0],
  state: {
    copied: number
    entries: number
    omittedLinks: { count: number; names: string[] }
    mode: TreeSnapshotMode
  },
  identityVerifier: PrivateSurfaceIdentityVerifier,
  isAgentRoot: boolean,
): Promise<void> {
  const sourceRoot = `/proc/self/fd/${directory.fd}`
  const sourcePath = await realpath(sourceRoot)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (options.signal?.aborted === true) throw abortError(options.signal)
    if (isAgentRoot && AGENT_ROOT_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue
    state.entries += 1
    const maxEntries = state.mode === 'contents' ? TREE_SNAPSHOT_MAX_ENTRIES : TREE_NAMES_SNAPSHOT_MAX_ENTRIES
    if (state.entries > maxEntries) {
      throw new Error(
        `directory snapshot exceeds entry limit (${state.entries} > ${maxEntries}); retry with a narrower path`,
      )
    }
    const anchored = `${sourceRoot}/${entry.name}`
    const target = path.join(destination, entry.name)
    const candidate = path.join(sourcePath, entry.name)
    if (entry.isSymbolicLink()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      state.omittedLinks.count += 1
      if (state.omittedLinks.names.length < 12) {
        state.omittedLinks.names.push(path.relative(options.source.resolved, candidate))
      }
      continue
    }
    if (entry.isDirectory()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      const child = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const resolved = await realpath(`/proc/self/fd/${child.fd}`)
        if (isDeniedSnapshotPath(resolved, options)) continue
        await mkdir(target, { mode: 0o700 })
        // ls lists one level and only asks whether each entry is a directory.
        if (state.mode !== 'listing') {
          await snapshotOpenedDirectory(child, target, options, state, identityVerifier, false)
        }
        await chmod(target, 0o500)
      } finally {
        await child.close()
      }
      continue
    }
    if (!entry.isFile()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      throw new Error(`directory snapshot refuses non-regular entry: ${entry.name}`)
    }
    const source = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await source.stat()
      assertRegularInputFile(opened, candidate)
      enforceInputIdentityDenial(identityVerifier, opened)
      const resolved = await realpath(`/proc/self/fd/${source.fd}`)
      if (isDeniedSnapshotPath(resolved, options)) continue
      if (await snapshotsAsPlaceholder(source, candidate, state.mode)) {
        await writeFile(target, '', { flag: 'wx', mode: 0o400 })
        continue
      }
      state.copied += await streamSnapshot(
        source,
        target,
        resolved,
        options.maxBytes,
        options.previouslyCopied + state.copied,
        options.lease,
        options.operandCount,
        options.signal,
      )
      await chmod(target, 0o400)
    } finally {
      await source.close()
    }
  }
}

// contents: grep reads file bodies. names: find needs the tree plus ignore
// files. listing: ls needs one level of names and directory-ness.
type TreeSnapshotMode = 'contents' | 'names' | 'listing'

function treeSnapshotMode(tool: string): TreeSnapshotMode {
  if (tool === 'ls') return 'listing'
  if (tool === 'find') return 'names'
  return 'contents'
}

async function snapshotsAsPlaceholder(source: FileHandle, candidate: string, mode: TreeSnapshotMode): Promise<boolean> {
  if (mode === 'listing') return true
  if (mode === 'names') return !isFindIgnoreFile(candidate)
  const head = Buffer.alloc(BINARY_SNIFF_BYTES)
  const { bytesRead } = await source.read(head, 0, BINARY_SNIFF_BYTES, 0)
  const sniffed = head.subarray(0, bytesRead)
  if (hasUtf16Bom(sniffed)) return false
  return sniffed.includes(0)
}

function isFindIgnoreFile(candidate: string): boolean {
  if (FIND_IGNORE_FILE_NAMES.has(path.basename(candidate))) return true
  const parent = path.dirname(candidate)
  return (
    path.basename(candidate) === 'exclude' &&
    path.basename(parent) === 'info' &&
    path.basename(path.dirname(parent)) === '.git'
  )
}

function hasUtf16Bom(head: Buffer): boolean {
  return head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
}

function assertRegularInputFile(stats: Stats, original: string): void {
  if (!stats.isFile()) throw new Error(`tool input changed to a non-regular file before snapshot: ${original}`)
}

function maxInputBytes(tool: string): number {
  if (tool === 'look_at') return TOOL_INPUT_MAX_BYTES.look_at
  if (tool === 'channel_send' || tool === 'channel_reply') return TOOL_INPUT_MAX_BYTES.channel_upload
  return TOOL_INPUT_MAX_BYTES.read
}

function maxInputCount(tool: string): number {
  if (tool === 'look_at') return TOOL_INPUT_MAX_COUNT.look_at
  if (tool === 'channel_send' || tool === 'channel_reply') return TOOL_INPUT_MAX_COUNT.channel_upload
  return TOOL_INPUT_MAX_COUNT.read
}

function isOutputTool(tool: string): boolean {
  return tool === 'write' || tool === 'edit'
}

function isTreeInputTool(tool: string): boolean {
  return tool === 'grep' || tool === 'find' || tool === 'ls'
}

function isAmbiguousUndeclaredLocalOperand(value: string, agentDir: string, key: string): boolean {
  // Filesystem reality wins over semantic spelling: an existing entry named
  // like a repository slug, date, URL, or package coordinate is still a local
  // operand and must be declared so it is authorized and pinned.
  const resolved = path.resolve(agentDir, value)
  try {
    lstatSync(resolved)
    return true
  } catch (error) {
    if (!isNotFoundError(error)) return true
  }

  const basename = path.posix.basename(value.replaceAll('\\', '/'))
  if (CANONICAL_AGENT_SECRET_FILES.includes(basename as (typeof CANONICAL_AGENT_SECRET_FILES)[number])) return true

  if (isFileShapedKey(key)) return !(normalizedKey(key) === 'path' && isSafeApiRoute(value))
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value)) return true
  if (value.startsWith('./') || value.startsWith('../')) return true
  if (isSemanticGenericString(key, value)) return false
  if (/[\\/]/.test(value)) return true
  if (/^[^./\\\s][^/\\\s]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return true
  return false
}

function isFileShapedKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return (
    normalized === 'path' ||
    normalized === 'file' ||
    normalized === 'filepath' ||
    normalized === 'filename' ||
    normalized.endsWith('path') ||
    normalized.endsWith('filepath') ||
    normalized.endsWith('filename')
  )
}

function normalizedKey(key: string): string {
  return key.replaceAll(/[-_]/g, '').toLocaleLowerCase()
}

function isSemanticGenericString(key: string, value: string): boolean {
  if (isExplicitNonFileUrl(value)) return true
  const normalized = normalizedKey(key)
  if (
    (normalized === 'repository' || normalized === 'repositoryslug' || normalized === 'reposlug') &&
    isSafeRepositorySlug(value)
  ) {
    return true
  }
  if ((normalized === 'date' || normalized === 'fraction') && isSafeNumericDateOrFraction(value)) return true
  return isPackageCoordinateKey(normalized) && isSafePackageCoordinate(value)
}

function isExplicitNonFileUrl(value: string): boolean {
  const trimmed = value.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.toLocaleLowerCase().startsWith('file:')) return false
  try {
    return new URL(trimmed).protocol !== 'file:'
  } catch {
    return false
  }
}

function isSafeApiRoute(value: string): boolean {
  if (!/^\/v\d+\//.test(value) || value.includes('\\') || value.includes('//')) return false
  for (const segment of value.split('/').slice(1)) {
    if (segment.length === 0) return false
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return false
  }
  return true
}

function isSafeRepositorySlug(value: string): boolean {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)$/.exec(
    value,
  )
  return match !== null && match[1] !== '.' && match[1] !== '..' && match[2] !== '.' && match[2] !== '..'
}

function isSafeNumericDateOrFraction(value: string): boolean {
  return /^\d{1,4}([/-])\d{1,2}(?:\1\d{1,4})?$/.test(value)
}

function isPackageCoordinateKey(normalized: string): boolean {
  return (
    normalized === 'package' ||
    normalized === 'packagename' ||
    normalized === 'packagespec' ||
    normalized === 'packagecoordinate'
  )
}

function isSafePackageCoordinate(value: string): boolean {
  if (/^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:@[^\s/]+)?$/.test(value)) return true
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*@[^\s/@]+$/.test(value)) return true
  if (/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.+-]+){0,3}$/.test(value)) return true
  if (/^(?:[A-Za-z_][A-Za-z0-9_-]*\.)+[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) return true
  const segments = value.split('/')
  return segments.length > 1 && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
}

function warnForUndeclaredExistingLocalOperand(
  logger: Pick<ToolLogger, 'warn'> | undefined,
  tool: string,
  operandPath: string,
  value: string,
  agentDir: string,
): void {
  if (logger === undefined) return
  try {
    lstatSync(path.resolve(agentDir, value))
  } catch {
    return
  }
  try {
    logger.warn(
      `[tool-file-safety] ${tool} received an undeclared existing local operand at ${JSON.stringify(operandPath)}; declare fileOperands.input to authorize immutable snapshotting`,
    )
  } catch {
    // Diagnostics must never change authorization behavior.
  }
}

function enforceInputIdentityDenial(
  verifier: PrivateSurfaceIdentityVerifier,
  identity: Pick<Stats, 'dev' | 'ino' | 'nlink'>,
): void {
  const blocked = verifier.check(identity)
  if (blocked !== undefined) throw new Error(`blocked: ${blocked.reason}`)
}

function isDeniedSnapshotPath(
  candidate: string,
  options: { agentDir: string; tool: string; hidden?: HiddenPaths },
): boolean {
  return (
    checkPrivateSurfaceReadGuard({
      tool: options.tool,
      args: { path: candidate },
      agentDir: options.agentDir,
      hidden: options.hidden ?? { dirs: [], files: [] },
    }) !== undefined
  )
}

function inputTooLarge(original: string, size: number, maxBytes: number): Error {
  return new Error(`tool input is too large: ${original} (${size} bytes > ${maxBytes} byte limit)`)
}

function aggregateInputTooLarge(size: number, maxBytes: number): Error {
  return new Error(`tool inputs exceed the aggregate byte limit (${size} bytes > ${maxBytes} byte limit)`)
}

function processBudgetGrowthExceeded(size: number): Error {
  return new Error(`tool snapshot growth exceeds the process-wide pinned byte budget (${size} bytes requested)`)
}

function inputCountTooLarge(count: number, maxCount: number): Error {
  return new Error(`tool input count exceeds the per-invocation limit (${count} > ${maxCount})`)
}

function outputCountTooLarge(count: number, maxCount: number): Error {
  return new Error(`tool output count exceeds the per-invocation limit (${count} > ${maxCount})`)
}

function appendSnapshotOmissions(
  result: ToolResult,
  omissions: readonly { root: string; count: number; names: string[] }[],
): ToolResult {
  if (omissions.length === 0) return result
  const notes = omissions.map(({ root, count, names }) => {
    const remainder = count - names.length
    return `Directory snapshot omitted ${count} symbolic link${count === 1 ? '' : 's'} under ${JSON.stringify(root)} (not followed): ${names.map((name) => JSON.stringify(name)).join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}.`
  })
  return { ...result, content: [...result.content, { type: 'text', text: notes.join('\n') }] }
}

function replaceResultPath(result: ToolResult, rewrite: Rewrite): ToolResult {
  const content = result.content.map((part) =>
    part.type === 'text' ? { ...part, text: part.text.split(rewrite.pinned).join(rewrite.original) } : part,
  )
  const details = replaceDeep(result.details, rewrite)
  return { content, details }
}

function replaceDeep(value: unknown, rewrite: Rewrite): unknown {
  if (typeof value === 'string') return value.split(rewrite.pinned).join(rewrite.original)
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, rewrite))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, rewrite)]))
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

type BudgetRequest = {
  bytes: number
  count: number
  signal?: AbortSignal
  resolve(lease: BudgetLease): void
  reject(error: Error): void
  onAbort?: () => void
}

type BudgetLease = {
  resize(bytes: number, count: number): boolean
  release(): void
}

class PinnedSnapshotBudget {
  private bytes = 0
  private count = 0
  private readonly queue: BudgetRequest[] = []

  constructor(
    private readonly limits: { maxBytes: number; maxCount: number; maxWaiters: number },
    private readonly onWait?: () => void,
  ) {}

  async acquire(bytes: number, count: number, signal?: AbortSignal): Promise<BudgetLease> {
    if (bytes > this.limits.maxBytes || count > this.limits.maxCount) {
      throw new Error('tool inputs exceed the process-wide pinned snapshot budget')
    }
    if (signal?.aborted === true) throw abortError(signal)
    if (this.queue.length >= this.limits.maxWaiters) {
      throw new Error(`pinned snapshot waiter queue is full (${this.limits.maxWaiters} waiters)`)
    }
    return await new Promise<BudgetLease>((resolve, reject) => {
      const request: BudgetRequest = { bytes, count, signal, resolve, reject }
      const waits =
        this.queue.length > 0 ||
        this.bytes + request.bytes > this.limits.maxBytes ||
        this.count + request.count > this.limits.maxCount
      if (waits) this.onWait?.()
      if (signal !== undefined) {
        request.onAbort = () => {
          const index = this.queue.indexOf(request)
          if (index === -1) return
          this.queue.splice(index, 1)
          reject(abortError(signal))
          this.drain()
        }
        signal.addEventListener('abort', request.onAbort, { once: true })
      }
      this.queue.push(request)
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0] as BudgetRequest
      if (this.bytes + next.bytes > this.limits.maxBytes || this.count + next.count > this.limits.maxCount) {
        return
      }
      this.queue.shift()
      if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort)
      this.bytes += next.bytes
      this.count += next.count
      let released = false
      let leasedBytes = next.bytes
      let leasedCount = next.count
      next.resolve({
        resize: (bytes, count) => {
          if (released) return false
          const byteDelta = bytes - leasedBytes
          const countDelta = count - leasedCount
          if (this.bytes + byteDelta > this.limits.maxBytes || this.count + countDelta > this.limits.maxCount) {
            return false
          }
          this.bytes += byteDelta
          this.count += countDelta
          leasedBytes = bytes
          leasedCount = count
          this.drain()
          return true
        },
        release: () => {
          if (released) return
          released = true
          this.bytes -= leasedBytes
          this.count -= leasedCount
          this.drain()
        },
      })
    }
  }
}

export function createPinnedSnapshotBudgetForTests(options: {
  maxBytes: number
  maxCount: number
  maxWaiters: number
  onWait?: () => void
}) {
  const { onWait, ...limits } = options
  return new PinnedSnapshotBudget(limits, onWait)
}

const pinnedSnapshotBudget = new PinnedSnapshotBudget({
  maxBytes: PINNED_SNAPSHOT_GLOBAL_MAX_BYTES,
  maxCount: PINNED_SNAPSHOT_GLOBAL_MAX_COUNT,
  maxWaiters: PINNED_SNAPSHOT_MAX_WAITERS,
})

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  return new Error(`pinned snapshot wait aborted${reason === undefined ? '' : `: ${String(reason)}`}`)
}
