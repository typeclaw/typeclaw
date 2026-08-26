import { describe, expect, test } from 'bun:test'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import path from 'node:path'

import { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS } from '@/agent/tools-without-local-file-operands'
import type { HiddenPaths } from '@/sandbox'

import { checkPrivateSurfaceReadGuard, checkPrivateSurfaceReadIdentityGuard } from './private-surface-read'

const AGENT = '/agent'
const guestHidden: HiddenPaths = {
  dirs: ['/agent/workspace', '/agent/memory', '/agent/sessions'],
  files: ['/agent/.env', '/agent/secrets.json', '/agent/auth.json'],
}
const privilegedHidden: HiddenPaths = { dirs: [], files: [] }

function check(tool: string, args: Record<string, unknown>, hidden: HiddenPaths = guestHidden) {
  return checkPrivateSurfaceReadGuard({ tool, args, agentDir: AGENT, hidden, toolProvenance: 'first-party' })
}

function localOnlyLstat(agentDir: string): (candidate: string) => Stats {
  const canonicalAgentDir = realpathSync.native(agentDir)
  return (candidate) => {
    const relative = path.relative(canonicalAgentDir, candidate)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error('not found in isolated test surface'), { code: 'ENOENT' })
    }
    return lstatSync(candidate)
  }
}

function linuxNameMaxRealpath(candidate: string): string {
  if (Buffer.byteLength(path.basename(candidate), 'utf8') > 255) {
    throw Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' })
  }
  return realpathSync.native(candidate)
}

describe('private-surface-read guard — builtin file tools', () => {
  test('blocks reading a file inside a hidden dir (relative and absolute)', () => {
    expect(check('read', { path: 'workspace/notes.md' })?.block).toBe(true)
    expect(check('read', { path: '/agent/workspace/notes.md' })?.block).toBe(true)
    expect(check('read', { path: 'memory/topics/x.md' })?.block).toBe(true)
    expect(check('read', { path: 'sessions/latest.jsonl' })?.block).toBe(true)
  })

  test('blocks grep/find/ls/edit/write against the hidden surface', () => {
    expect(check('grep', { pattern: 'token', path: 'workspace' })?.block).toBe(true)
    expect(check('find', { path: '/agent/memory' })?.block).toBe(true)
    expect(check('ls', { path: 'sessions' })?.block).toBe(true)
    expect(check('edit', { path: 'workspace/x.ts' })?.block).toBe(true)
    expect(check('write', { path: 'workspace/x.ts' })?.block).toBe(true)
  })
})

describe('private-surface-read guard — fail-closed across ALL tools (not a whitelist)', () => {
  test('allows an EACCES-shadowed path that is NOT on the denied surface', () => {
    // given a runtime uid that cannot traverse an ancestor (container /root is
    // mode 700 while the agent runs as uid 501), so realpath reports EACCES
    // rather than ENOENT for every component under it.
    // The child must NOT be a canonical secret dir: when this test process runs
    // as root, homedir() is /root and `.config/agent-messenger` would be denied
    // lexically, short-circuiting before realpath and testing nothing.
    const barrier = path.resolve(path.sep, 'root')
    const target = path.join(barrier, '.config', 'example-service', 'state.json')
    const internalErrors: unknown[] = []

    // when a tool reads that path
    const result = checkPrivateSurfaceReadGuard(
      { tool: 'read', args: { path: target }, agentDir: AGENT, hidden: guestHidden },
      {
        realpathNative(candidate) {
          if (candidate === barrier || candidate.startsWith(`${barrier}${path.sep}`)) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          }
          return realpathSync.native(candidate)
        },
        onInternalError: (error) => internalErrors.push(error),
      },
    )

    // then it is allowed: the path is neither a secret nor on the deny list, and
    // canonicalization failure alone must not deny it
    expect(result).toBeUndefined()
    expect(internalErrors).toEqual([])
  })

  test('still blocks when the EACCES leaf resolves under a denied directory', () => {
    // given a leaf that cannot be statted but whose parent resolves into memory/
    const parent = path.resolve(AGENT, 'public/gate')
    const leaf = path.join(parent, 'stolen.md')

    const result = checkPrivateSurfaceReadGuard(
      { tool: 'read', args: { path: leaf }, agentDir: AGENT, hidden: guestHidden },
      {
        realpathNative(candidate) {
          if (candidate === leaf) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          if (candidate === parent) return path.resolve(AGENT, 'memory')
          return realpathSync.native(candidate)
        },
      },
    )

    // then the deny-list match still fires — EACCES recovery is not a bypass
    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/memory/)
    expect(result?.reason).not.toMatch(/internal guard error/i)
  })

  for (const code of ['ELOOP', 'ENOTDIR', 'EPERM', 'EIO']) {
    test(`blocks with a generic reason when realpathSync.native reports ${code}`, () => {
      // Must resolve like the guard does: a POSIX literal would not match on Windows.
      const inaccessible = path.resolve(AGENT, 'public/protected.md')
      const error = Object.assign(new Error(`failure while resolving protected path`), { code })
      const internalErrors: unknown[] = []

      const result = checkPrivateSurfaceReadGuard(
        { tool: 'read', args: { path: inaccessible }, agentDir: AGENT, hidden: guestHidden },
        {
          realpathNative(candidate) {
            if (candidate === inaccessible) throw error
            return realpathSync.native(candidate)
          },
          onInternalError: (thrown) => internalErrors.push(thrown),
        },
      )

      expect(result?.block).toBe(true)
      expect(result?.reason).toMatch(/internal guard error/i)
      expect(result?.reason).not.toContain(inaccessible)
      expect(result?.reason).not.toContain(error.message)
      expect(result?.reason).not.toContain(code)
      expect(internalErrors).toEqual([error])
    })
  }

  test('blocks with a generic reason when realpath throws a non-errno error', () => {
    const inaccessible = path.resolve(AGENT, 'public/protected.md')
    const error = new Error('bare failure')

    const result = checkPrivateSurfaceReadGuard(
      { tool: 'read', args: { path: inaccessible }, agentDir: AGENT, hidden: guestHidden },
      {
        realpathNative(candidate) {
          if (candidate === inaccessible) throw error
          return realpathSync.native(candidate)
        },
      },
    )

    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/internal guard error/i)
  })

  test('allows long Korean and English plugin prose without an internal guard error', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-long-plugin-prose-')))
    const koreanBody = '장기 기억에 남길 일반적인 사용자 지침입니다. '.repeat(10)
    const englishBody = 'This is ordinary user guidance that should be written to long-term memory. '.repeat(5)
    const internalErrors: unknown[] = []

    expect(Buffer.byteLength(koreanBody, 'utf8')).toBeGreaterThan(255)
    expect(Buffer.byteLength(englishBody, 'utf8')).toBeGreaterThan(255)
    for (const body of [koreanBody, englishBody]) {
      expect(
        checkPrivateSurfaceReadGuard(
          {
            tool: 'memory_append',
            args: { body },
            agentDir,
            hidden: privilegedHidden,
            fileOperands: { nonFile: ['body'] },
            toolProvenance: 'plugin',
          },
          { realpathNative: linuxNameMaxRealpath, onInternalError: (error) => internalErrors.push(error) },
        ),
      ).toBeUndefined()
    }
    expect(internalErrors).toEqual([])
  })

  test('blocks find_entry reading a hidden transcript via top-level path', () => {
    expect(check('find_entry', { path: '/agent/sessions/s.jsonl', entryId: 'x' })?.block).toBe(true)
  })

  test('blocks look_at reading a hidden file via NESTED images[].path', () => {
    expect(check('look_at', { images: [{ path: '/agent/sessions/s.jsonl' }] })?.block).toBe(true)
    expect(check('look_at', { images: [{ url: 'https://x' }, { path: 'memory/secret.md' }] })?.block).toBe(true)
  })

  test('blocks channel_send / channel_reply exfil of a hidden file via NESTED attachments[].path', () => {
    expect(check('channel_send', { adapter: 'slack-bot', attachments: [{ path: 'workspace/leak.md' }] })?.block).toBe(
      true,
    )
    expect(check('channel_reply', { attachments: [{ path: '/agent/memory/x.md' }] })?.block).toBe(true)
  })

  test('blocks an unknown/future tool that takes a hidden path (no whitelist to slip past)', () => {
    expect(check('some_new_plugin_tool', { input: { nested: { file: 'sessions/x.jsonl' } } })?.block).toBe(true)
  })
})

describe('private-surface-read guard — free-text field scoping (no false positives)', () => {
  test('does not block a bare hidden-dir NAME in a free-text field', () => {
    expect(check('channel_reply', { text: 'memory' })).toBeUndefined()
    expect(check('web_search', { query: 'workspace' })).toBeUndefined()
    expect(check('grep', { pattern: 'sessions', path: 'public' })).toBeUndefined()
    expect(check('look_at_channel_attachment', { prompt: 'sessions' })).toBeUndefined()
  })

  test('does not canonicalize a Korean channel message longer than one filesystem filename', () => {
    const text = '보안 경로 검사와 무관한 Slack 메시지입니다. '.repeat(20)

    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(255)
    expect(check('channel_send', { text })).toBeUndefined()
  })

  test('does not block an identifier-only tool whose remote id equals a hidden dir name', () => {
    // These tools read no local path (shared TOOLS_WITHOUT_LOCAL_FILE_OPERANDS
    // set); an id like workspace/target_id/task_id="memory" must not resolve to
    // /agent/memory and get blocked, mirroring the file-operand scanner's skip.
    expect(check('channel_read', { mode: 'list', adapter: 'slack-bot', workspace: 'memory' })).toBeUndefined()
    expect(
      check('channel_read', { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'sessions' }),
    ).toBeUndefined()
    expect(check('stream_snapshot', { target_kind: 'session', target_id: 'workspace' })).toBeUndefined()
    expect(check('subagent_output', { task_id: 'memory' })).toBeUndefined()
    expect(check('spawn_subagent', { subagent_type: 'memory', prompt: 'x' })).toBeUndefined()
    expect(check('channel_fetch_attachment', { attachment_id: 1, filename: 'memory/foo' })).toBeUndefined()
    expect(
      check('post_github_review', {
        event: 'COMMENT',
        body: 'Review body',
        comments: [{ path: 'memory/foo', line: 1, body: 'Remote repository path' }],
      }),
    ).toBeUndefined()
  })

  test('the shared exemption is tool-scoped: an unknown tool with the same key still fails closed', () => {
    expect(check('plugin_reader', { workspace: 'memory' })?.block).toBe(true)
  })

  test('does not block a path-LIKE value in a free-text field', () => {
    expect(check('channel_reply', { text: 'see workspace/notes.md for details' })).toBeUndefined()
    expect(check('grep', { pattern: 'memory/topics', path: 'public' })).toBeUndefined()
    expect(check('edit', { path: 'public/x.md', edits: [{ oldText: 'workspace/a', newText: 'memory/b' }] })).toBe(
      undefined,
    )
    expect(check('append', { topic: 'workspace', body: 'about memory' })).toBeUndefined()
  })

  test('does not resolve long first-party edit/write prose as canonical paths', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-private-prose-')))
    const longProse = 'x'.repeat(300)
    const internalErrors: unknown[] = []
    const hooks = { onInternalError: (error: unknown) => internalErrors.push(error) }

    expect(
      checkPrivateSurfaceReadGuard(
        {
          tool: 'edit',
          args: { path: path.join(agentDir, 'cron.json'), edits: [{ oldText: longProse, newText: longProse }] },
          agentDir,
          hidden: privilegedHidden,
          toolProvenance: 'first-party',
        },
        hooks,
      ),
    ).toBeUndefined()
    expect(
      checkPrivateSurfaceReadGuard(
        {
          tool: 'write',
          args: { path: path.join(agentDir, 'cron.json'), content: longProse },
          agentDir,
          hidden: privilegedHidden,
          toolProvenance: 'first-party',
        },
        hooks,
      ),
    ).toBeUndefined()
    expect(internalErrors).toEqual([])
  })

  test('blocks write.content safe prose but metadata.content: secrets.json (exact operand-path boundary)', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-operand-boundary-write-')))
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'write',
        args: {
          path: path.join(agentDir, 'report.md'),
          content: 'x'.repeat(300),
          metadata: { content: 'secrets.json' },
        },
        agentDir,
        hidden: privilegedHidden,
        toolProvenance: 'first-party',
      })?.block,
    ).toBe(true)
  })

  test('blocks edit.edits.oldText safe prose but metadata.oldText: secrets.json (exact operand-path boundary)', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-operand-boundary-edit-')))
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'edit',
        args: {
          path: path.join(agentDir, 'report.md'),
          edits: [{ oldText: 'x'.repeat(300), newText: 'replacement' }],
          metadata: { oldText: 'secrets.json' },
        },
        agentDir,
        hidden: privilegedHidden,
        toolProvenance: 'first-party',
      })?.block,
    ).toBe(true)
  })

  test('keeps colliding plugin tools and file URIs in the canonical scan', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'write',
        args: { path: 'public/report.md', content: 'secrets.json' },
        agentDir: AGENT,
        hidden: privilegedHidden,
        toolProvenance: 'plugin',
      })?.block,
    ).toBe(true)
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'edit',
        args: { path: 'public/report.md', edits: [{ oldText: 'secrets.json', newText: 'replacement' }] },
        agentDir: AGENT,
        hidden: privilegedHidden,
        toolProvenance: 'plugin',
      })?.block,
    ).toBe(true)
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'write',
        args: { path: 'public/report.md', content: 'file:///agent/secrets.json' },
        agentDir: AGENT,
        hidden: privilegedHidden,
        toolProvenance: 'first-party',
      })?.block,
    ).toBe(true)
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'channel_read',
        args: { path: 'secrets.json' },
        agentDir: AGENT,
        hidden: privilegedHidden,
        toolProvenance: 'plugin',
      })?.block,
    ).toBe(true)
  })

  test('STILL blocks a hidden path in a genuine path field (scoping did not open a hole)', () => {
    expect(check('read', { path: 'memory' })?.block).toBe(true)
    expect(check('read', { path: 'workspace/notes.md' })?.block).toBe(true)
    expect(check('grep', { pattern: 'token', path: 'sessions' })?.block).toBe(true)
    expect(check('look_at', { images: [{ path: 'memory/x.png' }] })?.block).toBe(true)
    expect(check('channel_send', { text: 'memory', attachments: [{ path: 'sessions/s.jsonl' }] })?.block).toBe(true)
  })

  test('still blocks a hidden channel attachment path when text is free-form', () => {
    expect(
      check('channel_send', {
        text: '보안 경로 검사와 무관한 Slack 메시지입니다. '.repeat(20),
        attachments: [{ path: 'sessions/s.jsonl' }],
      })?.block,
    ).toBe(true)
  })

  test('fail-closed: an UNKNOWN key on an unknown tool is still scanned', () => {
    expect(check('some_new_plugin_tool', { srcPath: 'memory/x' })?.block).toBe(true)
    expect(check('some_new_plugin_tool', { nested: { target: 'workspace/y' } })?.block).toBe(true)
  })

  test('scans filename/filepath keys, file URIs, and nested shapes without scanning prose', () => {
    expect(check('mcp_reader', { input: { filename: 'file:///agent/memory/x.md' } })?.block).toBe(true)
    expect(check('plugin_reader', { payload: [{ filePath: '/agent/sessions/x.jsonl' }] })?.block).toBe(true)
    expect(check('plugin_reader', { description: 'file:///agent/memory/x.md is an example' })?.block).toBe(true)
  })

  test('file URIs override free-text exemptions, including nested MCP url arguments', () => {
    expect(
      check('mcp_call', {
        server: 'files',
        tool: 'read',
        args: { nested: { url: 'file:///agent/secrets.json' } },
      })?.block,
    ).toBe(true)
    expect(check('plugin_tool', { prompt: 'file:///agent/.env' })?.block).toBe(true)
  })

  test('unconditionally blocks virtual and process-backed filesystems and effective aliases', () => {
    for (const candidate of ['/proc/self/environ', '/sys/kernel/notes', '/dev/fd/0', '/run/secrets/token']) {
      expect(check('channel_send', { attachments: [{ path: candidate }] }, privilegedHidden)?.block).toBe(true)
    }
  })

  test('recognizes synthetic POSIX, file URI, Windows-drive, and UNC private paths without host path semantics', () => {
    const windowsHidden: HiddenPaths = {
      dirs: ['C:\\agent\\memory', '\\\\server\\agent\\sessions'],
      files: ['C:\\agent\\secrets.json'],
    }
    expect(check('read', { path: '/agent/memory/x.md' })?.block).toBe(true)
    expect(check('read', { path: 'file:///agent/secrets.json' })?.block).toBe(true)
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'read',
        args: { path: 'C:\\agent\\secrets.json' },
        agentDir: 'C:\\agent',
        hidden: windowsHidden,
      })?.block,
    ).toBe(true)
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'read',
        args: { path: '\\\\server\\agent\\sessions\\turn.jsonl' },
        agentDir: '\\\\server\\agent',
        hidden: windowsHidden,
      })?.block,
    ).toBe(true)
  })

  test('reports synthetic /proc denial before host filesystem lookup', () => {
    const result = check('channel_send', { attachments: [{ path: '/proc/self/environ' }] }, privilegedHidden)
    expect(result?.reason).toMatch(/virtual|process-backed/i)
  })

  test('treats display filenames as metadata rather than file operands', () => {
    expect(check('channel_send', { attachments: [{ path: 'public/x', filename: 'secrets.json' }] })).toBeUndefined()
    expect(check('channel_reply', { attachments: [{ path: 'public/x', filename: '.env' }] })).toBeUndefined()
    expect(check('channel_fetch_attachment', { attachment_id: 1, filename: 'auth.json' })).toBeUndefined()
    expect(check('channel_reply', { attachments: [{ path: 'public/x.md', filename: 'report.pdf' }] })).toBeUndefined()
  })

  test('treats filename as a path for tools where it is not declared display metadata', () => {
    expect(check('plugin_reader', { filename: '/agent/.env' })?.block).toBe(true)
  })

  test('still blocks a hidden attachments[].path when the filename itself is public', () => {
    expect(
      check('channel_send', {
        attachments: [{ path: 'memory/leak.md', filename: 'report.pdf' }],
      })?.block,
    ).toBe(true)
  })
})

describe('private-surface-read guard — grep/find glob path-filters are scanned', () => {
  test('blocks a grep glob that reaches a hidden subtree (non-hidden search root)', () => {
    expect(check('grep', { pattern: 'x', path: '.', glob: 'workspace/**' })?.block).toBe(true)
    expect(check('grep', { pattern: 'x', glob: 'memory/**' })?.block).toBe(true)
    expect(check('grep', { pattern: 'x', path: 'public', glob: 'sessions/*.jsonl' })?.block).toBe(true)
    expect(check('grep', { pattern: 'x', path: 'public', glob: 'workspace/*.md' })?.block).toBe(true)
  })

  test('blocks a find pattern that reaches a hidden subtree (find.pattern is a glob)', () => {
    expect(check('find', { path: '.', pattern: 'workspace/**' })?.block).toBe(true)
    expect(check('find', { pattern: 'memory/**' })?.block).toBe(true)
  })

  test('allows a grep glob that does not select a hidden subtree (no false positive)', () => {
    expect(check('grep', { pattern: 'token', path: 'public', glob: '*.ts' })).toBeUndefined()
    expect(check('grep', { pattern: 'token', path: 'public', glob: '**/*.spec.ts' })).toBeUndefined()
  })

  test('grep.pattern (a regex, not a path) is still exempt from scanning', () => {
    expect(check('grep', { pattern: 'sessions' })).toBeUndefined()
    expect(check('grep', { pattern: 'memory', path: 'public' })).toBeUndefined()
  })

  test('a future tool with a pattern key is NOT exempt (fail-closed)', () => {
    expect(check('some_search_tool', { pattern: 'workspace/x' })?.block).toBe(true)
  })
})

describe('private-surface-read guard — false-positive control', () => {
  test('does not block prose args that merely mention a dir name without a separator', () => {
    expect(check('channel_send', { text: 'tell me about the workspace and memory' })).toBeUndefined()
    expect(check('find_entry', { entryId: 'sessions-summary', path: 'public/x.jsonl' })).toBeUndefined()
  })

  test('does not block a sibling dir that only prefix-matches a hidden name', () => {
    expect(check('read', { path: 'workspace-notes/x.md' })).toBeUndefined()
    expect(check('read', { path: 'sessions-archive/x.md' })).toBeUndefined()
  })

  test('allows reads outside the hidden surface', () => {
    expect(check('read', { path: 'public/readme.md' })).toBeUndefined()
    expect(check('read', { path: '/agent/node_modules/x/index.js' })).toBeUndefined()
  })

  test('a guest may read, write, and list the public/ zone', () => {
    expect(check('read', { path: 'public/notes.md' })).toBeUndefined()
    expect(check('write', { path: 'public/report.md' })).toBeUndefined()
    expect(check('ls', { path: 'public' })).toBeUndefined()
    expect(check('ls', { path: '/agent/public' })).toBeUndefined()
  })
})

describe('private-surface-read guard — traversal + scope', () => {
  test('defeats path traversal back into a hidden dir', () => {
    expect(check('read', { path: 'public/../workspace/x' })?.block).toBe(true)
    expect(check('read', { path: './workspace/./x' })?.block).toBe(true)
  })

  test('blocks traversal-normalized canonical secrets before resolving an oversized component', () => {
    const oversized = 'x'.repeat(300)
    const internalErrors: unknown[] = []
    const result = checkPrivateSurfaceReadGuard(
      {
        tool: 'plugin_reader',
        args: { value: `${oversized}/../secrets.json` },
        agentDir: AGENT,
        hidden: privilegedHidden,
        toolProvenance: 'plugin',
      },
      { realpathNative: linuxNameMaxRealpath, onInternalError: (error) => internalErrors.push(error) },
    )

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('secrets.json')
    expect(result?.reason).not.toMatch(/internal guard error/i)
    expect(internalErrors).toEqual([])
  })

  test('covers the secret files across ALL tools (one deny-list, not delegated to secretExfilRead)', () => {
    expect(check('read', { path: '/agent/.env' })?.block).toBe(true)
    expect(check('read', { path: '.env' })?.block).toBe(true)
    expect(check('edit', { path: '/agent/.env' })?.block).toBe(true)
    expect(check('write', { path: 'secrets.json' })?.block).toBe(true)
    expect(check('look_at', { images: [{ path: '/agent/secrets.json' }] })?.block).toBe(true)
    expect(check('channel_send', { attachments: [{ path: '/agent/.env' }] })?.block).toBe(true)
    expect(check('read', { path: '/agent/auth.json' })?.block).toBe(true)
  })

  test('a secret file matches exactly, not by prefix (.env does not block .envrc-style siblings)', () => {
    expect(check('read', { path: '/agent/.environment' })).toBeUndefined()
    expect(check('read', { path: '/agent/secrets.json.bak' })).toBeUndefined()
    expect(check('read', { path: '/agent/auth.json.bak' })).toBeUndefined()
  })

  test('privileged roles may read private directories but never runtime-owned credential stores', () => {
    expect(check('read', { path: 'workspace/notes.md' }, privilegedHidden)).toBeUndefined()
    expect(check('look_at', { images: [{ path: 'workspace/x' }] }, privilegedHidden)).toBeUndefined()
    expect(check('read', { path: '.env' }, privilegedHidden)?.block).toBe(true)
    expect(check('grep', { pattern: 'token', path: '/agent/secrets.json' }, privilegedHidden)?.block).toBe(true)
    expect(check('find', { path: '.', pattern: 'secrets.json' }, privilegedHidden)?.block).toBe(true)
    expect(check('ls', { path: '/agent/.env' }, privilegedHidden)?.block).toBe(true)
    expect(check('read', { path: '/agent/auth.json' }, privilegedHidden)?.block).toBe(true)
    expect(
      check('read', { path: '/agent/workspace/.agent-messenger/slack-credentials.json' }, privilegedHidden)?.block,
    ).toBe(true)
    expect(check('read', { path: '/agent/workspace/.config' }, privilegedHidden)).toBeUndefined()
    expect(
      check('read', { path: '/agent/workspace/.config/agent-messenger/instagram/session.json' }, privilegedHidden),
    ).toBeUndefined()
    expect(check('read', { path: '/agent/workspace/.config/gws/credentials.json' }, privilegedHidden)).toBeUndefined()
    expect(check('read', { path: '/agent/workspace/.config/gws/credentials.json' })?.block).toBe(true)
    expect(check('read', { path: '/agent/workspace/.config/agent-messenger/slack-credentials.json' })?.block).toBe(true)
    expect(
      check('read', { path: '/agent/workspace/.config/agent-messenger-backup/session.json' }, privilegedHidden),
    ).toBeUndefined()
    // Upgraded agents may retain the old bind-mounted credential overlay. It
    // remains canonical-secret territory even though new boots no longer use it.
    expect(check('read', { path: '/agent/.typeclaw/home/.codex/auth.json' }, privilegedHidden)?.block).toBe(true)
  })

  test('canonical HOME credential profiles are denied to privileged non-bash tools', () => {
    expect(check('read', { path: path.join(homedir(), '.gitconfig') }, privilegedHidden)?.block).toBe(true)
    expect(check('read', { path: path.join(homedir(), '.codex', 'auth.json') }, privilegedHidden)?.block).toBe(true)
    expect(check('read', { path: path.join(homedir(), '.claude', '.credentials.json') }, privilegedHidden)?.block).toBe(
      true,
    )
    expect(check('read', { path: '/home/agent/.codex/auth.json' }, privilegedHidden)?.block).toBe(true)
    expect(check('read', { path: '/home/agent/.claude/.credentials.json' }, privilegedHidden)?.block).toBe(true)
    expect(check('read', { path: '/home/agent/.config/gh/hosts.yml' }, privilegedHidden)?.block).toBe(true)
    expect(check('read', { path: path.join(homedir(), '.config', 'gh', 'hosts.yml') }, privilegedHidden)?.block).toBe(
      true,
    )
    expect(
      check('read', { path: path.join(homedir(), '.config', 'agent-messenger', 'credentials.json') }, privilegedHidden)
        ?.block,
    ).toBe(true)
    expect(
      check(
        'read',
        { path: path.join(homedir(), '.config', 'agent-messenger-backup', 'credentials.json') },
        privilegedHidden,
      ),
    ).toBeUndefined()
  })

  test('bash is never blocked here (its access is contained by the bwrap sandbox)', () => {
    expect(check('bash', { command: 'cat workspace/notes.md' })).toBeUndefined()
  })
})

describe('private-surface-read guard — symlink bypass defense', () => {
  // Real filesystem: the bug is that lexical path.resolve does not follow
  // symlinks. A guest plants public/leak -> ../<hidden> via sandboxed bash,
  // then reads it back through a non-bash tool whose path lexically lands in
  // guest-visible public/. The guard must realpath the candidate and catch it.
  function makeAgentWithSymlinks(): { agentDir: string; hidden: HiddenPaths } {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-symlink-guard-')))
    for (const dir of ['workspace', 'memory', 'sessions', 'public']) {
      mkdirSync(path.join(agentDir, dir), { recursive: true })
    }
    writeFileSync(path.join(agentDir, '.env'), 'SECRET=1')
    writeFileSync(path.join(agentDir, 'memory', 'topic.md'), 'private')
    symlinkSync(path.join(agentDir, '.env'), path.join(agentDir, 'public', 'env-link'))
    symlinkSync(path.join(agentDir, 'memory'), path.join(agentDir, 'public', 'mem-link'))
    return {
      agentDir,
      hidden: {
        dirs: ['workspace', 'memory', 'sessions'].map((d) => path.join(agentDir, d)),
        files: ['.env', 'secrets.json', 'auth.json'].map((f) => path.join(agentDir, f)),
      },
    }
  }

  test('blocks a non-bash read of a public/ symlink pointing at a hidden FILE', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    const result = checkPrivateSurfaceReadGuard({ tool: 'read', args: { path: 'public/env-link' }, agentDir, hidden })
    expect(result?.block).toBe(true)
  })

  test('blocks a privileged non-bash read through a symlink to a canonical secret file', () => {
    const { agentDir } = makeAgentWithSymlinks()
    const result = checkPrivateSurfaceReadGuard({
      tool: 'read',
      args: { path: 'public/env-link' },
      agentDir,
      hidden: privilegedHidden,
    })
    expect(result?.block).toBe(true)
  })

  test('blocks a privileged non-bash read through a hardlink alias to a canonical secret file', () => {
    const { agentDir } = makeAgentWithSymlinks()
    const alias = path.join(agentDir, 'public', 'env-hardlink')
    linkSync(path.join(agentDir, '.env'), alias)
    const result = checkPrivateSurfaceReadGuard({
      tool: 'read',
      args: { path: alias },
      agentDir,
      hidden: privilegedHidden,
    })
    expect(result?.block).toBe(true)
  })

  test('blocks a privileged hardlink alias to historical root auth.json', () => {
    const { agentDir } = makeAgentWithSymlinks()
    writeFileSync(path.join(agentDir, 'auth.json'), 'legacy-secret')
    const alias = path.join(agentDir, 'public', 'auth-hardlink')
    linkSync(path.join(agentDir, 'auth.json'), alias)
    const result = checkPrivateSurfaceReadGuard({
      tool: 'read',
      args: { path: alias },
      agentDir,
      hidden: privilegedHidden,
    })
    expect(result?.block).toBe(true)
  })

  test('blocks a hardlink alias of a file below a denied directory', () => {
    const { agentDir } = makeAgentWithSymlinks()
    const source = path.join(agentDir, 'workspace', '.agent-messenger', 'nested-token')
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, 'secret')
    const alias = path.join(agentDir, 'public', 'nested-hardlink')
    linkSync(source, alias)
    expect(
      checkPrivateSurfaceReadGuard({ tool: 'read', args: { path: alias }, agentDir, hidden: privilegedHidden })?.block,
    ).toBe(true)
  })

  test('allows unrelated public hardlinks', () => {
    const { agentDir } = makeAgentWithSymlinks()
    const source = path.join(agentDir, 'public', 'report-a.md')
    const alias = path.join(agentDir, 'public', 'report-b.md')
    writeFileSync(source, 'public')
    linkSync(source, alias)
    expect(
      checkPrivateSurfaceReadGuard(
        { tool: 'read', args: { path: alias }, agentDir, hidden: privilegedHidden },
        { openDirectory: opendirSync, lstat: localOnlyLstat(agentDir) },
      ),
    ).toBeUndefined()
  })

  test('blocks a non-bash read THROUGH a public/ symlink pointing at a hidden DIR', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    // public/mem-link -> memory/, so public/mem-link/topic.md resolves into memory/
    const result = checkPrivateSurfaceReadGuard({
      tool: 'read',
      args: { path: 'public/mem-link/topic.md' },
      agentDir,
      hidden,
    })
    expect(result?.block).toBe(true)
  })

  test('blocks an oversized tail below a symlink prefix into a hidden directory', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    const oversized = '기억'.repeat(50)
    const internalErrors: unknown[] = []

    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(255)
    const result = checkPrivateSurfaceReadGuard(
      {
        tool: 'plugin_reader',
        args: { value: path.join('public', 'mem-link', oversized) },
        agentDir,
        hidden,
        toolProvenance: 'plugin',
      },
      { realpathNative: linuxNameMaxRealpath, onInternalError: (error) => internalErrors.push(error) },
    )

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain(path.join(agentDir, 'memory'))
    expect(result?.reason).not.toMatch(/internal guard error/i)
    expect(internalErrors).toEqual([])
  })

  test('blocks the symlink via a NESTED arg shape (look_at images[].path)', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    const result = checkPrivateSurfaceReadGuard({
      tool: 'look_at',
      args: { images: [{ path: 'public/env-link' }] },
      agentDir,
      hidden,
    })
    expect(result?.block).toBe(true)
  })

  test.skipIf(process.platform !== 'linux')('blocks an effective public symlink alias into procfs', () => {
    const { agentDir } = makeAgentWithSymlinks()
    symlinkSync('/proc', path.join(agentDir, 'public', 'proc-link'))
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'read',
        args: { path: 'public/proc-link/self/environ' },
        agentDir,
        hidden: privilegedHidden,
      })?.block,
    ).toBe(true)
  })

  test('still ALLOWS a genuine non-symlink file inside public/', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    writeFileSync(path.join(agentDir, 'public', 'real.md'), 'shareable')
    const result = checkPrivateSurfaceReadGuard({ tool: 'read', args: { path: 'public/real.md' }, agentDir, hidden })
    expect(result).toBeUndefined()
  })
})

describe('private-surface-read guard — bounded hardlink identity proof', () => {
  function makeHardlinkFixture(): { agentDir: string; source: string; alias: string } {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-proof-')))
    const source = path.join(agentDir, 'source.txt')
    const alias = path.join(agentDir, 'alias.txt')
    writeFileSync(source, 'public')
    linkSync(source, alias)
    return { agentDir, source, alias }
  }

  test('rejects an inode matching a denied file', () => {
    const { agentDir, source, alias } = makeHardlinkFixture()
    expect(
      checkPrivateSurfaceReadIdentityGuard({
        tool: 'read',
        agentDir,
        hidden: { dirs: [], files: [source] },
        identity: statSync(alias),
      })?.block,
    ).toBe(true)
  })

  test('rejects an inode with an alias below a denied directory', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-denied-dir-')))
    const hiddenDir = path.join(agentDir, 'memory')
    const publicDir = path.join(agentDir, 'public')
    mkdirSync(hiddenDir)
    mkdirSync(publicDir)
    const hidden = path.join(hiddenDir, 'secret.txt')
    const alias = path.join(publicDir, 'alias.txt')
    writeFileSync(hidden, 'private')
    linkSync(hidden, alias)
    expect(
      checkPrivateSurfaceReadIdentityGuard({
        tool: 'read',
        agentDir,
        hidden: { dirs: [hiddenDir], files: [] },
        identity: statSync(alias),
      })?.block,
    ).toBe(true)
  })

  test('accepts a fully-accounted ordinary multi-link inode', () => {
    const { agentDir, alias } = makeHardlinkFixture()
    expect(
      checkPrivateSurfaceReadIdentityGuard(
        {
          tool: 'read',
          agentDir,
          hidden: privilegedHidden,
          identity: statSync(alias),
        },
        { openDirectory: opendirSync, lstat: localOnlyLstat(agentDir) },
      ),
    ).toBeUndefined()
  })

  test('does not count the same visible directory entry twice toward nlink', () => {
    const externalDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-duplicate-external-')))
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-duplicate-agent-')))
    const external = path.join(externalDir, 'external.txt')
    const visible = path.join(agentDir, 'visible.txt')
    writeFileSync(external, 'shared')
    linkSync(external, visible)
    const visibleEntry = readdirSync(agentDir, { withFileTypes: true }).find((entry) => entry.name === 'visible.txt')
    if (visibleEntry === undefined) throw new Error('test fixture entry missing')

    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(visible) },
        {
          lstat: localOnlyLstat(agentDir),
          openDirectory() {
            let reads = 0
            return {
              readSync() {
                reads += 1
                return reads <= 2 ? visibleEntry : null
              },
              closeSync() {},
            }
          },
        },
      )?.block,
    ).toBe(true)
  })

  test('rejects one visible link renamed between observations while an external alias remains unscanned', () => {
    const externalDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-rename-external-')))
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-rename-agent-')))
    const external = path.join(externalDir, 'external.txt')
    const beforeRename = path.join(agentDir, 'before.txt')
    const afterRename = path.join(agentDir, 'after.txt')
    writeFileSync(external, 'shared')
    linkSync(external, beforeRename)
    const beforeEntry = readdirSync(agentDir, { withFileTypes: true }).find((entry) => entry.name === 'before.txt')
    if (beforeEntry === undefined) throw new Error('test fixture entry missing')

    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(beforeRename) },
        {
          lstat: localOnlyLstat(agentDir),
          openDirectory() {
            let reads = 0
            return {
              readSync() {
                reads += 1
                if (reads === 1) return beforeEntry
                if (reads === 2) {
                  renameSync(beforeRename, afterRename)
                  return (
                    readdirSync(agentDir, { withFileTypes: true }).find((entry) => entry.name === 'after.txt') ?? null
                  )
                }
                return null
              },
              closeSync() {},
            }
          },
        },
      )?.block,
    ).toBe(true)
  })

  test('rejects one visible link moved from a scanned sibling into a pending sibling', () => {
    const externalDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-move-external-')))
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-move-agent-')))
    const scannedDir = path.join(agentDir, 'scanned')
    const pendingDir = path.join(agentDir, 'pending')
    const external = path.join(externalDir, 'external.txt')
    const beforeMove = path.join(scannedDir, 'visible.txt')
    const afterMove = path.join(pendingDir, 'visible.txt')
    mkdirSync(scannedDir)
    mkdirSync(pendingDir)
    writeFileSync(external, 'shared')
    linkSync(external, beforeMove)
    const rootEntries = readdirSync(agentDir, { withFileTypes: true })
    const scannedEntry = rootEntries.find((entry) => entry.name === 'scanned')
    const pendingEntry = rootEntries.find((entry) => entry.name === 'pending')
    const visibleEntry = readdirSync(scannedDir, { withFileTypes: true }).find((entry) => entry.name === 'visible.txt')
    if (scannedEntry === undefined || pendingEntry === undefined || visibleEntry === undefined) {
      throw new Error('test fixture entry missing')
    }

    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(beforeMove) },
        {
          lstat: localOnlyLstat(agentDir),
          openDirectory(directory) {
            if (directory === agentDir) {
              const entries = [pendingEntry, scannedEntry]
              let index = 0
              return { readSync: () => entries[index++] ?? null, closeSync() {} }
            }
            if (directory === scannedDir) {
              let read = false
              return {
                readSync() {
                  if (read) return null
                  read = true
                  return visibleEntry
                },
                closeSync() {
                  renameSync(beforeMove, afterMove)
                },
              }
            }
            let read = false
            return {
              readSync() {
                if (read) return null
                read = true
                return (
                  readdirSync(pendingDir, { withFileTypes: true }).find((entry) => entry.name === 'visible.txt') ?? null
                )
              },
              closeSync() {},
            }
          },
        },
      )?.block,
    ).toBe(true)
  })

  test.skipIf(process.platform === 'linux')('fails closed without a descriptor traversal seam off Linux', () => {
    const { agentDir, alias } = makeHardlinkFixture()
    expect(
      checkPrivateSurfaceReadIdentityGuard({
        tool: 'read',
        agentDir,
        hidden: privilegedHidden,
        identity: statSync(alias),
      })?.block,
    ).toBe(true)
  })

  test('does not count a regular entry swapped to a symlink during the scan', () => {
    const externalDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-external-')))
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-swap-')))
    const source = path.join(externalDir, 'source.txt')
    const alias = path.join(agentDir, 'alias.txt')
    const decoy = path.join(agentDir, 'decoy.txt')
    writeFileSync(source, 'outside')
    linkSync(source, alias)
    writeFileSync(decoy, 'decoy')

    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(alias) },
        {
          openDirectory(directory) {
            const entries = readdirSync(directory, { withFileTypes: true })
            let index = 0
            return {
              readSync() {
                const entry = entries[index++] ?? null
                if (entry?.name === 'decoy.txt') {
                  unlinkSync(decoy)
                  symlinkSync(source, decoy)
                }
                return entry
              },
              closeSync() {},
            }
          },
        },
      )?.block,
    ).toBe(true)
  })

  test.skipIf(process.platform !== 'linux')('fails closed when a discovered directory is swapped to a symlink', () => {
    const externalDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-dir-swap-external-')))
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-dir-swap-agent-')))
    const visibleDir = path.join(agentDir, 'visible')
    const parkedDir = path.join(externalDir, 'parked')
    const first = path.join(visibleDir, 'first.txt')
    const second = path.join(visibleDir, 'second.txt')
    mkdirSync(visibleDir)
    writeFileSync(first, 'public')
    linkSync(first, second)
    let swapped = false

    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(first) },
        {
          afterEntryLstat(candidate, stats) {
            if (swapped || candidate !== visibleDir || !stats.isDirectory()) return
            swapped = true
            renameSync(visibleDir, parkedDir)
            symlinkSync(parkedDir, visibleDir)
          },
        },
      )?.block,
    ).toBe(true)
  })

  test('scans denied trees before accepting duplicated visible identity counts', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-denied-first-')))
    const hiddenDir = path.join(agentDir, 'memory')
    const visible = path.join(agentDir, 'visible.txt')
    const hidden = path.join(hiddenDir, 'hidden.txt')
    mkdirSync(hiddenDir)
    writeFileSync(visible, 'shared')
    linkSync(visible, hidden)

    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: { dirs: [hiddenDir], files: [] }, identity: statSync(visible) },
        {
          openDirectory(directory) {
            const entries = readdirSync(directory, { withFileTypes: true })
            const visibleEntry = entries.find((entry) => entry.name === 'visible.txt')
            const queued = directory === agentDir && visibleEntry !== undefined ? [...entries, visibleEntry] : entries
            let index = 0
            return {
              readSync() {
                return queued[index++] ?? null
              },
              closeSync() {},
            }
          },
        },
      )?.block,
    ).toBe(true)
  })

  test('shares one entry budget and inventory across every candidate in a guard call', () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-hardlink-aggregate-')))
    const first = path.join(agentDir, 'first.txt')
    const firstAlias = path.join(agentDir, 'first-alias.txt')
    const second = path.join(agentDir, 'second.txt')
    const secondAlias = path.join(agentDir, 'second-alias.txt')
    writeFileSync(first, 'first')
    linkSync(first, firstAlias)
    writeFileSync(second, 'second')
    linkSync(second, secondAlias)

    let reads = 0
    const maxEntries = 4
    const result = checkPrivateSurfaceReadGuard(
      { tool: 'plugin_reader', args: { first, second }, agentDir, hidden: privilegedHidden },
      {
        maxEntries,
        lstat: localOnlyLstat(agentDir),
        openDirectory(directory) {
          const reader = opendirSync(directory)
          return {
            readSync() {
              reads += 1
              return reader.readSync()
            },
            closeSync() {
              reader.closeSync()
            },
          }
        },
      },
    )

    expect(result).toBeUndefined()
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(maxEntries + 1)
  })

  test('fails closed when the entry budget is exhausted', () => {
    const { agentDir, alias } = makeHardlinkFixture()
    writeFileSync(path.join(agentDir, 'unrelated.txt'), 'x')
    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(alias) },
        { maxEntries: 1 },
      )?.reason,
    ).toMatch(/bounded|entry|hardlink/i)
  })

  test('fails closed when a scanned directory cannot be read', () => {
    const { agentDir, alias } = makeHardlinkFixture()
    expect(
      checkPrivateSurfaceReadIdentityGuard(
        { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(alias) },
        {
          openDirectory() {
            const error = new Error('denied')
            Object.assign(error, { code: 'EACCES' })
            throw error
          },
        },
      )?.reason,
    ).toMatch(/bounded|read|hardlink/i)
  })

  test('stops pulling directory entries when the shared budget is exceeded', () => {
    const { agentDir, alias } = makeHardlinkFixture()
    const unrelated = path.join(agentDir, 'unrelated.txt')
    writeFileSync(unrelated, 'x')
    const unrelatedEntry = readdirSync(agentDir, { withFileTypes: true }).find(
      (entry) => entry.name === 'unrelated.txt',
    )
    if (!unrelatedEntry) throw new Error('test fixture entry missing')

    let reads = 0
    let closes = 0
    const maxEntries = 3
    const fakeEntryCount = 10_000
    const result = checkPrivateSurfaceReadIdentityGuard(
      { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(alias) },
      {
        maxEntries,
        openDirectory() {
          return {
            readSync() {
              reads += 1
              return reads <= fakeEntryCount ? unrelatedEntry : null
            },
            closeSync() {
              closes += 1
            },
          }
        },
      },
    )

    expect(result?.reason).toMatch(/bounded|entry|hardlink/i)
    expect(reads).toBeLessThanOrEqual(maxEntries + 1)
    expect(closes).toBe(1)
  })

  test('closes the directory handle when an incremental read fails', () => {
    const { agentDir, alias } = makeHardlinkFixture()
    let closes = 0

    const result = checkPrivateSurfaceReadIdentityGuard(
      { tool: 'read', agentDir, hidden: privilegedHidden, identity: statSync(alias) },
      {
        openDirectory() {
          return {
            readSync() {
              throw new Error('read failed')
            },
            closeSync() {
              closes += 1
            },
          }
        },
      },
    )

    expect(result?.reason).toMatch(/bounded|read|hardlink/i)
    expect(closes).toBe(1)
  })
})

describe('private-surface-read guard — honors a tool author fileOperands.nonFile declaration', () => {
  for (const key of ['query', 'text', 'content', 'name']) {
    test(`blocks a canonical credential filename under prose key ${key} without file operands`, () => {
      expect(
        checkPrivateSurfaceReadGuard({
          tool: 'plugin_reader',
          args: { [key]: 'secrets.json' },
          agentDir: AGENT,
          hidden: privilegedHidden,
        })?.block,
      ).toBe(true)
    })
  }

  test('blocks a canonical credential filename at an exact declared nonFile operand', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { query: 'secrets.json' },
        agentDir: AGENT,
        hidden: privilegedHidden,
        fileOperands: { nonFile: ['query'] },
      })?.block,
    ).toBe(true)
  })

  test('blocks canonical secret files and directories despite declared nonFile operands', () => {
    for (const value of ['secrets.json', '.env', '.typeclaw/home/credentials.json']) {
      expect(
        checkPrivateSurfaceReadGuard({
          tool: 'unknown_plugin_reader',
          args: { value },
          agentDir: AGENT,
          hidden: privilegedHidden,
          fileOperands: { nonFile: ['value'] },
          toolProvenance: 'plugin',
        })?.block,
      ).toBe(true)
    }
  })

  test('blocks a colliding channel_send plugin local text operand from reading a canonical credential', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'channel_send',
        args: { text: 'secrets.json' },
        agentDir: AGENT,
        hidden: privilegedHidden,
        toolProvenance: 'plugin',
        fileOperands: { input: ['text'] },
      })?.block,
    ).toBe(true)
  })

  test('skips a declared nonFile operand colliding with a hidden dir', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { tenant: 'memory' },
        agentDir: AGENT,
        hidden: guestHidden,
        fileOperands: { nonFile: ['tenant'] },
      }),
    ).toBeUndefined()
  })

  test('is scoped by exact operand path: an undeclared key still blocks', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { tenant: 'ok', region: 'memory' },
        agentDir: AGENT,
        hidden: guestHidden,
        fileOperands: { nonFile: ['tenant'] },
      })?.block,
    ).toBe(true)
  })

  test('never exempts input/output/destructive: a declared real-file input under a hidden dir still blocks', () => {
    // nonFile skips the scan; input is a REAL file that must still be blocked
    // when it resolves into the private surface — otherwise a declared input
    // becomes a read-back channel for exactly what the bash masks deny.
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { path: 'memory/secret.md' },
        agentDir: AGENT,
        hidden: guestHidden,
        fileOperands: { input: ['path'], nonFile: ['tenant'] },
      })?.block,
    ).toBe(true)
  })

  const declaredProseOperandCases = [
    { category: 'input', key: 'query', value: 'memory/secret.txt' },
    { category: 'output', key: 'name', value: 'memory/out.txt' },
    { category: 'create', key: 'title', value: 'memory/new.txt' },
    { category: 'destructive', key: 'content', value: 'memory/gone.txt' },
  ] as const

  for (const { category, key, value } of declaredProseOperandCases) {
    test(`blocks a declared ${category} operand under prose key ${key}`, () => {
      expect(
        checkPrivateSurfaceReadGuard({
          tool: 'plugin_reader',
          args: { [key]: value },
          agentDir: AGENT,
          hidden: guestHidden,
          fileOperands: { [category]: [key] },
        })?.block,
      ).toBe(true)
    })
  }

  test('local input takes precedence when the same path is also declared nonFile', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { query: 'memory/secret.txt' },
        agentDir: AGENT,
        hidden: guestHidden,
        fileOperands: { input: ['query'], nonFile: ['query'] },
      })?.block,
    ).toBe(true)
  })

  test('declared local input overrides a first-party write prose exemption for canonical secrets', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'write',
        args: { path: 'public/report.md', content: 'secrets.json' },
        agentDir: AGENT,
        hidden: privilegedHidden,
        fileOperands: { input: ['content'] },
        toolProvenance: 'first-party',
      })?.block,
    ).toBe(true)
  })

  test('keeps a nonFile-only operand exempt from private-surface scanning', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { query: 'memory/secret.txt' },
        agentDir: AGENT,
        hidden: guestHidden,
        fileOperands: { nonFile: ['query'] },
      }),
    ).toBeUndefined()
  })

  test('keeps an ordinary hidden directory name exempt under a prose nonFile operand', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { query: 'memory' },
        agentDir: AGENT,
        hidden: guestHidden,
        fileOperands: { nonFile: ['query'] },
      }),
    ).toBeUndefined()
  })

  test('keeps an undeclared prose key exempt from private-surface scanning', () => {
    expect(
      checkPrivateSurfaceReadGuard({
        tool: 'plugin_reader',
        args: { query: 'memory/secret.txt' },
        agentDir: AGENT,
        hidden: guestHidden,
      }),
    ).toBeUndefined()
  })
})

describe('private-surface-read guard — shared exemption set stays in sync with the file-operand scanner', () => {
  test('every TOOLS_WITHOUT_LOCAL_FILE_OPERANDS tool is skipped here too', () => {
    // Drift fence: the two enforcement points share one set. If a tool is added
    // to the scanner's exempt set but this guard still resolved its id args as
    // paths, a value equal to a hidden dir would be blocked here — the exact
    // divergence this coupling prevents.
    for (const tool of TOOLS_WITHOUT_LOCAL_FILE_OPERANDS) {
      expect(check(tool, { workspace: 'memory', target_id: 'sessions', task_id: 'workspace' })).toBeUndefined()
    }
  })
})
