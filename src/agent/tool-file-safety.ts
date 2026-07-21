import { constants, createWriteStream, lstatSync, type Stats } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rm, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkPrivateSurfaceReadGuard } from '@/bundled-plugins/security/policies/private-surface-read'
import { config, DEFAULT_MODEL_TOOL_LIMITS } from '@/config'
import type { ToolFileOperands, ToolResult } from '@/plugin'
import { CANONICAL_AGENT_SECRET_FILES } from '@/sandbox/canonical-secrets'
import type { HiddenPaths } from '@/sandbox/hidden-paths'

import { processResourceBudget, type ResourceLease } from './resource-budget'
import { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS } from './tools-without-local-file-operands'

export { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS }

type Rewrite = { original: string; pinned: string }
type FileTarget = { get(): string; original: string; set(value: string): void; uri: boolean }
type VerifiedInput = {
  target: FileTarget
  original: string
  resolved: string
  dev: number
  ino: number
  size: number
  kind: 'file' | 'directory'
}

export type ToolInputByteLimits = {
  read: number
  look_at: number
  channel_upload: number
}

export const DEFAULT_TOOL_INPUT_MAX_BYTES = {
  // read supports offset/limit browsing, so permit large source files while
  // bounding the immutable whole-object snapshot.
  read: DEFAULT_MODEL_TOOL_LIMITS.readSnapshotMaxBytes,
  // Keep local images on the same budget as look_at's bounded URL fetch.
  look_at: DEFAULT_MODEL_TOOL_LIMITS.lookAtImageMaxBytes,
  // Preserve common channel upload sizes without allowing unbounded copies.
  channel_upload: DEFAULT_MODEL_TOOL_LIMITS.channelAttachmentMaxBytes,
} as const satisfies ToolInputByteLimits

export const DEFAULT_TOOL_INPUT_MAX_COUNT = {
  read: 1,
  look_at: DEFAULT_MODEL_TOOL_LIMITS.lookAtMaxImages,
  channel_upload: 32,
} as const

export const DEFAULT_PINNED_SNAPSHOT_MAX_BYTES = DEFAULT_TOOL_INPUT_MAX_BYTES.channel_upload
export const DEFAULT_PINNED_SNAPSHOT_MAX_COUNT = DEFAULT_TOOL_INPUT_MAX_COUNT.channel_upload
const TREE_SNAPSHOT_MAX_ENTRIES = 4096
const AGENT_ROOT_SNAPSHOT_EXCLUDED_DIRS = new Set(['.git', '.gitstore', 'node_modules'])

export const TOOL_INPUT_TEMP_PREFIX = 'typeclaw-tool-input-'

export type PinnedToolFiles = {
  restoreResult(result: ToolResult): ToolResult
  cleanup(): Promise<void>
}

// Test-only seam: pauses between budget acquisition and source open/stream so a
// test can grow a file post-authorization deterministically, without racing the
// scheduler. Production never passes hooks.
export type EnforceAndPinToolFilesHooks = {
  afterBudgetAcquire?(): void | Promise<void>
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
    signal?: AbortSignal
    limits?: ToolInputByteLimits
  },
  hooks: EnforceAndPinToolFilesHooks = {},
): Promise<PinnedToolFiles> {
  if (options.signal?.aborted === true) throw abortError(options.signal)
  const inputLimits = resolveInputLimits(options.tool, options.limits)
  const maxCount = inputLimits.maxCount
  const targets = fileTargets(
    options.tool,
    options.args,
    maxCount,
    options.genericInputs === true,
    options.fileOperands,
    options.agentDir,
  )
  enforceCanonicalSecretDenial(options)
  const outputs = outputTargets(options.tool, options.args, maxCount, options.fileOperands)
  if (outputs.length > 0) return await pinOutputTargets(options, outputs)
  if (targets.length === 0) return noPinnedFiles()

  let dir: string | undefined
  const rewrites: Rewrite[] = []
  const verified: VerifiedInput[] = []
  const maxBytes = inputLimits.maxBytes
  const maxTotalBytes = inputLimits.maxTotalBytes
  let lease: ResourceLease | undefined
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
      if (kind === 'file') assertSingleLinkRegularFile(inspected, original)
      if (kind === 'file' && inspected.size > maxBytes) throw inputTooLarge(original, inspected.size, maxBytes)
      declaredBytes += kind === 'file' ? inspected.size : 0
      if (declaredBytes > maxTotalBytes) throw aggregateInputTooLarge(declaredBytes, maxTotalBytes)
      verified.push({ target, original, resolved, dev: inspected.dev, ino: inspected.ino, size: inspected.size, kind })
    }

    lease = await processResourceBudget.acquire(
      { pinnedBytes: declaredBytes, pinnedCount: verified.length },
      options.signal,
    )
    await hooks.afterBudgetAcquire?.()

    dir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), TOOL_INPUT_TEMP_PREFIX))
    let copiedBytes = 0
    for (let i = 0; i < verified.length; i++) {
      const input = verified[i] as VerifiedInput
      const pinned = path.join(dir, String(i))
      if (input.kind === 'file') {
        const source = await openInput(input.resolved, input.original)
        try {
          const opened = await source.stat()
          assertSingleLinkRegularFile(opened, input.original)
          if (opened.dev !== input.dev || opened.ino !== input.ino) {
            throw new Error(`tool input changed while waiting for snapshot capacity: ${input.original}`)
          }
          copiedBytes += await streamSnapshot(
            source,
            pinned,
            input.original,
            maxBytes,
            maxTotalBytes,
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
        copiedBytes += await snapshotDirectoryTree({
          source: input,
          destination: pinned,
          agentDir: options.agentDir,
          tool: options.tool,
          maxBytes,
          maxTotalBytes,
          previouslyCopied: copiedBytes,
          lease,
          operandCount: verified.length,
          hidden: options.hidden,
          signal: options.signal,
        })
      }
      const executionValue = input.target.uri ? pathToFileURL(pinned).href : pinned
      input.target.set(executionValue)
      rewrites.push({ original: input.target.original, pinned: executionValue })
    }
    if (!lease.tryResize({ pinnedBytes: copiedBytes, pinnedCount: verified.length })) {
      throw processBudgetGrowthExceeded(copiedBytes)
    }
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

  return {
    restoreResult(result) {
      let restored = result
      for (const rewrite of rewrites) restored = replaceResultPath(restored, rewrite)
      return restored
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

export function enforceCanonicalSecretDenial(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): void {
  const blocked = checkPrivateSurfaceReadGuard({ ...options, hidden: { dirs: [], files: [] } })
  if (blocked !== undefined) throw new Error(`blocked: ${blocked.reason}`)
}

function fileTargets(
  tool: string,
  args: Record<string, unknown>,
  maxCount: number,
  genericInputs: boolean,
  fileOperands: ToolFileOperands | undefined,
  agentDir: string,
): FileTarget[] {
  if (isOutputTool(tool)) return []
  if (TOOLS_WITHOUT_LOCAL_FILE_OPERANDS.has(tool)) return []
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
  if (genericInputs) collectGenericFileTargets(tool, args, targets, maxCount, fileOperands, agentDir)
  return targets
}

// Exact tool + operand-path pairs for first-party PROSE operands (message
// bodies, prompts, queries, regex/CSS/jq strings) that are never a local file.
// This table is for tools that ALSO have a real file operand and so cannot be
// whole-tool exempt via TOOLS_WITHOUT_LOCAL_FILE_OPERANDS: web_fetch pins its
// `url` (a file: URI there still snapshots) while `query`/`selector`/`pattern`
// are prose. Pure control-token tools (reload, grant_role, stream_snapshot,
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
  web_fetch: new Set(['query', 'selector', 'pattern']),
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
): FileTarget[] {
  if (isOutputTool(tool)) return typeof args.path === 'string' ? [propertyTarget(args, 'path')] : []
  if (operands?.output === undefined || operands.output.length === 0) return []
  const targets: FileTarget[] = []
  collectDeclaredOutputTargets(args, targets, maxCount, new Set(operands.output))
  return targets
}

function collectDeclaredOutputTargets(
  value: unknown,
  out: FileTarget[],
  maxCount: number,
  declared: ReadonlySet<string>,
  parentPath = '',
): void {
  if (Array.isArray(value)) {
    const declaredOutput = declared.has(parentPath)
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (declaredOutput) {
          out.push(arrayTarget(value, index))
          if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        }
        continue
      }
      collectDeclaredOutputTargets(item, out, maxCount, declared, parentPath)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [childKey, item] of Object.entries(value)) {
    const operandPath = parentPath === '' ? childKey : `${parentPath}.${childKey}`
    if (typeof item === 'string' && declared.has(operandPath)) {
      out.push(propertyTarget(value, childKey))
      if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
      continue
    }
    collectDeclaredOutputTargets(item, out, maxCount, declared, operandPath)
  }
}

function collectGenericFileTargets(
  tool: string,
  value: unknown,
  out: FileTarget[],
  maxCount: number,
  operands: ToolFileOperands | undefined,
  agentDir: string,
  parentPath = '',
): void {
  if (Array.isArray(value)) {
    const declaredInput = operands?.input?.includes(parentPath) === true
    const nonInput =
      operands?.output?.includes(parentPath) === true || operands?.destructive?.includes(parentPath) === true
    const key = parentPath.split('.').at(-1) ?? parentPath
    // Precedence: declared input pins; declared output/destructive is not an
    // input; a known non-file operand is opaque (skipped, even a file: URI);
    // otherwise an explicit file: URI pins and an undeclared path-shaped value
    // fails closed. Both the static first-party table and a plugin's declared
    // `fileOperands.nonFile` are tool+operand-path scoped, so an unknown tool
    // never inherits an exemption from a common key name.
    const knownNonFile =
      !declaredInput && (operands?.nonFile?.includes(parentPath) === true || isKnownNonFileOperand(tool, parentPath))
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (knownNonFile) continue
        if (!nonInput && (isFileUri(item) || declaredInput)) {
          out.push(arrayTarget(value, index))
          if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        } else if (
          !nonInput &&
          !isSemanticGenericString(key, item) &&
          isAmbiguousUndeclaredLocalOperand(item, agentDir, key)
        ) {
          throw new Error(
            `ambiguous local file operand at key ${JSON.stringify(parentPath)}; the tool author must declare fileOperands.input or the caller must use a file: URI`,
          )
        }
        continue
      }
      collectGenericFileTargets(tool, item, out, maxCount, operands, agentDir, parentPath)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [childKey, item] of Object.entries(value)) {
    const operandPath = parentPath === '' ? childKey : `${parentPath}.${childKey}`
    if (typeof item === 'string') {
      const declaredInput = operands?.input?.includes(operandPath) === true
      const nonInput =
        operands?.output?.includes(operandPath) === true || operands?.destructive?.includes(operandPath) === true
      // Declared input wins; a known non-file operand (web_search.query,
      // web_fetch.selector, a plugin's declared `fileOperands.nonFile`, …) is
      // opaque and skipped even when its value is a file: URI; everything else
      // falls to the file:/heuristic scan below. Scoped by exact tool+operand-
      // path so an undeclared plugin reader using `content`/`prompt` still
      // fails closed.
      if (
        !declaredInput &&
        (operands?.nonFile?.includes(operandPath) === true || isKnownNonFileOperand(tool, operandPath))
      ) {
        continue
      }
      if (!nonInput && (isFileUri(item) || declaredInput)) {
        out.push(propertyTarget(value, childKey))
        if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        continue
      }
      if (
        !nonInput &&
        !isSemanticGenericString(childKey, item) &&
        isAmbiguousUndeclaredLocalOperand(item, agentDir, childKey)
      ) {
        throw new Error(
          `ambiguous local file operand at key ${JSON.stringify(operandPath)}; the tool author must declare fileOperands.input or the caller must use a file: URI`,
        )
      }
    }
    collectGenericFileTargets(tool, item, out, maxCount, operands, agentDir, operandPath)
  }
}

function noPinnedFiles(): PinnedToolFiles {
  return { restoreResult: (result) => result, cleanup: async () => {} }
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
  targets: FileTarget[],
): Promise<PinnedToolFiles> {
  const pinned: PinnedToolFiles[] = []
  try {
    for (const target of targets) pinned.push(await pinOutputTarget(options, target))
  } catch (error) {
    await Promise.allSettled([...pinned].reverse().map(async (entry) => await entry.cleanup()))
    throw error
  }
  return {
    restoreResult(result) {
      return pinned.reduce((restored, entry) => entry.restoreResult(restored), result)
    },
    async cleanup() {
      const outcomes = await Promise.allSettled([...pinned].reverse().map(async (entry) => await entry.cleanup()))
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
}

async function pinOutputTarget(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    signal?: AbortSignal
  },
  target: FileTarget,
): Promise<PinnedToolFiles> {
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
  try {
    const fdRoot = '/proc/self/fd'
    const resolvedParent = await realpath(`${fdRoot}/${directory.fd}`)
    enforceCanonicalSecretDenial({
      tool: options.tool,
      args: { path: path.join(resolvedParent, basename) },
      agentDir: options.agentDir,
    })
    const anchored = `${fdRoot}/${directory.fd}/${basename}`
    targetHandle = await open(anchored, constants.O_RDWR | noFollow).catch((error) => {
      if (isNotFoundError(error)) return undefined
      throw error
    })
    let executionPath = anchored
    if (targetHandle !== undefined) {
      const inspected = await targetHandle.stat()
      if (!inspected.isFile() || inspected.nlink !== 1) {
        throw new Error(`write/edit output is not a single-link regular file: ${original}`)
      }
      targetIdentity = { dev: inspected.dev, ino: inspected.ino }
      const resolved = await realpath(`${fdRoot}/${targetHandle.fd}`)
      enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
      executionPath = `${fdRoot}/${targetHandle.fd}`
    }
    target.set(executionPath)
    let cleaned = false
    return {
      restoreResult(result) {
        return replaceResultPath(result, { original, pinned: executionPath })
      },
      async cleanup() {
        if (cleaned) return
        cleaned = true
        let verified: FileHandle | undefined
        let verifyError: unknown
        try {
          verified = await open(anchored, constants.O_RDONLY | noFollow)
          const inspected = await verified.stat()
          if (!inspected.isFile() || inspected.nlink !== 1) {
            throw new Error(`write/edit output is not a single-link regular file: ${original}`)
          }
          if (
            targetIdentity !== undefined &&
            (inspected.dev !== targetIdentity.dev || inspected.ino !== targetIdentity.ino)
          ) {
            throw new Error(`write/edit output destination changed during execution: ${original}`)
          }
          const resolved = await realpath(`${fdRoot}/${verified.fd}`)
          enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
        } catch (error) {
          if (!(targetIdentity === undefined && isNotFoundError(error))) verifyError = error
        }
        const outcomes = await Promise.allSettled([verified?.close(), targetHandle?.close(), directory.close()])
        const failed = outcomes.find((outcome) => outcome.status === 'rejected')
        if (verifyError !== undefined) throw verifyError
        if (failed?.status === 'rejected') throw failed.reason
      },
    }
  } catch (error) {
    await Promise.allSettled([targetHandle?.close(), directory.close()])
    throw error
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

export async function writeToolOutputNoFollow(targetPath: string, content: string): Promise<void> {
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

async function createAndOpenAnchoredDirectory(absolute: string): Promise<FileHandle> {
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
        if (!isNotFoundError(error)) throw error
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
  maxTotalBytes: number,
  previouslyCopied: number,
  lease: ResourceLease,
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
      if (previouslyCopied + copied > maxTotalBytes) {
        callback(aggregateInputTooLarge(previouslyCopied + copied, maxTotalBytes))
        return
      }
      if (!lease.tryResize({ pinnedBytes: previouslyCopied + copied, pinnedCount: operandCount })) {
        callback(processBudgetGrowthExceeded(previouslyCopied + copied))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(
    source.createReadStream({ autoClose: false, start: 0 }),
    limiter,
    createWriteStream(destination, {
      flags: 'wx',
      mode: 0o400,
    }),
    { signal },
  )
  return copied
}

async function snapshotDirectoryTree(options: {
  source: VerifiedInput
  destination: string
  agentDir: string
  tool: string
  maxBytes: number
  maxTotalBytes: number
  previouslyCopied: number
  lease: ResourceLease
  operandCount: number
  hidden?: HiddenPaths
  signal?: AbortSignal
}): Promise<number> {
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
    const state = { copied: 0, entries: 0 }
    const openedRoot = await realpath(`/proc/self/fd/${root.fd}`)
    const realAgentDir = await realpath(options.agentDir)
    await snapshotOpenedDirectory(root, options.destination, options, state, openedRoot === realAgentDir)
    await chmod(options.destination, 0o500)
    return state.copied
  } finally {
    await root.close()
  }
}

async function snapshotOpenedDirectory(
  directory: FileHandle,
  destination: string,
  options: Parameters<typeof snapshotDirectoryTree>[0],
  state: { copied: number; entries: number },
  isAgentRoot: boolean,
): Promise<void> {
  const sourceRoot = `/proc/self/fd/${directory.fd}`
  const sourcePath = await realpath(sourceRoot)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (options.signal?.aborted === true) throw abortError(options.signal)
    if (isAgentRoot && AGENT_ROOT_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue
    state.entries += 1
    if (state.entries > TREE_SNAPSHOT_MAX_ENTRIES) {
      throw new Error(`directory snapshot exceeds entry limit (${state.entries} > ${TREE_SNAPSHOT_MAX_ENTRIES})`)
    }
    const anchored = `${sourceRoot}/${entry.name}`
    const target = path.join(destination, entry.name)
    const candidate = path.join(sourcePath, entry.name)
    if (entry.isSymbolicLink()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      throw new Error(`directory snapshot refuses symbolic link: ${entry.name}`)
    }
    if (entry.isDirectory()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      const child = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const resolved = await realpath(`/proc/self/fd/${child.fd}`)
        if (isDeniedSnapshotPath(resolved, options)) continue
        await mkdir(target, { mode: 0o700 })
        await snapshotOpenedDirectory(child, target, options, state, false)
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
      assertSingleLinkRegularFile(opened, candidate)
      const resolved = await realpath(`/proc/self/fd/${source.fd}`)
      if (isDeniedSnapshotPath(resolved, options)) continue
      state.copied += await streamSnapshot(
        source,
        target,
        resolved,
        options.maxBytes,
        options.maxTotalBytes,
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

function assertSingleLinkRegularFile(stats: Stats, original: string): void {
  if (!stats.isFile()) throw new Error(`tool input changed to a non-regular file before snapshot: ${original}`)
  if (stats.nlink !== 1) {
    throw new Error(
      `tool input has ${stats.nlink} hard links and cannot be snapshotted safely; copy it to a unique regular file before retrying: ${original}`,
    )
  }
}

function resolveInputLimits(
  tool: string,
  override?: ToolInputByteLimits,
): { maxBytes: number; maxTotalBytes: number; maxCount: number } {
  if (tool === 'look_at') {
    const maxBytes = override?.look_at ?? config.modelTools.limits.lookAtImageMaxBytes
    return {
      maxBytes,
      maxTotalBytes: override?.look_at ?? config.modelTools.limits.lookAtTotalMaxBytes,
      maxCount: config.modelTools.limits.lookAtMaxImages,
    }
  }
  if (tool === 'channel_send' || tool === 'channel_reply') {
    const maxBytes = override?.channel_upload ?? config.modelTools.limits.channelAttachmentMaxBytes
    return { maxBytes, maxTotalBytes: maxBytes, maxCount: DEFAULT_TOOL_INPUT_MAX_COUNT.channel_upload }
  }
  const maxBytes = override?.read ?? config.modelTools.limits.readSnapshotMaxBytes
  return { maxBytes, maxTotalBytes: maxBytes, maxCount: DEFAULT_TOOL_INPUT_MAX_COUNT.read }
}

function isOutputTool(tool: string): boolean {
  return tool === 'write' || tool === 'edit'
}

function isTreeInputTool(tool: string): boolean {
  return tool === 'grep' || tool === 'find' || tool === 'ls'
}

function isAmbiguousUndeclaredLocalOperand(value: string, agentDir: string, key: string): boolean {
  if (isFileShapedKey(key)) return true
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value)) return true
  if (value.startsWith('./') || value.startsWith('../')) return true
  if (/[\\/]/.test(value)) return true
  const basename = path.posix.basename(value.replaceAll('\\', '/'))
  if (CANONICAL_AGENT_SECRET_FILES.includes(basename as (typeof CANONICAL_AGENT_SECRET_FILES)[number])) return true
  if (/^[^./\\\s][^/\\\s]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return true

  const resolved = path.resolve(agentDir, value)
  try {
    lstatSync(resolved)
    return true
  } catch (error) {
    return !isNotFoundError(error)
  }
}

function isFileShapedKey(key: string): boolean {
  const normalized = key.replaceAll(/[-_]/g, '').toLocaleLowerCase()
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

function isSemanticGenericString(key: string, value: string): boolean {
  if (isExplicitNonFileUrl(value)) return true
  if (key === 'path' && isSafeApiRoute(value)) return true
  return key === 'repository' && isSafeRepositorySlug(value)
}

function isExplicitNonFileUrl(value: string): boolean {
  // Trim to match the file:/URL detection elsewhere: a leading-whitespace
  // "  https://…" is still a non-file URL, and a "  file://…" must NOT be
  // treated as one (it pins). Windows-drive and file: exclusions run on trimmed.
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
  const segments = value.split('/')
  for (const segment of segments.slice(1)) {
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

function normalizeFileReference(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.toLocaleLowerCase().startsWith('file:')) return value
  try {
    return fileURLToPath(trimmed)
  } catch {
    throw new Error(`invalid file URI: ${value}`)
  }
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

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  return new Error(`pinned snapshot wait aborted${reason === undefined ? '' : `: ${String(reason)}`}`)
}
