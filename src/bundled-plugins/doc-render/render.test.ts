import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromePath, DEFAULT_CHROME_PATH } from './render'

const scriptPath = fileURLToPath(new URL('./render.ts', import.meta.url))
// The fake Chrome is a POSIX shell script; the renderer itself only runs in the Linux container.
const testPosix = test.skipIf(process.platform === 'win32')

function fakeChrome(dir: string, { writePdf }: { writePdf: boolean }): { bin: string; argvLog: string } {
  const bin = join(dir, 'chrome')
  const argvLog = join(dir, 'argv.log')
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${argvLog}`,
      writePdf
        ? 'for a in "$@"; do case "$a" in --print-to-pdf=*) printf "%%PDF-1.4" > "${a#--print-to-pdf=}";; esac; done'
        : 'echo "boom" >&2',
      'exit 0',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return { bin, argvLog }
}

async function runRender(args: string[], chrome: string, cwd: string) {
  const proc = Bun.spawn(['bun', 'run', scriptPath, ...args], {
    cwd,
    env: { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: chrome },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('chromePath', () => {
  test('prefers the operator override, else the image default', () => {
    expect(chromePath({ AGENT_BROWSER_EXECUTABLE_PATH: '/opt/chrome' })).toBe('/opt/chrome')
    expect(chromePath({})).toBe(DEFAULT_CHROME_PATH)
  })
})

describe('render script CLI', () => {
  test('exits 2 with usage when args are missing', async () => {
    const proc = Bun.spawn(['bun', 'run', scriptPath], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    expect(proc.exitCode).toBe(2)
    expect(await new Response(proc.stderr).text()).toContain('usage:')
  })

  testPosix('prints the document with headless Chrome and no package install', async () => {
    // given
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'doc-render-ok-')))
    writeFileSync(join(dir, '보고서.html'), '<p>안녕</p>')
    const { bin, argvLog } = fakeChrome(dir, { writePdf: true })

    // when
    const result = await runRender(['보고서.html', 'out.pdf'], bin, dir)

    // then
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('wrote out.pdf')
    const argv = (await Bun.file(argvLog).text()).trim().split('\n')
    expect(argv).toContain('--headless')
    expect(argv).toContain('--no-pdf-header-footer')
    expect(argv).toContain(`--print-to-pdf=${join(dir, 'out.pdf')}`)
    expect(argv.at(-1)).toBe(pathToFileURL(join(dir, '보고서.html')).href)
  })

  testPosix('creates a missing output directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-render-outdir-'))
    writeFileSync(join(dir, 'doc.html'), '<p>x</p>')
    const { bin } = fakeChrome(dir, { writePdf: true })

    const result = await runRender(['doc.html', 'exports/brief.pdf'], bin, dir)

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(join(dir, 'exports', 'brief.pdf')).exists()).toBeTrue()
  })

  testPosix('fails when Chrome exits without writing the PDF, even if a stale one existed', async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), 'doc-render-nopdf-'))
    writeFileSync(join(dir, 'doc.html'), '<p>x</p>')
    writeFileSync(join(dir, 'out.pdf'), 'stale')
    const { bin } = fakeChrome(dir, { writePdf: false })

    // when
    const result = await runRender(['doc.html', 'out.pdf'], bin, dir)

    // then
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('without writing out.pdf')
    expect(result.stderr).toContain('boom')
  })

  test('names the missing Chrome and how to point at one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-render-nochrome-'))
    writeFileSync(join(dir, 'doc.html'), '<p>x</p>')

    const result = await runRender(['doc.html', 'out.pdf'], join(dir, 'missing-chrome'), dir)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('AGENT_BROWSER_EXECUTABLE_PATH')
  })
})
