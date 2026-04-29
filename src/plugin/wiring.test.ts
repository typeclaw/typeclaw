import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createResourceLoader } from '@/agent'
import type { CronJob, LoadCronResult } from '@/cron'
import { startAgent, type LoadCronFn } from '@/run'

import { definePlugin } from './index'
import { PluginManager } from './manager'

let agentDir: string
let running: Awaited<ReturnType<typeof startAgent>> | null = null

afterEach(async () => {
  if (running) {
    await running.stop()
    running = null
  }
  if (agentDir) {
    await rm(agentDir, { recursive: true, force: true })
  }
})

describe('plugin wiring → createResourceLoader', () => {
  test('plugin system-prompt sections appear in the loader system prompt', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-wiring-'))
    const pm = new PluginManager({ agentDir })
    await pm.loadOne(
      definePlugin({ name: 'p' }, (ctx) => ctx.registerSystemPromptSection(() => 'PLUGIN_SECTION_MARKER')),
    )

    const { loader } = await createResourceLoader({ agentDir, pluginManager: pm })
    expect(loader.getSystemPrompt() ?? '').toContain('PLUGIN_SECTION_MARKER')
  })

  test('plugin in-memory skills are materialized and exposed via getSkills()', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-wiring-'))
    const pm = new PluginManager({ agentDir })
    await pm.loadOne(
      definePlugin({ name: 'p' }, (ctx) =>
        ctx.registerSkill({
          name: 'plugin-skill-marker',
          description: 'A plugin-contributed skill',
          content: 'The body of the plugin skill.',
        }),
      ),
    )

    const { loader, dispose } = await createResourceLoader({ agentDir, pluginManager: pm })
    const { skills } = loader.getSkills()
    const found = skills.find((s) => s.name === 'plugin-skill-marker')
    expect(found).toBeDefined()
    expect(found?.description).toBe('A plugin-contributed skill')

    await dispose()
  })

  test('plugin file-form skill dirs are added to the loader skill paths', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-wiring-'))
    const skillsDir = await mkdtemp(join(tmpdir(), 'typeclaw-wiring-skills-'))
    await Bun.write(
      join(skillsDir, 'file-skill-marker', 'SKILL.md'),
      `---\nname: file-skill-marker\ndescription: from disk\n---\n\nbody\n`,
    )

    const pm = new PluginManager({ agentDir })
    await pm.loadOne(definePlugin({ name: 'p' }, (ctx) => ctx.registerSkillsDir(skillsDir)))

    const { loader } = await createResourceLoader({ agentDir, pluginManager: pm })
    const { skills } = loader.getSkills()
    expect(skills.some((s) => s.name === 'file-skill-marker')).toBe(true)

    await rm(skillsDir, { recursive: true, force: true })
  })

  test('createResourceLoader().dispose() removes the materialized skills tmpdir', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-wiring-'))
    const pm = new PluginManager({ agentDir })
    await pm.loadOne(
      definePlugin({ name: 'p' }, (ctx) => ctx.registerSkill({ name: 'cleanup-test', description: 'x', content: 'y' })),
    )

    const { loader, dispose } = await createResourceLoader({ agentDir, pluginManager: pm })
    const { skills } = loader.getSkills()
    const skill = skills.find((s) => s.name === 'cleanup-test')
    expect(skill).toBeDefined()
    expect(await Bun.file(skill!.filePath).exists()).toBe(true)

    await dispose()
    expect(await Bun.file(skill!.filePath).exists()).toBe(false)
  })
})

describe('plugin wiring → startAgent', () => {
  test('plugin cron job ID colliding with cron.json job ID is loud at scheduler-factory time', async () => {
    const pluginJob: CronJob = {
      id: '__plugin_a_dreaming',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'subagent',
      subagent: 'dreaming',
      payload: {},
    }
    const userJob: CronJob = {
      id: '__plugin_a_dreaming',
      schedule: '* * * * *',
      kind: 'prompt',
      prompt: 'shadow',
      enabled: true,
    }

    const pm = new PluginManager({ agentDir: process.cwd() })
    await pm.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerCronJob(pluginJob)))

    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [userJob] } }) as LoadCronResult

    await expect(startAgent({ port: 0, attachTui: false, loadCron, pluginManager: pm })).rejects.toThrow(
      /registered twice/,
    )
  })
})
