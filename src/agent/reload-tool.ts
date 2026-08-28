import { defineTool } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'

import type { ReloadRegistry, ReloadResult } from '@/reload'

export type CreateReloadToolOptions = {
  registry: ReloadRegistry
}

export function createReloadTool({ registry }: CreateReloadToolOptions) {
  return defineTool({
    name: 'reload',
    label: 'Reload',
    description:
      'Reload typeclaw subsystems whose on-disk source has changed. Each reloadable is ' +
      'all-or-nothing: invalid input leaves its live state unchanged and the failure reason is ' +
      "reported in that scope's result. Boot-only config fields (port, mounts, memory.idleMs) " +
      'are reported as restart-required. Safe to call any time. ' +
      'Without a scope arg, runs every non-destructive registered reloadable in registration ' +
      'order so later scopes observe earlier swaps (e.g. cron sees a freshly-loaded plugins ' +
      'registry). Provider credential invalidation recreates every live channel session, so it ' +
      'runs only with an explicit scope="providers" after credentials change. With a scope arg, ' +
      'runs only that one reloadable.',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.String({
          description:
            'Optional reload scope name. Common scopes: "config" (typeclaw.json), ' +
            '"plugins" (re-resolve and re-run plugin factories), "skills" (read-only diagnostic ' +
            'reporting which skills are visible to a new session), "cron" (cron.json). ' +
            'Use "providers" only after provider credentials change. Omit to reload all ' +
            'non-destructive scopes.',
        }),
      ),
    }),
    execute: async (_id, args) => {
      const items = registry.list()
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: 'nothing to reload (no reloadable subsystems registered)' }],
          details: { results: [] },
        }
      }

      const scope = (args as { scope?: string }).scope
      if (scope !== undefined && scope.length > 0) {
        const result = await registry.reloadOne(scope)
        return {
          content: [{ type: 'text', text: formatResults([result]) }],
          details: { results: [result] },
        }
      }

      const results: ReloadResult[] = []
      for (const item of items) {
        if (item.scope === 'providers') continue
        results.push(await registry.reloadOne(item.scope))
      }
      return {
        content: [{ type: 'text', text: formatResults(results) }],
        details: { results },
      }
    },
  })
}

function formatResults(results: ReloadResult[]): string {
  const lines = results.map((r) => {
    if (r.ok) return `[${r.scope}] ok: ${r.summary}`
    return `[${r.scope}] failed: ${r.reason}`
  })
  const failedCount = results.filter((r) => !r.ok).length
  const header =
    failedCount === 0
      ? `Reloaded ${results.length} subsystem(s).`
      : `Reloaded ${results.length} subsystem(s); ${failedCount} failed.`
  return [header, ...lines].join('\n')
}
