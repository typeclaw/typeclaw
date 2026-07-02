import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type Task = {
  id: string
  dir: string
  instruction: string
  verifyCommand: string[]
  timeoutMs: number
}

export type TaskMeta = {
  verify?: string[]
  timeoutMs?: number
}

const INSTRUCTION_FILE = 'instruction.md'
const META_FILE = 'task.json'
const DEFAULT_VERIFY = ['bash', 'verify.sh']
const DEFAULT_TIMEOUT_MS = 600_000

export async function loadTask(dir: string): Promise<Task> {
  const instruction = (await readFile(join(dir, INSTRUCTION_FILE), 'utf8')).trim()
  if (instruction.length === 0) throw new Error(`empty ${INSTRUCTION_FILE} in ${dir}`)

  const meta = await readMeta(dir)
  return {
    id: basename(dir) || dir,
    dir,
    instruction,
    verifyCommand: meta.verify ?? DEFAULT_VERIFY,
    timeoutMs: meta.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

export async function loadTaskSuite(suiteDir: string): Promise<Task[]> {
  const entries = await readdir(suiteDir)
  const dirs: string[] = []
  for (const entry of entries) {
    const full = join(suiteDir, entry)
    if ((await stat(full)).isDirectory()) dirs.push(full)
  }
  dirs.sort()
  return Promise.all(dirs.map(loadTask))
}

async function readMeta(dir: string): Promise<TaskMeta> {
  let raw: string
  try {
    raw = await readFile(join(dir, META_FILE), 'utf8')
  } catch {
    return {}
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`invalid ${META_FILE} in ${dir}`)
  const meta = parsed as Record<string, unknown>
  return {
    verify: Array.isArray(meta.verify) ? meta.verify.map(String) : undefined,
    timeoutMs: typeof meta.timeoutMs === 'number' ? meta.timeoutMs : undefined,
  }
}
