import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitSystemFileSync } from '@/git/system-commit'

import {
  configSchema,
  expandMountPath,
  loadConfigSyncOrDefaults,
  mountSchema,
  validateMount,
  type Mount,
} from './config'
import { readConfigForWriteSync, tryRecordConfigCommitSync } from './config-commits'
import { withConfigFileLockSync } from './config-file-lock'

const CONFIG_FILE = 'typeclaw.json'
const MOUNT_TARGET_PREFIX = '/agent/mounts'

export type MountListEntry = Mount & {
  resolvedPath: string
  targetPath: string
  status: 'ok' | 'error'
  statusReason?: string
}

export type AddMountOptions = {
  readOnly?: boolean
  description?: string | undefined
}

export type AddMountResult = { ok: true; entry: MountListEntry } | { ok: false; reason: string }
export type RemoveMountResult = { ok: true; removed: MountListEntry } | { ok: false; reason: string }

export function listMounts(cwd: string): MountListEntry[] {
  const mounts = loadConfigSyncOrDefaults(cwd).mounts
  return mounts.map((mount) => toListEntry(mount, cwd))
}

export function addMount(cwd: string, name: string, path: string, options: AddMountOptions = {}): AddMountResult {
  const added = withConfigFileLockSync(join(cwd, CONFIG_FILE), (): MountWrite => {
    const mount = buildMount(name, path, options)
    if (!mount.ok) return mount

    const check = validateMount(mount.value, cwd)
    if (!check.ok) return check

    const parsed = readConfigRecord(cwd)
    if (!parsed.ok) return parsed

    const current = readMounts(parsed.value)
    if (!current.ok) return current
    if (current.value.some((m) => m.name === mount.value.name)) {
      return {
        ok: false,
        reason: `Mount "${mount.value.name}" already exists. Remove it first with \`typeclaw mount remove ${mount.value.name}\`.`,
      }
    }

    const next = { ...parsed.value, mounts: [...current.value, mount.value] }
    const write = writeMounts(cwd, next)
    if (!write.ok) return write
    return { ok: true, mount: mount.value }
  })
  if (!added.ok) return added
  commitSystemFileSync(cwd, CONFIG_FILE, `mount: add ${added.mount.name}`)
  return { ok: true, entry: toListEntry(added.mount, cwd) }
}

export function removeMount(cwd: string, name: string): RemoveMountResult {
  const removed = withConfigFileLockSync(join(cwd, CONFIG_FILE), (): MountWrite => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return { ok: false, reason: 'Mount name cannot be empty.' }

    const parsed = readConfigRecord(cwd)
    if (!parsed.ok) return parsed

    const current = readMounts(parsed.value)
    if (!current.ok) return current

    const removed = current.value.find((m) => m.name === trimmed)
    if (removed === undefined) return { ok: false, reason: `Mount "${trimmed}" not found in ${CONFIG_FILE}.` }

    const next = { ...parsed.value, mounts: current.value.filter((m) => m.name !== trimmed) }
    const write = writeMounts(cwd, next)
    if (!write.ok) return write
    return { ok: true, mount: removed }
  })
  if (!removed.ok) return removed
  commitSystemFileSync(cwd, CONFIG_FILE, `mount: remove ${removed.mount.name}`)
  return { ok: true, removed: toListEntry(removed.mount, cwd) }
}

type MountWrite = { ok: true; mount: Mount } | { ok: false; reason: string }

function buildMount(
  name: string,
  path: string,
  options: AddMountOptions,
): { ok: true; value: Mount } | { ok: false; reason: string } {
  const description = options.description?.trim()
  const raw = {
    name: name.trim(),
    path,
    readOnly: options.readOnly ?? false,
    ...(description !== undefined && description.length > 0 ? { description } : {}),
  }
  const parsed = mountSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map(formatIssue).join('; ') }
  }
  return { ok: true, value: parsed.data }
}

function readConfigRecord(cwd: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const raw = readConfigForWriteSync(join(cwd, CONFIG_FILE))
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `${CONFIG_FILE} must contain a JSON object.` }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    return { ok: false, reason: `Failed to read ${CONFIG_FILE}: ${(error as Error).message}` }
  }
}

function readMounts(record: Record<string, unknown>): { ok: true; value: Mount[] } | { ok: false; reason: string } {
  const parsed = configSchema.safeParse(record)
  if (!parsed.success) {
    return { ok: false, reason: `${CONFIG_FILE} is invalid: ${parsed.error.issues.map(formatIssue).join('; ')}` }
  }
  return { ok: true, value: parsed.data.mounts }
}

function writeMounts(cwd: string, record: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const parsed = configSchema.safeParse(record)
  if (!parsed.success) {
    return { ok: false, reason: `mounts block would be invalid: ${parsed.error.issues.map(formatIssue).join('; ')}` }
  }

  const bytes = `${JSON.stringify(record, null, 2)}\n`
  try {
    writeFileSync(join(cwd, CONFIG_FILE), bytes)
  } catch (error) {
    return { ok: false, reason: `Failed to write ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  tryRecordConfigCommitSync(join(cwd, CONFIG_FILE), bytes)
  return { ok: true }
}

function toListEntry(mount: Mount, cwd: string): MountListEntry {
  const resolvedPath = expandMountPath(mount.path, cwd)
  const targetPath = `${MOUNT_TARGET_PREFIX}/${mount.name}`
  const check = validateMount(mount, cwd)
  return {
    ...mount,
    resolvedPath,
    targetPath,
    status: check.ok ? 'ok' : 'error',
    ...(!check.ok ? { statusReason: check.reason } : {}),
  }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
