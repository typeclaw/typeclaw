import type { Plugin, PluginFactory, PluginManifest } from './types'

export function definePlugin(manifest: PluginManifest, factory: PluginFactory): Plugin {
  return { manifest, factory }
}

export {
  loadPlugins,
  normalizeEntry,
  normalizeEntries,
  pickPluginExport,
  resolveSpecifier,
  type LoadPluginsOptions,
  type ResolvedPluginEntry,
} from './loader'
export { PluginManager, type PluginManagerOptions, type RegisteredPlugin, type RegistrationAudit } from './manager'
export { materializeSkills, type MaterializedSkills } from './skills-materializer'
export type {
  InMemorySkill,
  Plugin,
  PluginCtx,
  PluginEntry,
  PluginFactory,
  PluginLogger,
  PluginManifest,
  PluginRef,
  SessionIdleEvent,
  ShutdownHandler,
  SpawnSubagent,
  SystemPromptSectionContext,
  SystemPromptSectionLoader,
  TypeClawEventHandler,
  TypeClawEventName,
  TypeClawEvents,
} from './types'
