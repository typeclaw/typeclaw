import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyChild, collectChildren } from './probe'

function fakeProc(procs: { pid: number; ppid: number; rssKb: number; argv: string[] }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'last-words-proc-'))
  for (const proc of procs) {
    const dir = join(root, String(proc.pid))
    mkdirSync(dir)
    writeFileSync(join(dir, 'status'), `Name:\tx\nPPid:\t${proc.ppid}\nVmRSS:\t${proc.rssKb} kB\n`)
    writeFileSync(join(dir, 'cmdline'), `${proc.argv.join('\0')}\0`)
  }
  mkdirSync(join(root, 'self'))
  return root
}

describe('collectChildren', () => {
  test('reports each direct child once with its whole subtree RSS, largest first', () => {
    const root = fakeProc([
      { pid: 2, ppid: 1, rssKb: 2_000_000, argv: ['bun', 'typeclaw', 'run'] },
      { pid: 10, ppid: 2, rssKb: 100_000, argv: ['bun', '--smol', '/app/readability-child.ts'] },
      { pid: 20, ppid: 2, rssKb: 1_024, argv: ['/usr/bin/bwrap', '--unshare-all', 'bash', '-c', 'secret-arg'] },
      { pid: 21, ppid: 20, rssKb: 511_000, argv: ['bash', '-c', 'secret-arg'] },
      { pid: 30, ppid: 1, rssKb: 900_000, argv: ['tmux'] },
    ])

    const children = collectChildren(root, 2)

    expect(children).toEqual([
      { kind: 'sandbox', rssMb: 500 },
      { kind: 'readability', rssMb: 98 },
    ])
    expect(JSON.stringify(children)).not.toContain('secret-arg')
  })

  test('an unreadable proc root yields no children', () => {
    expect(collectChildren(join(tmpdir(), 'does-not-exist-last-words'), 2)).toEqual([])
  })
})

describe('classifyChild', () => {
  test.each([
    [[['bwrap', '--die-with-parent', 'claude', '-p']], 'coding-agent'],
    [[['bwrap'], ['/opt/chrome/chrome', '--headless']], 'browser'],
    [[['unshare', '--pid', 'bwrap']], 'sandbox'],
    [[['git', 'gc']], 'other'],
  ] as const)('%j is %s', (argvs, kind) => {
    expect(classifyChild(argvs.map((argv) => [...argv]))).toBe(kind)
  })
})
