import { z } from 'zod'

import { hooklessGitArgs } from '@/git/hookless'
import { withGitLock } from '@/git/mutex'
import { resolveAgentGit } from '@/git/resolve-agent-git'
import { definePlugin, type PluginContext, type SpawnSubagentOptions, type Subagent } from '@/plugin'

import { type BackupPushAuthDeps, makeDefaultAskPassEnsurer, resolveBackupPushAuthEnv } from './git-auth'
import { DEFAULT_GC_PACK_THRESHOLD } from './maintenance'
import { COMMIT_TIMEOUT_MS, makeDefaultGitSpawn, NETWORK_TIMEOUT_MS, runBackup, type BackupResult } from './runner'
import {
  cleanupMessageFile,
  type CommitMessagePayload,
  createCommitMessageSubagent,
  createDiagnoseFailureSubagent,
  type DiagnoseFailurePayload,
  ensureMessageDir,
  messageFilePath,
  readMessageFile,
} from './subagents'

const DEFAULT_IDLE_MS = 30_000
const MIN_IDLE_MS = 1_000

const SUBAGENT_BACKUP_RUNNER = 'backup'
const SUBAGENT_COMMIT_MESSAGE = 'backup-message'
const SUBAGENT_DIAGNOSE = 'backup-diagnose'

const SELF_INDUCED_SUBAGENT_NAMES = new Set<string>([
  SUBAGENT_BACKUP_RUNNER,
  SUBAGENT_COMMIT_MESSAGE,
  SUBAGENT_DIAGNOSE,
])

const backupConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    idleMs: z.number().int().min(MIN_IDLE_MS).default(DEFAULT_IDLE_MS),
    pushToOrigin: z.boolean().default(true),
    commitTimeoutMs: z.number().int().min(1).default(COMMIT_TIMEOUT_MS),
    networkTimeoutMs: z.number().int().min(1).default(NETWORK_TIMEOUT_MS),
    gcPackThreshold: z.number().int().min(0).default(DEFAULT_GC_PACK_THRESHOLD),
  })
  .default({
    enabled: true,
    idleMs: DEFAULT_IDLE_MS,
    pushToOrigin: true,
    commitTimeoutMs: COMMIT_TIMEOUT_MS,
    networkTimeoutMs: NETWORK_TIMEOUT_MS,
    gcPackThreshold: DEFAULT_GC_PACK_THRESHOLD,
  })

const runnerPayloadSchema = z.object({
  agentDir: z.string(),
  pushToOrigin: z.boolean(),
  gcPackThreshold: z.number().int().min(0),
})

type RunnerPayload = z.infer<typeof runnerPayloadSchema>

export default definePlugin({
  configSchema: backupConfigSchema,
  plugin: async (ctx) => {
    const enabled = ctx.config.enabled
    const idleMs = ctx.config.idleMs
    const pushToOrigin = ctx.config.pushToOrigin
    const gcPackThreshold = ctx.config.gcPackThreshold

    const activeTurns = new Set<string>()
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let pendingFire = false
    let inFlight = false

    const cancelTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    const fireIfQuiet = async (): Promise<void> => {
      if (!enabled) return
      if (inFlight) {
        pendingFire = true
        return
      }
      if (activeTurns.size > 0) return
      inFlight = true
      try {
        await ctx.spawnSubagent(
          SUBAGENT_BACKUP_RUNNER,
          {
            agentDir: ctx.agentDir,
            pushToOrigin,
            gcPackThreshold,
          } satisfies RunnerPayload,
          // The backup runner is a system-level operation that commits +
          // pushes on the operator's behalf. It runs after every idle
          // window regardless of which session caused activity, so it has
          // no single user session to inherit from. Mark it as TUI-equivalent
          // so it resolves to `owner` and can use git push, etc.
          { spawnedByOrigin: { kind: 'tui', sessionId: 'backup-runner' } },
        )
      } catch (err) {
        ctx.logger.error(`backup runner spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        inFlight = false
        if (pendingFire) {
          pendingFire = false
          if (activeTurns.size === 0) {
            queueMicrotask(() => {
              void fireIfQuiet()
            })
          }
        }
      }
    }

    const isSelfInducedTurn = (origin: { kind: string; subagent?: string } | undefined): boolean => {
      if (origin?.kind !== 'subagent') return false
      const sub = origin.subagent
      return sub !== undefined && SELF_INDUCED_SUBAGENT_NAMES.has(sub)
    }

    const runnerSubagent: Subagent<RunnerPayload> = {
      systemPrompt: '(backup runner — no LLM)',
      payloadSchema: runnerPayloadSchema,
      inFlightKey: (payload) => payload.agentDir,
      handler: async (sctx) => {
        const result = await runBackupOnce(sctx.payload, ctx)
        const summary = describeResult(result)
        ctx.logger.info(`[backup] ${summary}`)
      },
    }

    return {
      subagents: {
        [SUBAGENT_BACKUP_RUNNER]: runnerSubagent,
        [SUBAGENT_COMMIT_MESSAGE]: createCommitMessageSubagent(),
        [SUBAGENT_DIAGNOSE]: createDiagnoseFailureSubagent(),
      },
      hooks: {
        'session.turn.start': (event) => {
          if (isSelfInducedTurn(event.origin)) return
          activeTurns.add(event.sessionId)
          cancelTimer()
        },
        'session.turn.end': (event) => {
          if (isSelfInducedTurn(event.origin)) return
          activeTurns.delete(event.sessionId)
        },
        'session.end': (event) => {
          activeTurns.delete(event.sessionId)
        },
        'session.idle': () => {
          if (!enabled) return
          if (activeTurns.size > 0) return
          cancelTimer()
          idleTimer = setTimeout(() => {
            idleTimer = null
            void fireIfQuiet()
          }, idleMs)
        },
      },
    }
  },
})

async function runBackupOnce(
  payload: RunnerPayload,
  ctx: {
    agentDir: string
    logger: { info: (m: string) => void; warn: (m: string) => void }
    spawnSubagent: PluginContext['spawnSubagent']
    github: PluginContext['github']
  },
): Promise<BackupResult> {
  const messagePath = messageFilePath(payload.agentDir)
  await ensureMessageDir(messagePath)
  await cleanupMessageFile(messagePath)
  // Inherit the backup-runner's owner privileges for the message-picking
  // and diagnose subagents it spawns. Same rationale as the runner itself
  // — these are system-level operations on the operator's behalf.
  const inheritOwner: SpawnSubagentOptions = {
    spawnedByOrigin: { kind: 'tui', sessionId: 'backup-runner' },
  }

  // App-auth agents need a minted per-repo token for the runner's push (it
  // bypasses the bash tool's credential hook). Only computed when we'll push;
  // PAT/SSH/non-github fall back to null. Passed as `pushEnv` so the runner
  // applies it to push/fetch ONLY — never to local commands like `git commit`,
  // which can run repo-controlled hooks that would otherwise see the token.
  const pushEnv = payload.pushToOrigin
    ? ((await resolveBackupAuthEnv(payload.agentDir, ctx.github, ctx.logger)) ?? undefined)
    : undefined

  const result = await withGitLock(payload.agentDir, () =>
    runBackup(
      { cwd: payload.agentDir, pushToOrigin: payload.pushToOrigin, gcPackThreshold: payload.gcPackThreshold },
      {
        gitSpawn: makeDefaultGitSpawn(),
        pushEnv,
        logger: ctx.logger,
        pickCommitMessage: async ({ status, diffstat }) => {
          await cleanupMessageFile(messagePath)
          const messagePayload: CommitMessagePayload = {
            agentDir: payload.agentDir,
            status,
            diffstat,
            outputPath: messagePath,
          }
          try {
            await ctx.spawnSubagent(SUBAGENT_COMMIT_MESSAGE, messagePayload, inheritOwner)
          } catch (err) {
            ctx.logger.warn(
              `${SUBAGENT_COMMIT_MESSAGE} subagent failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          const written = await readMessageFile(messagePath)
          await cleanupMessageFile(messagePath)
          return written ?? 'chore: backup'
        },
        diagnoseFailure: async (input) => {
          const diagPayload: DiagnoseFailurePayload = {
            agentDir: input.cwd,
            stage: input.stage,
            exitCode: input.exitCode,
            stderr: input.stderr,
            stdout: input.stdout,
          }
          try {
            await ctx.spawnSubagent(SUBAGENT_DIAGNOSE, diagPayload, inheritOwner)
          } catch (err) {
            ctx.logger.warn(`${SUBAGENT_DIAGNOSE} subagent failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      },
    ),
  )

  await cleanupMessageFile(messagePath)
  return result
}

async function resolveBackupAuthEnv(
  agentDir: string,
  github: PluginContext['github'],
  logger: { warn: (m: string) => void },
): Promise<Record<string, string> | null> {
  const deps: BackupPushAuthDeps = {
    hasAppTokenResolver: github.hasAppTokenResolver,
    ghToken: process.env.GH_TOKEN,
    resolveTokenForRepo: github.resolveTokenForRepo,
    resolveOriginPushUrl,
    ensureAskPassHelper: makeDefaultAskPassEnsurer(),
  }
  try {
    return await resolveBackupPushAuthEnv(agentDir, deps)
  } catch {
    // Credential prep is best-effort: a resolver failure must not abort the
    // backup. Falls back to the runner's inherited env (commit still happens),
    // and the push's own failure path diagnoses if it then can't authenticate.
    // No slug/token/error detail is logged — those are credential-adjacent.
    logger.warn('GitHub backup auth unavailable; continuing with inherited git credentials')
    return null
  }
}

export async function resolveOriginPushUrl(cwd: string): Promise<string | null> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return null
  const repo = resolveAgentGit(cwd)
  if (!repo) return null
  try {
    const proc = bun.spawn({
      cmd: ['git', ...hooklessGitArgs(['-C', cwd, ...repo.gitArgs, 'remote', 'get-url', '--push', 'origin'])],
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    if ((await proc.exited) !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

function describeResult(r: BackupResult): string {
  if (r.ok) return r.kind
  return `failed (${r.kind}): ${r.reason}`
}
