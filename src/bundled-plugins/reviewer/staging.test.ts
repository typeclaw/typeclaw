import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { extractTarGzSafely, stageGithubPr, StagingError } from './staging'

type TarSpec = { name: string; typeflag?: string; data?: string }

function tarHeader(spec: TarSpec): Buffer {
  const block = Buffer.alloc(512, 0)
  block.write(spec.name, 0, 100, 'utf8')
  const data = spec.data ?? ''
  const size = Buffer.byteLength(data)
  block.write('0000777\0', 100, 8, 'utf8')
  block.write('0000000\0', 108, 8, 'utf8')
  block.write('0000000\0', 116, 8, 'utf8')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  block.write('00000000000\0', 136, 12, 'utf8')
  block[156] = (spec.typeflag ?? '0').charCodeAt(0)
  block.write('ustar\0', 257, 6, 'utf8')
  block.write('00', 263, 2, 'utf8')
  // checksum: fill spaces, sum bytes, write octal
  block.fill(' ', 148, 156)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += block[i] ?? 0
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return block
}

function makeTarGz(specs: TarSpec[]): Buffer {
  const blocks: Buffer[] = []
  for (const spec of specs) {
    blocks.push(tarHeader(spec))
    const data = spec.data ?? ''
    if (data.length > 0) {
      const dataBlock = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512, 0)
      dataBlock.write(data, 0, 'utf8')
      blocks.push(dataBlock)
    }
  }
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks))
}

const TOP = 'repo-abc123'

describe('extractTarGzSafely', () => {
  async function freshDest(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'staging-test-'))
    return join(root, 'repo')
  }

  test('happy path: extracts regular files, strips top-level dir', async () => {
    const dest = await freshDest()
    const gz = makeTarGz([
      { name: `${TOP}/`, typeflag: '5' },
      { name: `${TOP}/src/`, typeflag: '5' },
      { name: `${TOP}/src/index.ts`, data: 'export const x = 1\n' },
      { name: `${TOP}/README.md`, data: '# hi\n' },
    ])

    await extractTarGzSafely(gz, dest)

    expect(await readFile(join(dest, 'src/index.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(await readFile(join(dest, 'README.md'), 'utf8')).toBe('# hi\n')
    expect(existsSync(join(dest, TOP))).toBe(false)
  })

  test('rejects parent-traversal entry', async () => {
    const dest = await freshDest()
    const gz = makeTarGz([{ name: `${TOP}/../escape.txt`, data: 'pwned' }])
    await expect(extractTarGzSafely(gz, dest)).rejects.toThrow(StagingError)
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false)
  })

  test('rejects absolute path entry', async () => {
    const dest = await freshDest()
    const gz = makeTarGz([{ name: `/etc/evil`, data: 'pwned' }])
    await expect(extractTarGzSafely(gz, dest)).rejects.toThrow(/absolute/i)
  })

  test('rejects symlink entry', async () => {
    const dest = await freshDest()
    const gz = makeTarGz([{ name: `${TOP}/link`, typeflag: '2', data: '/etc/passwd' }])
    await expect(extractTarGzSafely(gz, dest)).rejects.toThrow(/typeflag|unsafe/i)
  })

  test('rejects hardlink entry', async () => {
    const dest = await freshDest()
    const gz = makeTarGz([{ name: `${TOP}/hard`, typeflag: '1', data: 'x' }])
    await expect(extractTarGzSafely(gz, dest)).rejects.toThrow(/typeflag|unsafe/i)
  })
})

describe('stageGithubPr', () => {
  const TOKEN = 'fake-test-token-do-not-scan'

  function okTarResponse(): Response {
    const gz = makeTarGz([{ name: `${TOP}/a.ts`, data: 'const a = 1\n' }])
    return new Response(new Uint8Array(gz), { status: 200 })
  }

  test('uses headSha when provided, stages tree, returns mount contract', async () => {
    const calls: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        auth: new Headers(init?.headers).get('Authorization'),
      })
      return okTarResponse()
    }) as unknown as typeof fetch

    const staged = await stageGithubPr({
      target: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 7, headSha: 'deadbeef' },
      token: TOKEN,
      fetchImpl,
    })

    try {
      expect(staged.sandboxPath).toBe('/work')
      expect(staged.headSha).toBe('deadbeef')
      expect(existsSync(staged.hostPath)).toBe(true)
      expect(await readFile(join(staged.hostPath, 'a.ts'), 'utf8')).toBe('const a = 1\n')
      expect(calls[0]?.url).toContain('/repos/o/r/tarball/deadbeef')
      expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`)
    } finally {
      await staged.dispose()
    }
  })

  test('resolves headSha from PR metadata when omitted', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = url.toString()
      urls.push(u)
      if (u.includes('/pulls/7')) {
        return new Response(JSON.stringify({ head: { sha: 'resolved-sha' } }), { status: 200 })
      }
      return okTarResponse()
    }) as unknown as typeof fetch

    const staged = await stageGithubPr({
      target: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 7 },
      token: TOKEN,
      fetchImpl,
    })
    try {
      expect(staged.headSha).toBe('resolved-sha')
      expect(urls.some((u) => u.includes('/tarball/resolved-sha'))).toBe(true)
    } finally {
      await staged.dispose()
    }
  })

  test('dispose removes the staged dir', async () => {
    const fetchImpl = (async () => okTarResponse()) as unknown as typeof fetch
    const staged = await stageGithubPr({
      target: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 1, headSha: 's' },
      token: TOKEN,
      fetchImpl,
    })
    expect(existsSync(staged.hostPath)).toBe(true)
    await staged.dispose()
    expect(existsSync(staged.hostPath)).toBe(false)
  })

  test('disposes (no leak) when extraction throws on a malicious archive', async () => {
    const gz = makeTarGz([{ name: `${TOP}/../escape`, data: 'pwn' }])
    const fetchImpl = (async () => new Response(new Uint8Array(gz), { status: 200 })) as unknown as typeof fetch

    // given: count of typeclaw-review- staging dirs before the failed stage
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('typeclaw-review-')).length

    // when / then
    await expect(
      stageGithubPr({
        target: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 1, headSha: 's' },
        token: TOKEN,
        fetchImpl,
      }),
    ).rejects.toThrow(StagingError)

    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('typeclaw-review-')).length
    expect(after).toBe(before)
  })

  test('throws on non-ok tarball response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(
      stageGithubPr({
        target: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 1, headSha: 's' },
        token: TOKEN,
        fetchImpl,
      }),
    ).rejects.toThrow(/tarball fetch failed/)
  })

  test('token never appears in the returned staging result', async () => {
    const fetchImpl = (async () => okTarResponse()) as unknown as typeof fetch
    const staged = await stageGithubPr({
      target: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 1, headSha: 's' },
      token: TOKEN,
      fetchImpl,
    })
    try {
      const serialized = JSON.stringify({
        hostPath: staged.hostPath,
        sandboxPath: staged.sandboxPath,
        headSha: staged.headSha,
      })
      expect(serialized).not.toContain(TOKEN)
    } finally {
      await staged.dispose()
    }
  })
})
