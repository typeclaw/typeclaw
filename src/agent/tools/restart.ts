import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import { requestContainerRestart } from '@/agent/restart'
import type { RestartHandoffOrigin } from '@/agent/restart-handoff'
import type { Stream } from '@/stream'

const EXIT_DELAY_MS = 500

export type CreateRestartToolOptions = {
  containerName: string
  exit?: (code: number) => void
  hostdUrl?: string
  hostdToken?: string
  // Optional so unit tests and ad-hoc tool construction keep working without
  // building a Stream. In production wiring, every live AgentSession's
  // broadcast subscriber turns this signal into a transcript entry.
  stream?: Stream
  // Identifies the session whose `restart` tool execution fired the broadcast.
  // Subscribers compare against their own SessionManager.getSessionId() to
  // pick the right notice variant (proactive-confirmation for the originator,
  // do-not-acknowledge for siblings). Required when stream is set; without it
  // every session would get the sibling notice and the originator would never
  // confirm restart completion proactively — the exact bug this dispatch
  // fixes. Required even when stream is absent so the type stays simple and
  // the field's presence documents the runtime contract.
  originatingSessionId: string
  // Override the default 5s ACK budget. Production has no caller for this —
  // 5s is generous against a real hostd on the same host. Test-only seam:
  // restart.test.ts spawns a `Bun.serve` and awaits its HTTP roundtrip from
  // the same parallel-test-runner that hosts dozens of other workers
  // contending on libuv's I/O threads. Under that contention, an in-process
  // 127.0.0.1 fetch can occasionally exceed 5s and the test's `expect(ok:
  // true)` assertion flips to `ok: false, reason: 'daemon ack timeout'`.
  // Optional so production callers keep the 5s default unchanged.
  ackTimeoutMs?: number
  // Agent folder root. Required to write the cross-restart handoff file
  // (`<agentDir>/.typeclaw/restart-pending.json`) that lets the next
  // container reattach to the originating session and produce the
  // "I'm back" turn. Omit to skip the handoff write (used by sessions
  // whose origin is not TUI — see `originatingSessionFile` below — and
  // by ad-hoc tool construction in tests that do not need the handoff).
  agentDir?: string
  // Absolute path or basename of the originating session's JSONL file on
  // disk. Required alongside `agentDir` to enable the handoff; the new
  // container uses this to reopen the session via `SessionManager.open`
  // so the `typeclaw.restart-self` custom message entry that was just
  // appended is part of the LLM context on the next turn. When omitted,
  // no handoff is written — the new container cold-starts and no
  // "I'm back" greeting fires. Written for persisted TUI and channel
  // origins; cron/subagent/system origins pass undefined so the next boot
  // does not resume an unattended session.
  originatingSessionFile?: string
  // Which subsystem owns resuming the originating session on the next boot
  // (tui → websocket open handler; channel → channel router startup). Required
  // alongside `originatingSessionFile` for the handoff to be written; omit to
  // skip the handoff. See buildRestartHandoffWiring in src/agent/index.ts.
  handoffOrigin?: RestartHandoffOrigin
  // Resolves the LIVE turn author at execute time (not session-creation), so a
  // channel self-restart in a long-lived multi-principal session resumes under
  // the author of the turn that triggered the restart — not whoever opened the
  // session. Called inside execute(); returns undefined for tui/no-author
  // origins. See RestartHandoff.triggeringAuthorId.
  triggeringAuthorIdProvider?: () => string | undefined
}

export type RestartToolDetails = { ok: boolean; containerName: string; reason?: string }

export type { ContainerRestartingBroadcast } from '@/agent/restart'

export function createRestartTool({
  containerName,
  exit,
  hostdUrl,
  hostdToken,
  stream,
  originatingSessionId,
  ackTimeoutMs,
  agentDir,
  originatingSessionFile,
  handoffOrigin,
  triggeringAuthorIdProvider,
}: CreateRestartToolOptions) {
  const doExit = exit ?? ((code: number) => process.exit(code))

  return defineTool({
    name: 'restart',
    label: 'Restart Container',
    description:
      'Restart the typeclaw container this agent is running in. The host daemon ACKs the request, ' +
      'this process exits, and the host daemon then runs `typeclaw stop` followed by `typeclaw start` ' +
      'for the agent folder. Use when on-disk source has changed in a way that `reload` cannot pick up — ' +
      'e.g. the typeclaw CLI itself was updated, the Dockerfile template changed, or a boot-only config ' +
      'field needs to take effect (port, mounts, plugins). The current session is lost; the ' +
      'TUI must reconnect after the new container is up. Pass `build: true` to also rebuild the ' +
      'Docker image (equivalent to `typeclaw restart --build`) — required when a dependency in the ' +
      'Dockerfile template changed but the image already exists, since `start` only rebuilds if the ' +
      'image is missing or `build` is set.',
    parameters: Type.Object({
      build: Type.Optional(
        Type.Boolean({
          description:
            'When true, rebuild the Docker image (`docker build`) before starting the new container. ' +
            'Default false (reuse the existing image if present). Set this when the Dockerfile template ' +
            'or its inputs have changed since the image was last built.',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const build = params.build === true
      const triggeringAuthorId = triggeringAuthorIdProvider?.()
      // requestContainerRestart owns the post-ACK broadcast->handoff ordering:
      // on a successful ACK it publishes the container-restarting notice (which
      // every live session's subscribeRestartNotice turns into a transcript
      // entry) and then writes the handoff. Handoff fields are gated to TUI
      // origins by the caller passing originatingSessionFile only for those —
      // see issue #291's scoping concerns.
      const result = await requestContainerRestart({
        containerName,
        build,
        originatingSessionId,
        ...(hostdUrl !== undefined ? { hostdUrl } : {}),
        ...(hostdToken !== undefined ? { hostdToken } : {}),
        ...(ackTimeoutMs !== undefined ? { ackTimeoutMs } : {}),
        ...(stream !== undefined ? { stream } : {}),
        ...(agentDir !== undefined ? { agentDir } : {}),
        ...(originatingSessionFile !== undefined ? { originatingSessionFile } : {}),
        ...(handoffOrigin !== undefined ? { handoffOrigin } : {}),
        ...(triggeringAuthorId !== undefined ? { triggeringAuthorId } : {}),
      })
      if (!result.ok) {
        const details: RestartToolDetails = { ok: false, containerName, reason: result.reason }
        return {
          content: [{ type: 'text' as const, text: `restart denied: ${result.reason}` }],
          details,
        }
      }

      // Schedule the exit on the next tick so the tool result is delivered to
      // the model before the process dies. The host daemon polls for the
      // container's removal before re-running `start`, so a small delay here
      // does not gate the restart end-to-end.
      setTimeout(() => doExit(0), EXIT_DELAY_MS)

      const details: RestartToolDetails = { ok: true, containerName }
      const buildSuffix = build ? ' (with image rebuild)' : ''
      return {
        content: [
          {
            type: 'text' as const,
            text: `restart${buildSuffix} scheduled for ${containerName}; this process will exit shortly and a new container will be started by the host daemon.`,
          },
        ],
        details,
      }
    },
  })
}
