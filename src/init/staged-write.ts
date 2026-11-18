import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Where a replacement credential file (.env) is fully written before it is
// renamed into place. src/sandbox/canonical-secrets.ts masks it like the file it
// replaces; it is on the agent-root mount so the rename is atomic. Kept in this
// leaf module so the sandbox can import it without loading the init domain.
export const CREDENTIAL_STAGING_RELATIVE_DIR = '.typeclaw/credential-staging'

export type Rename = (from: string, to: string) => void

export function credentialStagingDir(agentDir: string): string {
  return join(agentDir, CREDENTIAL_STAGING_RELATIVE_DIR)
}

// Makes `dir` an owner-only (0700) directory: creates it 0700, or tightens an
// existing one. Shared by credential staging and the sandbox mask setup so the
// directory a credential is staged in is never readable by other local users.
// Throws if `dir` is not a real directory or cannot be made 0700.
export function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory; refusing to stage credentials in it`)
  if ((stats.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  if ((lstatSync(dir).mode & 0o777) !== 0o700) {
    throw new Error(`${dir} could not be made owner-only (0700); refusing to stage credentials in it`)
  }
}

export type StagedReplacement = {
  temp: string
  path: string
  // Applied once the staged credential is published; until then it stays 0600.
  publishMode: number | undefined
}

// Replaces `path` with `content` by renaming a fully written copy over it, so
// a failure part-way through never leaves a truncated file.
export function replaceFile(
  path: string,
  content: string | Buffer,
  options: { rename?: Rename; credentialStagingDir?: string } = {},
): void {
  const staged = stageReplacement(path, content, options.credentialStagingDir)
  try {
    ;(options.rename ?? renameSync)(staged.temp, path)
    applyPublishMode(staged)
  } finally {
    rmSync(staged.temp, { force: true })
  }
}

// Writes the replacement for `path` in full; the caller renames `temp` over
// `path` and then calls `applyPublishMode`. A read-only destination is refused,
// as an in-place write to it would be. Without a credential staging dir the copy
// sits beside `path` with a gitignored suffix and the destination's mode. A
// credential is staged in the masked, owner-only `credentialStagingDir` and is
// 0600 from the moment it is created until it is published.
export function stageReplacement(
  path: string,
  content: string | Buffer,
  credentialStagingDir?: string,
): StagedReplacement {
  const mode = modeOrUndefined(path)
  if (mode !== undefined) accessSync(path, constants.W_OK)
  if (credentialStagingDir !== undefined) ensureOwnerOnlyDir(credentialStagingDir)
  const temp = join(credentialStagingDir ?? dirname(path), `.${basename(path)}.${randomUUID()}.typeclaw-tmp`)
  try {
    const fd = openSync(temp, 'wx', credentialStagingDir === undefined ? 0o666 : 0o600)
    try {
      writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
    if (credentialStagingDir === undefined && mode !== undefined) chmodSync(temp, mode)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return { temp, path, publishMode: credentialStagingDir === undefined ? undefined : mode }
}

export function applyPublishMode(staged: StagedReplacement): void {
  if (staged.publishMode !== undefined) chmodSync(staged.path, staged.publishMode)
}

function modeOrUndefined(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
