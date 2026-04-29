import { isAbsolute, resolve } from 'node:path'

import type { Plugin, PluginEntry, PluginRef } from './types'

export type ResolvedPluginEntry = {
  ref: PluginRef
  plugin: Plugin
}

export type LoadPluginsOptions = {
  agentDir: string
  importer?: (specifier: string) => Promise<unknown>
}

const defaultImporter = (specifier: string): Promise<unknown> => import(specifier)

export function normalizeEntries(entries: ReadonlyArray<PluginEntry>): PluginRef[] {
  return entries.map(normalizeEntry)
}

export function normalizeEntry(entry: PluginEntry): PluginRef {
  if (typeof entry === 'string') return { source: entry, options: undefined }
  if (Array.isArray(entry)) {
    const [source, options] = entry as readonly [string, unknown]
    return { source, options }
  }
  const obj = entry as { source: string; options?: unknown }
  return { source: obj.source, options: obj.options }
}

export async function loadPlugins(
  entries: ReadonlyArray<PluginEntry>,
  options: LoadPluginsOptions,
): Promise<ResolvedPluginEntry[]> {
  const refs = normalizeEntries(entries)
  const importer = options.importer ?? defaultImporter
  const resolved: ResolvedPluginEntry[] = []
  for (const ref of refs) {
    const specifier = resolveSpecifier(ref.source, options.agentDir)
    let mod: unknown
    try {
      mod = await importer(specifier)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to load plugin '${ref.source}': ${message}`)
    }
    const plugin = pickPluginExport(mod)
    if (!plugin) {
      throw new Error(
        `plugin '${ref.source}' has no default export (or named 'plugin' export) returning definePlugin(...)`,
      )
    }
    resolved.push({ ref, plugin })
  }
  return resolved
}

export function resolveSpecifier(source: string, agentDir: string): string {
  if (source.startsWith('./') || source.startsWith('../') || source.startsWith('/')) {
    return isAbsolute(source) ? source : resolve(agentDir, source)
  }
  return source
}

export function pickPluginExport(mod: unknown): Plugin | undefined {
  if (mod === null || typeof mod !== 'object') return undefined
  const m = mod as Record<string, unknown>
  const candidates = [m.default, m.plugin, mod]
  for (const c of candidates) {
    if (isPlugin(c)) return c
  }
  return undefined
}

function isPlugin(value: unknown): value is Plugin {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.factory !== 'function') return false
  const manifest = v.manifest as Record<string, unknown> | undefined
  if (!manifest || typeof manifest !== 'object') return false
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return false
  return true
}
