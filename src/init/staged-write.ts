import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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

export type WriteInPlace = (path: string, content: string | Buffer) => void
// Test seams for a config (+ credential) publication: fail or observe an
// in-place write after writing has begun, or take the Windows .env path (no
// staged copies) on any platform.
export type PublishSeams = {
  writeInPlace?: WriteInPlace
  platform?: NodeJS.Platform
}

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

// typeclaw.json is always written in place on its existing inode, never
// replaced by rename. A new inode would take the directory's default group and
// ACLs (a setgid directory, inherited default ACLs, an ACL mask) instead of the
// file's own access policy, which can broaden access to a config that holds
// inline credentials (e.g. an MCP server's env); on Windows it would take the
// directory's ACL. The prior bytes are kept in memory, and a failed write puts
// them back in place.
export type ConfigWrite = {
  // The file to update: `path` itself, or through a symlink, its target, so the
  // link survives and keeps pointing at the updated file.
  path: string
  content: Buffer
  prior: Buffer | undefined
}

// A failed in-place config write whose prior content could not be put back.
export class ConfigRestoreError extends Error {}

// A config write refused before any byte was written: retrying once the file
// is back to a checked regular file succeeds. Thrown by the verified writer
// (prepareConfigWriteSync in src/config/config-commits.ts).
export class ConfigWriteRefusedError extends Error {}

// A config file write the caller verified (prepareConfigWriteSync): its prior
// bytes were read on the verified entry, and its writer only writes that entry
// (or, with no prior bytes, creates the file exclusively), restoring the prior
// bytes itself if a write fails partway.
export type VerifiedConfigFile = { path: string; prior: Buffer | undefined; writeInPlace: WriteInPlace }

// Resolves the file to write and reads its prior bytes. A read-only
// destination is refused, as the in-place write would be.
export function prepareConfigWrite(path: string, content: string | Buffer): ConfigWrite {
  const target = linkTarget(path)
  if (modeOrUndefined(target) !== undefined) accessSync(target, constants.W_OK)
  return { path: target, content: Buffer.from(content), prior: readFileOrUndefined(target) }
}

// Writes the target in place (O_WRONLY|O_TRUNC), or creates it if it did not
// exist (through `create` when given), putting the prior bytes back if the
// write fails; a failed restore throws `ConfigRestoreError`. A refused write
// wrote nothing, so there is nothing to put back.
export function publishConfigWrite(
  write: ConfigWrite,
  writeInPlace: WriteInPlace = writeExistingInPlace,
  create?: WriteInPlace,
): void {
  if (write.prior === undefined) {
    if (create !== undefined) create(write.path, write.content)
    else writeFileSync(write.path, write.content, { flag: 'wx' })
    return
  }
  try {
    writeInPlace(write.path, write.content)
  } catch (error) {
    if (error instanceof ConfigWriteRefusedError || error instanceof ConfigRestoreError) throw error
    try {
      writeInPlace(write.path, write.prior)
    } catch (restoreError) {
      throw new ConfigRestoreError(
        `${write.path} could not be restored (${describe(restoreError)}) after a failed write (${describe(error)}); restore it with \`git checkout -- ${basename(write.path)}\` in the agent folder`,
      )
    }
    throw error
  }
}

// A verified config's write, refused like prepareConfigWrite's when the file
// is read-only, before the paired .env update is published.
function verifiedConfigWrite(verified: VerifiedConfigFile, content: string): ConfigWrite {
  if (verified.prior !== undefined) accessSync(verified.path, constants.W_OK)
  return { path: verified.path, content: Buffer.from(content), prior: verified.prior }
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
    closeSync(openSync(staged.path, 'wx', 0o600))
    staged.created = true
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
        ? `${failure}; it did not exist before this command and may still hold part of the new token(s). Empty ${staged.path} in place before retrying; do not delete it (a running sandbox may mask it).`
        : staged.priorCopy === undefined
          ? `${failure}; the previous token(s) in it could not be restored and must be re-entered in ${staged.path}.`
          : `${failure}; its previous content is saved at ${staged.priorCopy}. Copy that file's content back into ${staged.path} by hand.`,
    )
  }
}

export type CredentialUpdate = { path: string; content: string; stagingDir: string }

// Publishes typeclaw.json together with an optional credential (.env) update,
// all or nothing, for callers holding the config lock. Both are prepared first;
// then the credential is written in place (`publishCredential`) and
// typeclaw.json written in place (`publishConfigWrite`), and the credential is
// put back if typeclaw.json cannot be. A failure never leaves either file
// partly written; a .env this created is left empty rather than removed.
// `seams` let tests fail a step after writing has begun and take the Windows
// .env path on any platform. `config` is the config file's path, or a write
// the caller verified (prepareConfigWriteSync): its path is not resolved again
// and its prior bytes are not read again, and its own writer is used.
export function publishConfigWithCredential(
  config: string | VerifiedConfigFile,
  configBytes: string,
  credential: CredentialUpdate | undefined,
  seams: PublishSeams = {},
): { ok: true } | { ok: false; reason: string } {
  const credentialName = credential === undefined ? undefined : basename(credential.path)
  let staged: StagedCredential | undefined
  let keepPriorCopy = false
  try {
    if (credential !== undefined) {
      staged = stageCredential(credential.path, credential.content, credential.stagingDir, seams.platform)
    }
    const verified = typeof config === 'string' ? undefined : config
    const configWrite =
      verified === undefined
        ? prepareConfigWrite(config as string, configBytes)
        : verifiedConfigWrite(verified, configBytes)
    if (staged !== undefined) publishCredential(staged, seams.writeInPlace)
    try {
      publishConfigWrite(configWrite, seams.writeInPlace ?? verified?.writeInPlace, verified?.writeInPlace)
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
    if (staged !== undefined) discardCredentialStaging(staged, keepPriorCopy)
  }
  return { ok: true }
}

export function discardCredentialStaging(staged: StagedCredential, keepPrior = false): void {
  if (staged.newCopy !== undefined) rmSync(staged.newCopy, { force: true })
  if (staged.priorCopy !== undefined && !keepPrior) rmSync(staged.priorCopy, { force: true })
}

function writeExistingInPlace(path: string, content: string | Buffer): void {
  // 'r+' opens the existing file only (numeric O_WRONLY|O_TRUNC flags are
  // rejected with EINVAL on Windows); truncating the same descriptor keeps the
  // file object, its ACL, and any sandbox mask bound to its inode.
  const fd = openSync(path, 'r+')
  try {
    ftruncateSync(fd, 0)
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
