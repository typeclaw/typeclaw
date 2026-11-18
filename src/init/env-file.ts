import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { withConfigFileLockSync } from '@/config/config-file-lock'

import { credentialStagingDir, replaceFile } from './staged-write'

const ENV_FILE = '.env'

// Parse the agent's `.env` into a key-value map, mirroring Docker's
// `--env-file` parser (docker/cli `pkg/kvfile.parseKeyValueFile`): a UTF-8 BOM
// is stripped from the FIRST line only, every line is left-trimmed of Unicode
// whitespace BEFORE the blank/`#` check, and nothing is trimmed around or after
// `=` (no quote stripping, no shell expansion). Last value wins on duplicates.
//
// The normalization is load-bearing, not cosmetic: Docker accepts a BOM-prefixed
// or indented `KEY=value` and passes it to the container, so a parser that missed
// those would report an operator-declared variable as absent — which callers read
// as "TypeClaw may manage this", e.g. migrating a deliberately pinned directory.
export function readEnvFile(cwd: string): Map<string, string> {
  const out = new Map<string, string>()
  let raw: string
  try {
    raw = readFileSync(join(cwd, ENV_FILE), 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return out
    throw err
  }
  const lines = raw.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const parsed = parseEnvLine(rawLine, index)
    if (parsed === null) continue
    out.set(parsed.key, parsed.value)
  }
  return out
}

// Shared by the reader and the writer so a declaration one of them recognizes
// can never be invisible to the other — an indented key that parsed as declared
// but did not match on write would append a duplicate instead of replacing.
function parseEnvLine(rawLine: string, index: number): { key: string; value: string } | null {
  const withoutBom = index === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine
  // \p{White_Space}, not \s: JS \s also matches U+FEFF (and misses U+0085),
  // so \s would strip a BOM on EVERY line while Go's unicode.IsSpace — which
  // Docker uses — strips it on line 1 only.
  const line = withoutBom.replace(/^\p{White_Space}+/u, '')
  if (line.length === 0) return null
  if (line.startsWith('#')) return null
  const eq = line.indexOf('=')
  if (eq <= 0) return null
  const key = line.slice(0, eq)
  // Docker rejects the whole file when a key contains a space or tab, so such
  // a line can never reach a container; skip it rather than inventing a key.
  if (/[ \t]/.test(key)) return null
  return { key, value: line.slice(eq + 1) }
}

export function hasEnvKey(cwd: string, key: string): boolean {
  const value = readEnvFile(cwd).get(key)
  return value !== undefined && value.length > 0
}

// Write `key=value` to the agent's `.env`. Idempotent: replaces an existing
// line for the same key in place (preserving order and surrounding comments),
// or appends if absent. Creates the file if missing. The value is written
// verbatim with no quoting because Docker's `--env-file` parser does not
// strip quotes (a wrapping `"..."` would land in `process.env` literally).
export function appendOrReplaceEnvKey(cwd: string, key: string, value: string): void {
  const path = join(cwd, ENV_FILE)
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err
  }
  writeFileSync(path, withEnvKey(raw, key, value), 'utf8')
}

// Stores a token an operator was just prompted for, unless another typeclaw
// command stored `key` while the prompt was open. The recheck and the write
// happen under the typeclaw.json config lock, the same lock `typeclaw tunnel`
// holds while it writes its token, so no command overwrites another's
// credential. The new .env is staged in the masked credential staging dir and
// renamed into place, so a failure never leaves a truncated .env.
export function storeEnvKeyUnlessPresent(
  cwd: string,
  key: string,
  value: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    return withConfigFileLockSync(join(cwd, 'typeclaw.json'), () => {
      if (hasEnvKey(cwd, key)) {
        return {
          ok: false,
          reason: `${key} was stored in .env by another typeclaw command while this one was in progress; nothing was written. Rerun this command to use the stored token.`,
        }
      }
      const path = join(cwd, ENV_FILE)
      let raw = ''
      try {
        raw = readFileSync(path, 'utf8')
      } catch (err) {
        if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err
      }
      replaceFile(path, withEnvKey(raw, key, value), { credentialStagingDir: credentialStagingDir(cwd) })
      return { ok: true }
    })
  } catch (error) {
    return {
      ok: false,
      reason: `could not store ${key} in .env: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// The `.env` content `appendOrReplaceEnvKey` writes, for callers that write it
// themselves.
export function withEnvKey(raw: string, key: string, value: string): string {
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/)
  // `"foo\n".split(/\r?\n/)` returns `["foo", ""]` — strip that phantom
  // trailing empty element so the rebuilt output ends in exactly one newline
  // regardless of replace-vs-append path.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let replaced = false
  const next = lines.map((line, index) => {
    const parsed = parseEnvLine(line, index)
    if (parsed === null || parsed.key !== key) return line
    replaced = true
    // Re-emit the BOM so replacing the first line does not silently strip the
    // file's encoding marker.
    const bom = index === 0 && line.startsWith('\uFEFF') ? '\uFEFF' : ''
    return `${bom}${key}=${value}`
  })
  if (!replaced) next.push(`${key}=${value}`)
  return `${next.join('\n')}\n`
}
