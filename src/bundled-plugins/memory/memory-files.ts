import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function collectMemoryFiles(agentDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()

  const topicsDir = join(agentDir, 'memory', 'topics')
  const indexPath = join(agentDir, 'memory', 'index.md')

  if (existsSync(indexPath)) {
    const indexText = await readFile(indexPath, 'utf8').catch(() => '')
    if (indexText) files.set(indexPath, indexText)

    const activeDir = join(topicsDir, 'active')
    const archiveDir = join(topicsDir, 'archive')

    if (existsSync(activeDir)) {
      const names = await readdir(activeDir).catch(() => [])
      for (const name of names.filter((n) => n.endsWith('.md'))) {
        const path = join(activeDir, name)
        const text = await readFile(path, 'utf8').catch(() => '')
        if (text) files.set(path, text)
      }
    }

    if (existsSync(archiveDir)) {
      const names = await readdir(archiveDir).catch(() => [])
      for (const name of names.filter((n) => n.endsWith('.md'))) {
        const path = join(archiveDir, name)
        const text = await readFile(path, 'utf8').catch(() => '')
        if (text) files.set(path, text)
      }
    }
  } else {
    const memoryPath = join(agentDir, 'MEMORY.md')
    if (existsSync(memoryPath)) {
      const text = await readFile(memoryPath, 'utf8').catch(() => '')
      if (text) files.set(memoryPath, text)
    }
  }

  return files
}
