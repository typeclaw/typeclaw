import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import { BROWSER_ENGINE_IDS, BROWSER_EXTENSION_IDS } from '@/browser/registry'

import {
  browserPayloadSchema,
  buildBrowserSystemPrompt,
  createBrowserSubagent,
  driverSkillPath,
  TYPEVAULT_SKILL_PATH,
} from './browser-agent'

describe('browser subagent', () => {
  test('runs the fast profile at medium thinking', () => {
    const subagent = createBrowserSubagent({ engines: ['agent-browser'], extensions: [] })
    expect(subagent.profile).toBe('fast')
    expect(subagent.thinkingLevel).toBe('medium')
  })

  test('drops a per-spawn profile override so the parent cannot move its tier', () => {
    const parsed = browserPayloadSchema.parse({ prompt: 'open example.com', profile: 'deep' })
    expect(parsed).toEqual({ prompt: 'open example.com' })
  })

  test('every engine and extension skill path points at a shipped SKILL.md', () => {
    for (const id of [...BROWSER_ENGINE_IDS, ...BROWSER_EXTENSION_IDS])
      expect(existsSync(driverSkillPath(id))).toBe(true)
  })

  test('prompt lists only the enabled engines', () => {
    const prompt = buildBrowserSystemPrompt({ engines: ['omowright'], extensions: [] })
    expect(prompt).toContain(driverSkillPath('omowright'))
    expect(prompt).not.toContain(driverSkillPath('agent-browser'))
    expect(prompt).not.toContain(driverSkillPath('browserskill'))
  })

  test('points the worker at the typevault skill only when the vault is live', () => {
    const drivers = { engines: ['agent-browser'], extensions: [] } as const
    expect(existsSync(TYPEVAULT_SKILL_PATH)).toBe(true)
    expect(createBrowserSubagent(drivers, { typevault: true }).systemPrompt).toContain(TYPEVAULT_SKILL_PATH)
    expect(createBrowserSubagent(drivers).systemPrompt).not.toContain(TYPEVAULT_SKILL_PATH)
  })

  test('a BrowserSkill-only config still hands the worker its driver skill', () => {
    const prompt = buildBrowserSystemPrompt({ engines: [], extensions: ['browserskill'] })
    expect(prompt).toContain(driverSkillPath('browserskill'))
  })
})
