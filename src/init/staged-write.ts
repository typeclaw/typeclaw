import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
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

// Replaces `path` with `content` by renaming a fully written copy over it, so
// a failure part-way through never leaves a truncated file.
export function replaceFile(
  path: string,
  content: string | Buffer,
  options: { rename?: Rename; credentialStagingDir?: string } = {},
): void {
  const temp = stageReplacement(path, content, options.credentialStagingDir)
  try {
    ;(options.rename ?? renameSync)(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

// Writes the replacement for `path` in full and returns its staged path; the
// caller renames it over `path`. A read-only destination is refused, as an
// in-place write to it would be. Without a credential staging dir the copy
// sits beside `path` with a gitignored suffix. A credential is staged in the
// masked `credentialStagingDir` instead, and is owner-only from the moment it
// is created, before any byte is written.
export function stageReplacement(path: string, content: string | Buffer, credentialStagingDir?: string): string {
  const mode = modeOrUndefined(path)
  if (mode !== undefined) accessSync(path, constants.W_OK)
  if (credentialStagingDir !== undefined) mkdirSync(credentialStagingDir, { recursive: true, mode: 0o700 })
  const temp = join(credentialStagingDir ?? dirname(path), `.${basename(path)}.${randomUUID()}.typeclaw-tmp`)
  const createMode = credentialStagingDir === undefined ? 0o666 : (mode ?? 0o600) & 0o600
  try {
    const fd = openSync(temp, 'wx', createMode)
    try {
      writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
    if (mode !== undefined) chmodSync(temp, mode)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return temp
}

function modeOrUndefined(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
