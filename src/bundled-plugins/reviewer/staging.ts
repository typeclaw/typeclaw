import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

export type GithubPrTarget = {
  kind: 'github-pr'
  owner: string
  repo: string
  pullNumber: number
  headSha?: string
}

export type StagedRepo = {
  hostPath: string
  sandboxPath: string
  headSha: string
  dispose: () => Promise<void>
}

export type StageGithubPrOptions = {
  target: GithubPrTarget
  token: string
  fetchImpl?: typeof fetch
}

const SANDBOX_PATH = '/work'
const GITHUB_API = 'https://api.github.com'

export async function stageGithubPr(options: StageGithubPrOptions): Promise<StagedRepo> {
  const { target, token } = options
  const doFetch = options.fetchImpl ?? fetch
  const headSha = target.headSha ?? (await resolveHeadSha(target, token, doFetch))

  const tarballUrl = `${GITHUB_API}/repos/${target.owner}/${target.repo}/tarball/${headSha}`
  const res = await doFetch(tarballUrl, { headers: authHeaders(token) })
  if (!res.ok) {
    throw new StagingError(`tarball fetch failed (${res.status}) for ${target.owner}/${target.repo}@${headSha}`)
  }
  const gz = Buffer.from(await res.arrayBuffer())

  const root = await mkdtemp(join(tmpdir(), 'typeclaw-review-'))
  const repoDir = join(root, 'repo')
  const dispose = async () => {
    await rm(root, { recursive: true, force: true })
  }
  try {
    await extractTarGzSafely(gz, repoDir)
  } catch (err) {
    await dispose()
    throw err
  }
  return { hostPath: repoDir, sandboxPath: SANDBOX_PATH, headSha, dispose }
}

async function resolveHeadSha(target: GithubPrTarget, token: string, doFetch: typeof fetch): Promise<string> {
  const url = `${GITHUB_API}/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}`
  const res = await doFetch(url, { headers: authHeaders(token) })
  if (!res.ok) {
    throw new StagingError(
      `PR metadata fetch failed (${res.status}) for ${target.owner}/${target.repo}#${target.pullNumber}`,
    )
  }
  const body = (await res.json()) as { head?: { sha?: unknown } }
  const sha = body.head?.sha
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new StagingError('PR metadata did not include head.sha')
  }
  return sha
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'typeclaw-reviewer',
  }
}

export class StagingError extends Error {
  override readonly name = 'StagingError'
}

// Tar typeflag bytes (POSIX ustar). We accept only regular files and
// directories; everything else (symlinks, hardlinks, devices, fifos) is a
// rejection, because the reviewer's read/grep/find/ls tools are NOT inside the
// bwrap jail — a symlink in the staged tree could let an un-jailed `read`
// escape to /agent secrets. Fail closed on the whole archive.
const TYPE_REGULAR = new Set(['0', '\0', ''])
const TYPE_DIRECTORY = '5'

// Minimal, dependency-free tar.gz extractor with a hard safety gate. Writes
// only regular files + directories under `destDir`, strips the single
// top-level directory GitHub wraps the archive in, and throws StagingError on
// the first dangerous entry (absolute path, `..` traversal, symlink, hardlink,
// or any non-regular/non-dir type) before writing it.
export async function extractTarGzSafely(gzData: Buffer, destDir: string): Promise<void> {
  const tar = gunzipSync(gzData)
  const destRoot = resolve(destDir)
  const entries = parseTarEntries(tar)

  for (const entry of entries) {
    // Validate the RAW name first: an absolute path like `/etc/evil` would
    // otherwise lose its leading slash to stripTopLevel and look benign.
    assertSafeRawName(entry.name)

    // Reject non-regular/non-dir types (symlink/hardlink/device/fifo) before
    // any path manipulation — these are unsafe regardless of where they point.
    if (entry.typeflag !== TYPE_DIRECTORY && !TYPE_REGULAR.has(entry.typeflag)) {
      throw new StagingError(
        `refusing unsafe tar entry "${entry.name}" (typeflag ${JSON.stringify(entry.typeflag)}); only regular files and directories are allowed`,
      )
    }

    const stripped = stripTopLevel(entry.name)
    if (stripped === null) continue
    assertSafeRelativePath(stripped, entry.name)

    if (entry.typeflag === TYPE_DIRECTORY) continue

    const target = join(destRoot, stripped)
    if (!isInside(destRoot, target)) {
      throw new StagingError(`refusing tar entry escaping staged root: "${entry.name}"`)
    }
    await Bun.write(target, entry.data)
  }
}

function assertSafeRawName(name: string): void {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new StagingError(`refusing absolute tar entry path: "${name}"`)
  }
}

function assertSafeRelativePath(rel: string, original: string): void {
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new StagingError(`refusing absolute tar entry path: "${original}"`)
  }
  const parts = rel.split(/[\\/]/)
  if (parts.some((p) => p === '..')) {
    throw new StagingError(`refusing tar entry with parent-traversal: "${original}"`)
  }
}

function isInside(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(rootWithSep)
}

// GitHub tarballs wrap every entry in a single `{repo}-{sha}/` directory.
// Strip exactly that first path segment so the staged tree mirrors the repo
// root. Returns null for the wrapper directory entry itself.
function stripTopLevel(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '')
  const idx = normalized.indexOf('/')
  if (idx === -1) return null
  const rest = normalized.slice(idx + 1)
  return rest === '' ? null : rest
}

type TarEntry = { name: string; typeflag: string; data: Buffer }

// POSIX ustar: 512-byte headers, name at 0..100, size (octal) at 124..136,
// typeflag at 156, optional prefix at 345..500. Data follows in 512-byte
// blocks. Two consecutive zero blocks terminate the archive.
function parseTarEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (isZeroBlock(header)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const fullName = prefix !== '' ? `${prefix}/${name}` : name
    const size = parseOctal(readString(header, 124, 12))
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    const data = buf.subarray(dataStart, dataStart + size)
    entries.push({ name: fullName, typeflag: typeflag === '\0' ? '0' : typeflag, data: Buffer.from(data) })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function readString(block: Buffer, start: number, len: number): string {
  const raw = block.subarray(start, start + len)
  const end = raw.indexOf(0)
  return raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString('utf8')
    .trim()
}

function parseOctal(s: string): number {
  const trimmed = s.replace(/[^0-7]/g, '')
  if (trimmed === '') return 0
  return parseInt(trimmed, 8)
}
