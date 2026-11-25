import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { z } from 'zod'

import { buildInternalGuards } from '@/agent/guards'
import {
  buildBuiltinPiToolOverrides,
  resetSharedLoopGuardSession,
  type BashSandboxBoundary,
} from '@/agent/plugin-tools'
import type { GithubTokenBridge } from '@/channels/github-token-bridge'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'
import type { HookBus } from '@/plugin'
import { shellQuote } from '@/sandbox'

import { createWatchGithubCredentialResolver } from './github-credential'
import { bundledProbes } from './probes'
import { watchOrigin, withWatchDirectory, type WatchRecord } from './store'
import type { BundledProbe, BundledProbeContext } from './types'
import { parseProbeOutput, type ProbeResult } from './verdict'

// One pipe consumer hashes every byte while retaining a bounded tail. A
// second consumer via mkfifo would not work with Git Bash on Windows.
const diffCapture = `${shellQuote(process.execPath)} -e ${shellQuote(`
const hash = new Bun.CryptoHasher('sha256')
let tail = Buffer.alloc(0)
for await (const chunk of Bun.stdin.stream()) {
  hash.update(chunk)
  tail = Buffer.concat([tail, chunk.subarray(-8192)]).subarray(-8192)
}
process.stdout.write(hash.digest('hex') + '\\n')
process.stdout.write(tail)
`)}`

export class ProbeRegistry {
  private entries = new Map<string, BundledProbe>()
  register<P>(probe: BundledProbe<P>) {
    if (this.entries.has(probe.kind)) throw new Error(`Duplicate bundled probe: ${probe.kind}`)
    this.entries.set(probe.kind, {
      ...probe,
      describe: (raw) => probe.describe(probe.parseParams(raw)),
      run: (ctx) => probe.run({ ...ctx, params: probe.parseParams(ctx.params) }),
    })
  }
  get(kind: string) {
    const entry = this.entries.get(kind)
    if (!entry) throw new Error(`Unknown bundled probe: ${kind}`)
    return entry
  }
}
export function createBundledProbeRegistry(): ProbeRegistry {
  const registry = new ProbeRegistry()
  for (const probe of bundledProbes) registry.register(probe)
  return registry
}

export function createProbeRunner(
  agentDir: string,
  permissions: PermissionService,
  hooks: () => HookBus,
  github: GithubTokenBridge,
  registry: ProbeRegistry,
  bashSandboxBoundary?: BashSandboxBoundary,
) {
  const root = join(agentDir, 'workspace', '.typeclaw-watches')
  const resolveGithubCredential = createWatchGithubCredentialResolver(agentDir, permissions, github)
  return {
    resolveGithubCredential,
    async cleanup(id: string) {
      try {
        await withWatchDirectory(root, false, (parent) => rm(join(parent, id), { recursive: true, force: true }))
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err
      }
    },
    async run(w: WatchRecord, signal: AbortSignal): Promise<ProbeResult> {
      const origin = watchOrigin(w)
      if (w.wakeTarget.kind === 'channel') {
        // An unattended command cannot retain a human's old authority or
        // gain their new one. Custom role bags need not form a strict tower.
        const { key, requester, room } = w.wakeTarget
        const channel = {
          kind: 'channel',
          ...key,
          parentChat: room?.parentChat,
          lastInboundAuthorId: requester.authorId,
          lastInboundAuthorAdapter: requester.authorAdapter,
        } as const
        const current = permissions.describe(channel)
        const original = permissions.permissionsForRole(w.createdByRole)
        if (!original || !original.every((p) => current.permissions.includes(p))) {
          if (!original || !current.permissions.every((p) => original.includes(p)))
            throw new Error('Watch requester permissions changed; cancel and recreate the watch.')
          origin.scheduledByRole = current.role
        }
      }
      if (!permissions.has(origin, CORE_PERMISSIONS.watchCreate))
        throw new Error('Denied by watch.create; the creator no longer has this permission.')
      signal.throwIfAborted()
      if ('bundled' in w.probe) {
        const selfLogin = github.getSelf()?.login
        const ctx: BundledProbeContext<unknown> = {
          params: w.probe.target,
          state: w.state,
          lastRunAt: w.lastRunAt,
          startedAt: w.createdAt,
          ...(selfLogin === undefined ? {} : { selfLogin }),
          resolveTokenForRepo: (repo) => resolveGithubCredential(origin, repo),
          signal,
          fetch,
        }
        const result = await registry.get(w.probe.bundled).run(ctx)
        signal.throwIfAborted()
        return { ...result, state: z.json().parse(result.state) }
      }
      const dir = join(root, w.id)
      await withWatchDirectory(dir, true, async () => {})
      signal.throwIfAborted()
      const marker = crypto.randomUUID()
      // The sandbox uses the session ID as a directory name; the cron job
      // ID is provenance and deliberately retains its namespaced spelling.
      const sessionId = `watch-${w.id}`
      const bash = buildBuiltinPiToolOverrides({
        bashCwd: w.probe.cwd === undefined ? undefined : resolve(agentDir, w.probe.cwd),
        bashSandboxBoundary,
        agentDir,
        sessionId,
        hooks: hooks(),
        getOrigin: () => origin,
        getGithubSelf: github.getSelf,
        permissions,
        guards: buildInternalGuards(agentDir),
        frameBashOutput: (command) =>
          [
            `export TYPECLAW_WATCH_ID=${shellQuote(w.id)} TYPECLAW_WATCH_STATE_DIR=${shellQuote(dir)}`,
            w.lastRunAt === undefined
              ? 'unset TYPECLAW_WATCH_LAST_RUN_AT'
              : `export TYPECLAW_WATCH_LAST_RUN_AT=${shellQuote(new Date(w.lastRunAt).toISOString())}`,
            'err=$(mktemp) || exit 1',
            `trap 'rm -f -- "$err"' EXIT`,
            `printf '%s\\n' '${marker}'`,
            `bash -c ${shellQuote(command)} 2> "$err" | ${w.mode === 'diff' ? diffCapture : 'tail -c 8192'}`,
            'status=("${PIPESTATUS[@]}")',
            'test "${status[1]}" = 0 || exit 1',
            `printf '\\n%s\\n' '${marker}'`,
            'tail -c 8192 -- "$err"',
            `printf '\\n%s\\n%s\\n' '${marker}' "\${status[0]}"`,
          ].join('\n'),
      }).find((t) => t.name === 'bash')
      if (!bash) throw new Error('Sandboxed bash unavailable')
      // Each scheduled tick is a new turn; intentional polls are not agent loops.
      resetSharedLoopGuardSession(sessionId)
      // Pi's bash definition disables session metadata, so it needs no live
      // ExtensionContext. Only the wrapped builtin (not arbitrary tools) is invoked here.
      const result = await bash.execute(
        marker,
        { command: w.probe.command, timeout: 120 },
        signal,
        undefined,
        {} as Parameters<typeof bash.execute>[4],
      )
      signal.throwIfAborted()
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
      const [, stdout, stderr, exit] = text.split(marker)
      const code = Number(exit?.trim().split('\n')[0])
      if (stdout === undefined || stderr === undefined || !Number.isInteger(code))
        throw new Error(`Incomplete probe result: ${text.slice(-8192)}`)
      const output = stdout.slice(1, -1)
      const separator = w.mode === 'diff' ? output.indexOf('\n') : -1
      return parseProbeOutput(
        code,
        output.slice(separator + 1),
        stderr.trim(),
        w.mode,
        w.state,
        separator < 0 ? undefined : output.slice(0, separator),
      )
    },
  }
}
