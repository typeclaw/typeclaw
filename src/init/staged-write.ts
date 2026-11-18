import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

// Where a credential file (.env) update is staged before it is written in
// place: the full new content and a copy of the prior content, for recovery.
// src/sandbox/canonical-secrets.ts masks it like the file itself. Kept in this
// leaf module so the sandbox can import it without loading the init domain.
export const CREDENTIAL_STAGING_RELATIVE_DIR = '.typeclaw/credential-staging'

export type Rename = (from: string, to: string) => void
export type WriteInPlace = (path: string, content: string | Buffer) => void

export function credentialStagingDir(agentDir: string): string {
  return join(agentDir, CREDENTIAL_STAGING_RELATIVE_DIR)
}

// Makes `dir` an owner-only (0700) directory: creates it 0700, or tightens an
// existing one. Shared by credential staging and the sandbox mask setup so the
// directory a credential is staged in is never readable by other local users.
// Throws if `dir` is not a real directory (a symlink is refused) or cannot be
// made 0700.
export function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory; refusing to stage credentials in it`)
  // Windows has no POSIX owner/group/other bits: chmod only toggles read-only,
  // so the 0700 check could never pass. Its access control is ACLs, and the
  // staging dir sits under the agent folder, which inherits the user profile's
  // ACLs; the bwrap mask this dir pairs with is Linux-only. Checking ACLs would
  // mean parsing localized `icacls` output, which is too fragile to gate token
  // storage on, so only the directory and symlink checks above apply there.
  if (process.platform === 'win32') return
  if ((stats.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  if ((lstatSync(dir).mode & 0o777) !== 0o700) {
    throw new Error(`${dir} could not be made owner-only (0700); refusing to stage credentials in it`)
  }
}

export type StagedReplacement = {
  // The file to update: `path` itself, or through a symlink, its target.
  path: string
  content: Buffer
  // The fully written copy renamed over `path`; none on Windows (see below).
  temp: string | undefined
  // The bytes `path` held, to put back if an in-place write fails.
  prior: Buffer | undefined
}

// A failed in-place config write whose prior content could not be put back.
export class ConfigRestoreError extends Error {}

// Replaces a file no sandbox masks (typeclaw.json) without ever leaving it
// partly written: a masked credential goes through `publishCredential`.
export function replaceFile(
  path: string,
  content: string | Buffer,
  rename: Rename = renameSync,
  platform: NodeJS.Platform = process.platform,
): void {
  const staged = stageReplacement(path, content, platform)
  try {
    publishReplacement(staged, rename)
  } finally {
    if (staged.temp !== undefined) rmSync(staged.temp, { force: true })
  }
}

// Prepares the replacement for `path`. If `path` is a symlink, the file updated
// is the link's target, so the link survives and keeps pointing at the updated
// file, as an in-place write through it would. A read-only destination is
// refused, as an in-place write to it would be. Elsewhere the content is
// written in full to a gitignored copy beside the target, with its mode, for
// `publishReplacement` to rename over it. On Windows no copy is made: a new
// file object would take the directory's ACL in place of the file's own (a
// config with a stricter explicit ACL would lose it), so the file is written
// in place instead, with its prior bytes kept in memory for a failed write.
export function stageReplacement(
  path: string,
  content: string | Buffer,
  platform: NodeJS.Platform = process.platform,
): StagedReplacement {
  const target = linkTarget(path)
  const mode = modeOrUndefined(target)
  if (mode !== undefined) accessSync(target, constants.W_OK)
  const bytes = Buffer.from(content)
  if (platform === 'win32') return { path: target, content: bytes, temp: undefined, prior: readFileOrUndefined(target) }
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.typeclaw-tmp`)
  try {
    writeFileSync(temp, bytes, { flag: 'wx' })
    if (mode !== undefined) chmodSync(temp, mode)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return { path: target, content: bytes, temp, prior: undefined }
}

// Renames the staged copy over the target, or on Windows writes the target in
// place (creating it if it did not exist), putting the prior bytes back if the
// write fails; a failed restore throws `ConfigRestoreError`.
export function publishReplacement(
  staged: StagedReplacement,
  rename: Rename = renameSync,
  writeInPlace: WriteInPlace = writeExistingInPlace,
): void {
  if (staged.temp !== undefined) {
    rename(staged.temp, staged.path)
    return
  }
  if (staged.prior === undefined) {
    writeFileSync(staged.path, staged.content, { flag: 'wx' })
    return
  }
  try {
    writeInPlace(staged.path, staged.content)
  } catch (error) {
    try {
      writeInPlace(staged.path, staged.prior)
    } catch (restoreError) {
      throw new ConfigRestoreError(
        `${staged.path} could not be restored (${describe(restoreError)}) after a failed write (${describe(error)}); restore it with \`git checkout -- ${basename(staged.path)}\` in the agent folder.`,
      )
    }
    throw error
  }
}

// The file a write to `path` lands in: its real path through any symlinks, or
// for a dangling link, the file the link names (which an in-place write would
// create).
function linkTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    return resolve(dirname(path), readlinkSync(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EINVAL') return path
    throw error
  }
}

export type StagedCredential = {
  path: string
  content: Buffer
  prior: Buffer | undefined
  // Set once `publishCredential` created the file (there was none before).
  created: boolean
  // Owner-only copies in the staging dir (never on Windows, see
  // `stageCredential`). `priorCopy` is kept for manual recovery when a
  // restore fails; both are removed otherwise.
  newCopy: string | undefined
  priorCopy: string | undefined
}

// A failed credential write whose prior content could not be put back either;
// the message names the file and the staged copy to recover it from.
export class CredentialRestoreError extends Error {}

// A running sandbox masks .env with a bind over its inode, and a rename would
// put a new, unmasked inode at the path. So a credential update is staged here
// (the full new content and a copy of the prior content, both 0600 in the
// owner-only staging dir) and then written in place by `publishCredential`.
// A read-only destination is refused, as an in-place write to it would be.
// On Windows nothing is written to the staging dir: a file there inherits the
// agent folder's ACL rather than .env's, so on a shared folder with a
// restricted .env the copies would be readable by others. There the prior
// content is held in memory only for rollback, and the new bytes go straight
// into .env in place, which keeps .env's own ACL.
export function stageCredential(
  path: string,
  content: string | Buffer,
  stagingDir: string,
  platform: NodeJS.Platform = process.platform,
): StagedCredential {
  const prior = readFileOrUndefined(path)
  if (prior !== undefined) accessSync(path, constants.W_OK)
  if (platform === 'win32') {
    return { path, content: Buffer.from(content), prior, created: false, newCopy: undefined, priorCopy: undefined }
  }
  ensureOwnerOnlyDir(stagingDir)
  const staged: StagedCredential = {
    path,
    content: Buffer.from(content),
    prior,
    created: false,
    newCopy: join(stagingDir, `.${basename(path)}.${randomUUID()}.new.typeclaw-tmp`),
    priorCopy:
      prior === undefined ? undefined : join(stagingDir, `.${basename(path)}.${randomUUID()}.prior.typeclaw-tmp`),
  }
  try {
    writeOwnerOnly(staged.newCopy as string, staged.content)
    if (staged.priorCopy !== undefined && prior !== undefined) writeOwnerOnly(staged.priorCopy, prior)
  } catch (error) {
    discardCredentialStaging(staged)
    throw error
  }
  return staged
}

// Writes the staged content over the credential's existing inode (O_TRUNC, no
// rename), or creates it 0600 if it did not exist. If the write fails, the prior
// content is written back in place; a failed restore throws
// `CredentialRestoreError` and the prior copy is kept for recovery. A file this
// creates is never unlinked again: a sandbox started meanwhile may have bound
// its .env mask to that inode, and a later write would then create a new,
// unmasked one. On a failed write it is emptied in place instead.
export function publishCredential(staged: StagedCredential, writeInPlace: WriteInPlace = writeExistingInPlace): void {
  if (staged.prior === undefined) {
    const fd = openSync(staged.path, 'wx', 0o600)
    staged.created = true
    try {
      writeFileSync(fd, staged.content)
    } catch (error) {
      ftruncateSync(fd, 0)
      throw error
    } finally {
      closeSync(fd)
    }
    return
  }
  try {
    writeInPlace(staged.path, staged.content)
  } catch (error) {
    restoreCredential(staged, writeInPlace, error)
    throw error
  }
}

// Puts the credential back as it was before `publishCredential`: the prior
// content written in place, or, if `publishCredential` created the file, the
// file emptied in place (never unlinked; see `publishCredential`).
export function restoreCredential(
  staged: StagedCredential,
  writeInPlace: WriteInPlace = writeExistingInPlace,
  cause?: unknown,
): void {
  try {
    writeInPlace(staged.path, staged.prior ?? Buffer.alloc(0))
  } catch (restoreError) {
    const failure = `${staged.path} could not be restored (${describe(restoreError)})${cause === undefined ? '' : ` after a failed write (${describe(cause)})`}`
    throw new CredentialRestoreError(
      staged.prior === undefined
        ? `${failure}; it did not exist before this command and now holds the new token(s); empty it by hand.`
        : staged.priorCopy === undefined
          ? `${failure}; the previous token(s) in it could not be restored and must be re-entered in ${staged.path}.`
          : `${failure}; its previous content is saved at ${staged.priorCopy}. Copy that file's content back into ${staged.path} by hand.`,
    )
  }
}

export type CredentialUpdate = { path: string; content: string; stagingDir: string }

// Publishes typeclaw.json together with an optional credential (.env) update,
// all or nothing, for callers holding the config lock. Both are staged first;
// then the credential is written in place (`publishCredential`) and
// typeclaw.json published (`publishReplacement`: renamed into place, or on
// Windows written in place), and the credential is put back if typeclaw.json
// cannot be. A failure never leaves either file partly written; a .env this
// created is left empty rather than removed. `seams` let tests fail a step
// after writing has begun and take the Windows path on any platform.
export function publishConfigWithCredential(
  configPath: string,
  configBytes: string,
  credential: CredentialUpdate | undefined,
  seams: { rename?: Rename; writeInPlace?: WriteInPlace; platform?: NodeJS.Platform } = {},
): { ok: true } | { ok: false; reason: string } {
  const rename = seams.rename ?? renameSync
  const credentialName = credential === undefined ? undefined : basename(credential.path)
  let staged: StagedCredential | undefined
  let configStaged: StagedReplacement | undefined
  let keepPriorCopy = false
  try {
    if (credential !== undefined) {
      staged = stageCredential(credential.path, credential.content, credential.stagingDir, seams.platform)
    }
    configStaged = stageReplacement(configPath, configBytes, seams.platform)
    if (staged !== undefined) publishCredential(staged, seams.writeInPlace)
    try {
      publishReplacement(configStaged, rename, seams.writeInPlace)
    } catch (error) {
      const configState = error instanceof ConfigRestoreError ? error.message : 'typeclaw.json was not changed'
      const cause = error instanceof ConfigRestoreError ? '' : `${describe(error)}. `
      if (staged === undefined) return { ok: false, reason: `${cause}${configState}.` }
      try {
        restoreCredential(staged, seams.writeInPlace)
      } catch (restoreError) {
        keepPriorCopy = true
        return { ok: false, reason: `${cause}${configState}; ${describe(restoreError)}` }
      }
      const credentialState = staged.created ? 'was left empty' : 'was restored'
      return { ok: false, reason: `${cause}${configState}; ${credentialName} ${credentialState}.` }
    }
  } catch (error) {
    if (error instanceof CredentialRestoreError) {
      keepPriorCopy = true
      return { ok: false, reason: `typeclaw.json was not changed; ${error.message}` }
    }
    const unchanged =
      credentialName === undefined
        ? 'typeclaw.json was not changed'
        : staged?.created === true
          ? `typeclaw.json was not changed; ${credentialName} was left empty`
          : `Neither ${credentialName} nor typeclaw.json was changed`
    return { ok: false, reason: `${describe(error)}. ${unchanged}.` }
  } finally {
    if (configStaged?.temp !== undefined) rmSync(configStaged.temp, { force: true })
    if (staged !== undefined) discardCredentialStaging(staged, keepPriorCopy)
  }
  return { ok: true }
}

export function discardCredentialStaging(staged: StagedCredential, keepPrior = false): void {
  if (staged.newCopy !== undefined) rmSync(staged.newCopy, { force: true })
  if (staged.priorCopy !== undefined && !keepPrior) rmSync(staged.priorCopy, { force: true })
}

function writeExistingInPlace(path: string, content: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC)
  try {
    writeFileSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

function writeOwnerOnly(path: string, content: Buffer): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

function readFileOrUndefined(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function modeOrUndefined(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
