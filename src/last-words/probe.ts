import { readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

import type { LastWordsChild } from './file'

const KB_PER_MB = 1024
const BYTES_PER_MB = 1024 * 1024
const MAX_CHILDREN = 20

export function readMemoryCurrentMb(path = '/sys/fs/cgroup/memory.current'): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (!/^\d+$/.test(raw)) return null
    return Math.round(Number(raw) / BYTES_PER_MB)
  } catch {
    return null
  }
}

type ProcInfo = { pid: number; ppid: number; rssKb: number; argv: string[] }

// Each direct child of the runtime is reported once, with the RSS of its whole
// subtree: a sandboxed bash is bwrap → shell → command, and only the total says
// how much memory that one operation holds. Only the kind is kept; command
// lines are read to classify and then dropped, because they carry arguments.
export function collectChildren(procRoot = '/proc', selfPid = process.pid): LastWordsChild[] {
  const procs = readProcs(procRoot)
  const byParent = new Map<number, ProcInfo[]>()
  for (const proc of procs) {
    const siblings = byParent.get(proc.ppid) ?? []
    siblings.push(proc)
    byParent.set(proc.ppid, siblings)
  }
  const subtree = (root: ProcInfo): ProcInfo[] => {
    const out: ProcInfo[] = []
    const stack = [root]
    while (stack.length > 0) {
      const next = stack.pop()!
      out.push(next)
      stack.push(...(byParent.get(next.pid) ?? []))
    }
    return out
  }
  return (byParent.get(selfPid) ?? [])
    .map((child) => {
      const members = subtree(child)
      const rssKb = members.reduce((sum, member) => sum + member.rssKb, 0)
      return { kind: classifyChild(members.map((member) => member.argv)), rssMb: Math.round(rssKb / KB_PER_MB) }
    })
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, MAX_CHILDREN)
}

const CODING_AGENT_BINS = new Set(['claude', 'codex', 'omo'])

export function classifyChild(argvs: string[][]): LastWordsChild['kind'] {
  const names = argvs.flatMap((argv) => argv.map((arg) => basename(arg)))
  if (argvs.some((argv) => argv.some((arg) => arg.includes('readability-child')))) return 'readability'
  if (names.some((name) => CODING_AGENT_BINS.has(name))) return 'coding-agent'
  if (names.some((name) => /^(chrome|chromium|headless_shell|agent-browser)/.test(name))) return 'browser'
  const rootName = argvs[0]?.[0] === undefined ? '' : basename(argvs[0][0])
  if (rootName === 'bwrap' || rootName === 'unshare') return 'sandbox'
  return 'other'
}

function readProcs(procRoot: string): ProcInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return []
  }
  const procs: ProcInfo[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const status = readFileSync(`${procRoot}/${entry}/status`, 'utf8')
      const ppid = /^PPid:\s+(\d+)$/m.exec(status)
      if (ppid === null) continue
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status)
      const argv = readFileSync(`${procRoot}/${entry}/cmdline`, 'utf8')
        .split('\0')
        .filter((arg) => arg !== '')
      procs.push({ pid: Number(entry), ppid: Number(ppid[1]), rssKb: rss === null ? 0 : Number(rss[1]), argv })
    } catch {
      // The process exited between readdir and read. Normal, not an error.
    }
  }
  return procs
}
