import { describe, expect, test } from 'bun:test'

import { definePlugin } from './index'
import { loadPlugins, normalizeEntry, pickPluginExport, resolveSpecifier } from './loader'
import type { Plugin } from './types'

describe('normalizeEntry', () => {
  test('treats a bare string as { source, options: undefined }', () => {
    expect(normalizeEntry('typeclaw-plugin-foo')).toEqual({ source: 'typeclaw-plugin-foo', options: undefined })
  })

  test('extracts options from a tuple form', () => {
    expect(normalizeEntry(['typeclaw-plugin-foo', { apiKey: 'k' }])).toEqual({
      source: 'typeclaw-plugin-foo',
      options: { apiKey: 'k' },
    })
  })

  test('reads source/options from an object form', () => {
    expect(normalizeEntry({ source: 'typeclaw-plugin-foo', options: { x: 1 } })).toEqual({
      source: 'typeclaw-plugin-foo',
      options: { x: 1 },
    })
  })
})

describe('resolveSpecifier', () => {
  test('passes npm-style names through unchanged', () => {
    expect(resolveSpecifier('typeclaw-plugin-foo', '/agent')).toBe('typeclaw-plugin-foo')
    expect(resolveSpecifier('@scope/pkg', '/agent')).toBe('@scope/pkg')
  })

  test('resolves relative paths against the agent dir', () => {
    expect(resolveSpecifier('./plugins/foo', '/agent')).toBe('/agent/plugins/foo')
    expect(resolveSpecifier('../shared/foo', '/agent/sub')).toBe('/agent/shared/foo')
  })

  test('passes absolute paths through unchanged', () => {
    expect(resolveSpecifier('/abs/foo', '/agent')).toBe('/abs/foo')
  })
})

describe('pickPluginExport', () => {
  test('picks default export when it is a Plugin', () => {
    const plugin = definePlugin({ name: 'foo' }, () => {})
    expect(pickPluginExport({ default: plugin })).toBe(plugin)
  })

  test('picks named `plugin` export when default is missing', () => {
    const plugin = definePlugin({ name: 'foo' }, () => {})
    expect(pickPluginExport({ plugin })).toBe(plugin)
  })

  test('returns undefined when no plugin shape is found', () => {
    expect(pickPluginExport({ default: { not: 'a plugin' } })).toBeUndefined()
    expect(pickPluginExport(null)).toBeUndefined()
    expect(pickPluginExport({})).toBeUndefined()
  })

  test('rejects shapes that lack manifest.name', () => {
    expect(pickPluginExport({ default: { manifest: {}, factory: () => {} } })).toBeUndefined()
    expect(pickPluginExport({ default: { manifest: { name: '' }, factory: () => {} } })).toBeUndefined()
  })
})

describe('loadPlugins', () => {
  test('imports each entry through the provided importer and returns ResolvedPluginEntry[]', async () => {
    const pluginA = definePlugin({ name: 'a' }, () => {})
    const pluginB = definePlugin({ name: 'b' }, () => {})

    const importer = async (specifier: string): Promise<unknown> => {
      if (specifier === 'typeclaw-plugin-a') return { default: pluginA }
      if (specifier === '/agent/plugins/b') return { plugin: pluginB }
      throw new Error(`unexpected specifier: ${specifier}`)
    }

    const resolved = await loadPlugins(['typeclaw-plugin-a', './plugins/b'], { agentDir: '/agent', importer })

    expect(resolved).toHaveLength(2)
    expect(resolved[0]?.plugin).toBe(pluginA)
    expect(resolved[0]?.ref).toEqual({ source: 'typeclaw-plugin-a', options: undefined })
    expect(resolved[1]?.plugin).toBe(pluginB)
    expect(resolved[1]?.ref).toEqual({ source: './plugins/b', options: undefined })
  })

  test('passes options from tuple form into the ref', async () => {
    const plugin = definePlugin({ name: 'foo' }, () => {})
    const importer = async () => ({ default: plugin })
    const resolved = await loadPlugins([['typeclaw-plugin-foo', { apiKey: 'k' }]], { agentDir: '/agent', importer })
    expect(resolved[0]?.ref).toEqual({ source: 'typeclaw-plugin-foo', options: { apiKey: 'k' } })
  })

  test('throws a clear error when a module has no plugin export', async () => {
    const importer = async () => ({ default: { manifest: { name: '' }, factory: () => {} } })
    await expect(loadPlugins(['typeclaw-plugin-broken'], { agentDir: '/agent', importer })).rejects.toThrow(
      /has no default export/,
    )
  })

  test('wraps importer failures with the source identifier', async () => {
    const importer = async (): Promise<unknown> => {
      throw new Error('module not found')
    }
    await expect(loadPlugins(['typeclaw-plugin-missing'], { agentDir: '/agent', importer })).rejects.toThrow(
      /failed to load plugin 'typeclaw-plugin-missing': module not found/,
    )
  })
})

void (null as unknown as Plugin)
