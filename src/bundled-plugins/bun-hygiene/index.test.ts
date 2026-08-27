import { describe, expect, test } from 'bun:test'

import { buildInternalGuards } from '@/agent/guards'
import { createHookBus, type ToolBeforeEvent } from '@/plugin'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('bun-hygiene internal guards', () => {
  test('blocks global installs through the internal registry', async () => {
    const hook = await guardRunner()

    const result = await hook(toolEvent('bash', { command: 'npm install -g typescript' }))

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('globalInstall')
  })

  test('blocks non-bun install managers and runners while allowing bunx through the hook', async () => {
    const hook = await guardRunner()

    const blocked = await hook(toolEvent('bash', { command: 'npm install' }))
    const allowedBunx = await hook(toolEvent('bash', { command: 'bunx create-next-app' }))
    const blockedNpx = await hook(toolEvent('bash', { command: 'npx create-next-app' }))

    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('nonBunPackageManager')
    expect(allowedBunx).toBeUndefined()
    expect(blockedNpx?.block).toBe(true)
    expect(blockedNpx?.reason).toContain('nonBunPackageRunner')
  })

  test('respects the acknowledgeGuards bypass', async () => {
    const hook = await guardRunner()

    const result = await hook(
      toolEvent('bash', {
        command: 'npm install',
        acknowledgeGuards: { 'bun-hygiene': { nonBunPackageManager: true } },
      }),
    )

    expect(result).toBeUndefined()
  })
})

async function guardRunner() {
  const hooks = createHookBus()
  hooks.registerAll('bun-hygiene', '/agent', noopLogger, {})
  const guards = buildInternalGuards('/agent')
  return async (event: ToolBeforeEvent) => {
    const args = { ...event.args }
    const acknowledgements = args.acknowledgeGuards as Record<string, Record<string, boolean>> | undefined
    delete args.acknowledgeGuards
    return hooks.runToolBefore({ ...event, args }, guards, acknowledgements)
  }
}

function toolEvent(tool: string, args: Record<string, unknown>): ToolBeforeEvent {
  return { tool, sessionId: 's', callId: 'c', args }
}
