import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import { getConfig, resolveModel } from '@/config'
import { materializeSkills, type MaterializedSkills, type PluginManager } from '@/plugin'
import type { ReloadRegistry } from '@/reload'
import type { Stream } from '@/stream'

import { getAuth } from './auth'
import { loadMemory } from './memory'
import { createReloadTool } from './reload-tool'
import { loadSelf } from './self'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'
import { createStreamSnapshotTool } from './tools/stream-snapshot'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

export type { AgentSession }

export type CreateSessionOptions = {
  reloadRegistry?: ReloadRegistry
  sessionManager?: SessionManager
  stream?: Stream
  pluginManager?: PluginManager
  sessionId?: string
}

export type CreateSessionResult = {
  session: AgentSession
  dispose: () => Promise<void>
}

export async function createSession(options: CreateSessionOptions = {}): Promise<CreateSessionResult> {
  const { authStorage, modelRegistry } = getAuth()
  const { loader, dispose } = await createResourceLoader({
    pluginManager: options.pluginManager,
    sessionId: options.sessionId,
  })
  const customTools = [
    websearchTool,
    webfetchTool,
    ...(options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []),
    ...(options.stream ? [createStreamSnapshotTool({ stream: options.stream })] : []),
    ...(options.pluginManager?.getTools() ?? []),
  ]

  const { session } = await createAgentSession({
    model: resolveModel(getConfig().model),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    customTools,
  })
  return { session, dispose }
}

export type CreateResourceLoaderOptions = {
  agentDir?: string
  pluginManager?: PluginManager
  sessionId?: string
}

export type CreateResourceLoaderResult = {
  loader: DefaultResourceLoader
  dispose: () => Promise<void>
}

export async function createResourceLoader(
  options: CreateResourceLoaderOptions = {},
): Promise<CreateResourceLoaderResult> {
  const agentDir = options.agentDir ?? process.cwd()
  const pluginManager = options.pluginManager
  const sessionId = options.sessionId ?? ''

  const [self, memory] = await Promise.all([loadSelf(agentDir), loadMemory(agentDir)])
  const pluginSections = pluginManager ? await pluginManager.loadSystemPromptSections({ sessionId, agentDir }) : []
  const pluginSuffix = pluginSections.length > 0 ? `\n\n${pluginSections.join('\n\n')}` : ''
  const systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\n${self}\n\n${memory}${pluginSuffix}`

  const skillPaths = [getBundledSkillsDir(), ...(pluginManager?.getSkillsDirs() ?? [])]
  const materialized: MaterializedSkills | null = pluginManager
    ? await materializeSkills(pluginManager.getInMemorySkills())
    : null
  if (materialized) skillPaths.push(materialized.dir)

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalSkillPaths: skillPaths,
  })
  await loader.reload()

  return {
    loader,
    dispose: async () => {
      if (materialized) await materialized.dispose()
    },
  }
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}
