import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InMemorySkill } from './types'

export type MaterializedSkills = {
  dir: string
  dispose: () => Promise<void>
}

export async function materializeSkills(skills: ReadonlyArray<InMemorySkill>): Promise<MaterializedSkills | null> {
  if (skills.length === 0) return null

  const root = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-skills-'))
  const seenDirs = new Map<string, string>()
  for (const skill of skills) {
    const dirName = sanitizeSkillName(skill.name)
    const prior = seenDirs.get(dirName)
    if (prior !== undefined) {
      await rm(root, { recursive: true, force: true })
      throw new Error(
        `in-memory skill name collision after sanitization: '${skill.name}' and '${prior}' both map to '${dirName}'`,
      )
    }
    seenDirs.set(dirName, skill.name)

    const dir = join(root, dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), renderSkill(skill), 'utf8')
  }

  return {
    dir: root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function sanitizeSkillName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-')
}

function renderSkill(skill: InMemorySkill): string {
  const fmEntries: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    ...skill.frontmatter,
  }
  const fmLines = Object.entries(fmEntries).map(([k, v]) => `${k}: ${formatFrontmatterValue(v)}`)
  return `---\n${fmLines.join('\n')}\n---\n\n${skill.content}\n`
}

function formatFrontmatterValue(v: unknown): string {
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
