import { describe, expect, test } from 'bun:test'
import { renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeConfigAndToken } from '@/cli/tunnel'
import { storeEnvKeyUnlessPresent } from '@/init/env-file'

import { buildSandboxedCommand } from './build'

// A running sandbox masks .env with a bind over its inode. A credential update
// must keep that inode, or the sandbox sees the new token. Only a real bwrap
// can show this; it ships in the typeclaw container but not on the macOS host.
const bwrapPresent = (() => {
  try {
    return Bun.spawnSync(['bwrap', '--version'], { timeout: 30_000, stdout: 'ignore', stderr: 'ignore' }).success
  } catch {
    return false
  }
})()

const CANARY = 'canary-token-written-after-the-sandbox-started'

// Starts a sandbox with .env masked, waits until it is running, applies
// `update` on the host, then has the sandbox read .env and returns what it saw.
async function readEnvFromRunningSandbox(agentDir: string, update: () => void): Promise<string> {
  const env = join(agentDir, '.env')
  const { commandString } = buildSandboxedCommand(`echo READY; read -r _; cat ${env}`, {
    mounts: [{ type: 'bind', source: agentDir, dest: agentDir }],
    masks: { files: [env] },
  })
  const proc = Bun.spawn(['bash', '-c', commandString], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('READY\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`sandbox exited before it was ready: ${await new Response(proc.stderr).text()}`)
    seen += decoder.decode(value, { stream: true })
  }
  update()
  proc.stdin.write('go\n')
  await proc.stdin.end()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value, { stream: true })
  }
  expect(await proc.exited).toBe(0)
  return seen.slice(seen.indexOf('READY\n') + 'READY\n'.length)
}

describe('a credential update under a running sandbox', () => {
  test.skipIf(!bwrapPresent)('a channel/init token store keeps .env masked', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-credential-mask-'))
    try {
      await writeFile(join(agentDir, '.env'), 'OTHER=1\n')

      const seen = await readEnvFromRunningSandbox(agentDir, () => {
        expect(storeEnvKeyUnlessPresent(agentDir, 'CLOUDFLARE_TUNNEL_TOKEN', CANARY)).toEqual({ ok: true })
      })

      expect(seen).not.toContain(CANARY)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(!bwrapPresent)('a tunnel token and config publish keeps .env masked', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-credential-mask-'))
    try {
      await writeFile(join(agentDir, '.env'), 'OTHER=1\n')
      await writeFile(join(agentDir, 'typeclaw.json'), '{}\n')

      const seen = await readEnvFromRunningSandbox(agentDir, () => {
        const result = writeConfigAndToken(
          agentDir,
          { tunnels: [] },
          { env: 'CLOUDFLARE_TUNNEL_TOKEN', value: CANARY },
          'typeclaw tunnel add',
        )
        expect(result.ok).toBe(true)
      })

      expect(seen).not.toContain(CANARY)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(!bwrapPresent)('control: renaming a new file over .env does expose it', async () => {
    // Shows the harness detects the failure the updates above avoid.
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-credential-mask-'))
    try {
      await writeFile(join(agentDir, '.env'), 'OTHER=1\n')

      const seen = await readEnvFromRunningSandbox(agentDir, () => {
        writeFileSync(join(agentDir, 'replacement'), `CLOUDFLARE_TUNNEL_TOKEN=${CANARY}\n`)
        renameSync(join(agentDir, 'replacement'), join(agentDir, '.env'))
      })

      expect(seen).toContain(CANARY)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
