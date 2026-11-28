import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BashSandboxBoundary } from '@/agent/bash-sandbox'
import { runBunInstall } from '@/init/run-bun-install'
import { createPermissionService } from '@/permissions/permissions'
import { buildSandboxedCommand, type SandboxPolicy } from '@/sandbox'

import { installAgentDependencies } from './dependency-install'

// Runs the prepared command without bwrap so the test exercises the real
// install inside the policy the runtime would hand bwrap.
function unwrappedBoundary(onPolicy: (policy: SandboxPolicy | undefined) => void): BashSandboxBoundary {
  return {
    ensureAvailable: async () => {},
    resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
    resolveRuntime: async () => ({ env: {}, mounts: [] }),
    buildCommand(command, policy) {
      onPolicy(policy)
      return { ...buildSandboxedCommand(command, policy), commandString: command }
    },
  }
}

async function writeAgentWithScriptedDependencies(agentDir: string): Promise<void> {
  const marker = (name: string) => `bun -e "require('fs').writeFileSync('${join(agentDir, name)}', '')"`
  await writeFile(
    join(agentDir, 'package.json'),
    JSON.stringify({
      name: 'agent',
      private: true,
      dependencies: { trusted: 'file:./vendor/trusted', untrusted: 'file:./vendor/untrusted' },
      trustedDependencies: ['trusted'],
    }),
  )
  for (const name of ['trusted', 'untrusted']) {
    await mkdir(join(agentDir, 'vendor', name), { recursive: true })
    await writeFile(
      join(agentDir, 'vendor', name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', scripts: { postinstall: marker(`${name}-postinstall`) } }),
    )
  }
}

describe('installAgentDependencies', () => {
  test("finishes a trusted dependency's postinstall that the host install skipped", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'tc-dependency-install-'))
    try {
      // given: the host installed the agent folder without running any script
      await writeAgentWithScriptedDependencies(agentDir)
      expect(await runBunInstall(agentDir)).toEqual({ ok: true })
      expect(existsSync(join(agentDir, 'trusted-postinstall'))).toBe(false)
      const lockfile = await readFile(join(agentDir, 'bun.lock'), 'utf8')
      let policy: SandboxPolicy | undefined

      // when
      const result = await installAgentDependencies({
        agentDir,
        permissions: createPermissionService(),
        boundary: unwrappedBoundary((built) => {
          policy = built
        }),
      })

      // then: only the trusted script ran, in a sandbox that can write the agent root
      expect(result).toEqual({ ok: true })
      expect(existsSync(join(agentDir, 'trusted-postinstall'))).toBe(true)
      expect(existsSync(join(agentDir, 'untrusted-postinstall'))).toBe(false)
      expect(policy?.writableRoot?.dir).toBe(agentDir)
      expect(await readFile(join(agentDir, 'bun.lock'), 'utf8')).toBe(lockfile)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('reports a failed install instead of throwing', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'tc-dependency-install-fail-'))
    try {
      // given: a manifest the existing lockfile no longer matches
      await writeAgentWithScriptedDependencies(agentDir)
      expect(await runBunInstall(agentDir)).toEqual({ ok: true })
      await writeFile(
        join(agentDir, 'package.json'),
        JSON.stringify({ name: 'agent', private: true, dependencies: { trusted: 'file:./vendor/untrusted' } }),
      )

      // when
      const result = await installAgentDependencies({
        agentDir,
        permissions: createPermissionService(),
        boundary: unwrappedBoundary(() => {}),
      })

      // then
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.reason).toMatch(/bun install exited with code \d+: .*frozen/s)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
