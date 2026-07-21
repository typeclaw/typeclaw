import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import {
  configureReviewVerdictCoordinator,
  createSharedReviewVerdictGuard,
} from '@/channels/github-review-verdict-coordinator'
import { hasEnvKey } from '@/init/env-file'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import { definePlugin } from '@/plugin'

import { createGithubEffectiveApprovalResolver, createGithubHeadShaResolver } from './effective-approval'
import {
  analyzeGhCommand,
  canInjectPatIntoPassThroughGh,
  containsGhCommandInvocation,
  effectiveGhTokensForAuthenticatedUserEndpoint,
  usesGhApiGraphqlEndpoint,
} from './gh-command'
import { defaultGitResolvers, resolveGhDefaultRepoFromCwd } from './git-command'
import { checkGraphqlAuthNudge } from './graphql-auth-nudge'
import { commitReviewIfSucceeded, noteReviewCommand } from './review-recorder'
import { classifyGhToken, shouldMintAppToken } from './token-class'

export default definePlugin({
  plugin: async (ctx) => {
    const resolveTokenForRepo = ctx.github.resolveTokenForRepo
    const hasAppTokenResolver = ctx.github.hasAppTokenResolver

    // Every model-driven bash masks the canonical credential files. A role may
    // still USE a PAT through this runtime-owned overlay, which injects one
    // value without exposing .env/secrets.json to the model. Gate that on the
    // existing credential capability rather than sandbox presence: privileged
    // roles are sandboxed for file masking too.
    const canUsePat = (origin: SessionOrigin | undefined): boolean =>
      ctx.permissions.has(origin, CORE_PERMISSIONS.fsSeeSecrets) ||
      ctx.permissions.has(origin, 'security.bypass.medium')

    const effectiveProcessToken = (): { envName: 'GH_TOKEN' | 'GITHUB_TOKEN'; value: string } | undefined => {
      if (process.env.GH_TOKEN !== undefined && process.env.GH_TOKEN !== '') {
        return { envName: 'GH_TOKEN', value: process.env.GH_TOKEN }
      }
      if (process.env.GITHUB_TOKEN !== undefined && process.env.GITHUB_TOKEN !== '') {
        return { envName: 'GITHUB_TOKEN', value: process.env.GITHUB_TOKEN }
      }
      return undefined
    }

    const processPatOverlay = (): Record<string, string> | undefined => {
      const token = effectiveProcessToken()
      if (token === undefined) return undefined
      const tokenClass = classifyGhToken(token.value)
      return tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat'
        ? { [token.envName]: token.value }
        : undefined
    }

    // The token `gh` will actually resolve INSIDE the low-trust sandbox. Only
    // `.env`-declared names survive `--clearenv` (`hasEnvKey` reads the same
    // `readEnvFile(agentDir)` parse the sandbox's `resolveExposableEnvNames` uses,
    // so this is congruent with what the sandbox inherits), and gh's precedence is
    // GH_TOKEN > GITHUB_TOKEN. So a process-only GH_TOKEN does NOT mask an
    // inheritable, operator-declared GITHUB_TOKEN: the process-only name is cleared,
    // leaving the declared alias as the one gh sees. Returns the surviving PAT/App
    // token (value snapshotted from process.env, which holds the declared value),
    // or undefined when the operator declared no usable GitHub token in `.env`.
    const sandboxInheritedGhToken = (): { envName: 'GH_TOKEN' | 'GITHUB_TOKEN'; value: string } | undefined => {
      for (const envName of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
        if (!hasEnvKey(ctx.agentDir, envName)) continue
        const value = process.env[envName]
        if (value !== undefined && value !== '') return { envName, value }
      }
      return undefined
    }

    // A process-only PAT (runtime-seeded process.env, NOT declared in `.env`)
    // is stripped by --clearenv for this role, and a PAT is not re-mintable per
    // repo, so there is no token to inject. Tell the AGENT (model-visible block)
    // instead of letting gh fail ambiguously — the silent variant of this is
    // exactly what caused a multi-day debugging hunt. This does NOT fire for a PAT
    // the operator declared in `.env`: that one is inherited into the sandbox and
    // handled by the allow-path above.
    const sandboxedPatWithheldReason =
      'A classic/fine-grained GitHub PAT is present in the runtime environment but was NOT declared ' +
      'in `.env`, and this command runs in a sandboxed (low-trust) role whose environment is cleared ' +
      'before bash — so the PAT is withheld here and is NOT available to gh. This is a deliberate ' +
      'guard, not missing auth: a broad, long-lived runtime PAT must not be reachable from a low-trust ' +
      'sandbox. Configure GitHub App auth (channels.github) for per-repo, short-lived tokens that work ' +
      'with validated gh calls in sandboxed roles, or declare the PAT in `.env` to deliberately expose it to model bash.'

    let warnedSandboxedPatWithheld = false
    const warnSandboxedPatWithheldOnce = (): void => {
      if (warnedSandboxedPatWithheld) return
      warnedSandboxedPatWithheld = true
      ctx.logger.warn(
        'GH_TOKEN (classic/fine-grained PAT) withheld from a sandboxed role: the env is cleared for ' +
          'low-trust bash, so gh has no credential. Configure GitHub App auth (channels.github) ' +
          'for per-repo tokens that work with validated gh calls in sandboxed roles.',
      )
    }
    // `/user` resolves the caller's USER identity. An App installation token is not
    // a user, so GitHub rejects it on a token-class basis (403, or no-token error in
    // the sandbox) no matter how valid the token is. We block-and-guide so the agent
    // does not misread this as "I have no auth" — it does, for repo-scoped calls.
    const appUserEndpointReason =
      '`gh api /user` (and `/user/...`) resolves the calling USER. This agent authenticates ' +
      'as a GitHub App with a per-repo installation token, which is not a user identity — so ' +
      '`/user` cannot work here, and this failure is NOT a sign that auth is missing (repo-' +
      'scoped calls still work). It is not a valid auth/login check. For repo data use ' +
      '`gh <cmd> -R owner/repo` or `gh api /repos/owner/repo/...`; for the actor, read the ' +
      'PR/issue/comment context you were given instead of `gh api /user`.'
    const patGraphqlReason =
      'Model-driven `gh api graphql` cannot receive a classic or fine-grained GitHub PAT because the query can ' +
      'target repositories that are not visible in argv; `-R owner/repo` is only a CLI hint, not an authorization ' +
      'boundary. Configure GitHub App auth so TypeClaw can mint a server-enforced single-repository installation ' +
      'token, use a statically repo-confined REST endpoint, or run the PAT-backed GraphQL command host-side.'
    const resolveToken = async (workspace: string) => {
      const result = await resolveTokenForRepo(workspace)
      return result.kind === 'token' ? result.token : null
    }
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: createGithubEffectiveApprovalResolver({
        resolveToken,
        selfLogin: ctx.github.getAppSelfLogin ?? (() => null),
        isAppAuth: hasAppTokenResolver,
      }),
      resolveHeadSha: createGithubHeadShaResolver({ resolveToken }),
    })
    const verdictGuard = createSharedReviewVerdictGuard()

    type HookResult = void | { block: true; reason: string }

    // A TRUSTED repo to fill in for a repo-less `gh` command, resolved from
    // sources the command author cannot forge: (1) a GitHub channel session's
    // own repo (origin.workspace comes from the signed webhook payload), then
    // (2) the working tree's `origin` remote. NOT from any `-R`/path in the
    // command (that is the attacker-controllable input the parser already
    // handles). The slug is still gated by the repos[] allowlist at mint time.
    const resolveTrustedFallbackRepo = async (origin: SessionOrigin | undefined): Promise<string | undefined> => {
      if (origin?.kind === 'channel' && origin.adapter === 'github' && origin.workspace !== '') {
        return origin.workspace
      }
      const fromCwd = await resolveGhDefaultRepoFromCwd(ctx.agentDir, defaultGitResolvers)
      return fromCwd ?? undefined
    }

    // When a repo-less `gh` is blocked but a trusted repo IS available, show the
    // exact single-bare rewrite so the agent recovers in one step instead of
    // guessing. Composition blocks get a split-the-script instruction. The
    // returned text is appended to the block reason (synchronous, always seen).
    const buildGhBlockGuidance = (code: string, fallbackRepo: string | undefined): string => {
      const slug = fallbackRepo ?? 'owner/repo'
      if (code === 'composition') {
        return (
          ` Run each gh as its own single bare command, e.g. \`gh label edit <name> -R ${slug} --name ...\` —` +
          ' not inside a function, `if`/`then`, `&&`, `;`, or `$(...)`.'
        )
      }
      return ` For example: \`gh <cmd> -R ${slug}\` as a single bare command.`
    }

    // 'fall-through' means "not a repo-targeting gh command" so the caller leaves
    // the bash command untouched (including commands that merely contain `gh`).
    const handleGhCommand = async (params: {
      event: { callId: string; args: Record<string, unknown>; origin?: SessionOrigin }
      command: string
    }): Promise<HookResult | 'fall-through'> => {
      const { event, command } = params
      // Analyze first WITHOUT the fallback: an explicit `-R`/path repo must win,
      // and we only pay for fallback resolution (a git subprocess) when the
      // command is otherwise repo-less. A trusted fallback is then applied ONLY to
      // a `missing-repo` block (never to composition/non-literal/multi-owner/api),
      // and re-analysis re-runs the SAME composition gate, so a compound command
      // still blocks. `fallbackRepoUsed` marks an inject that came from the
      // fallback so we also set GH_REPO (gh needs the repo, not just the token).
      let decision = analyzeGhCommand(command)
      let fallbackRepo: string | undefined
      let fallbackRepoUsed = false
      if (decision.kind === 'block' && decision.code === 'missing-repo') {
        fallbackRepo = await resolveTrustedFallbackRepo(event.origin)
        if (fallbackRepo !== undefined) {
          const withFallback = analyzeGhCommand(command, fallbackRepo)
          if (withFallback.kind === 'inject') {
            decision = withFallback
            fallbackRepoUsed = true
          }
        }
      }

      // Reject every statically unsafe/conflicting shape before review detection.
      // noteReviewCommand may open an --input file, and verdictGuard.guard performs
      // authenticated GitHub reads through the token resolver; neither may run for
      // a command the argv/repository authorization layer already rejects.
      if (decision.kind === 'block') {
        return {
          block: true,
          reason:
            decision.code === 'credential-display'
              ? decision.reason
              : decision.reason + buildGhBlockGuidance(decision.code, fallbackRepo),
        }
      }

      const review = await noteReviewCommand({ callId: event.callId, command })
      // guard() holds the lease expecting tool.after to release it. A later
      // tool.before block means tool.after never fires, so blockAfterLease()
      // releases the lease with succeeded:false. The static command analyzer runs
      // above and never claims a lease for a command it will reject.
      let leaseClaimed = false
      const blockAfterLease = async (block: HookResult & { block: true }): Promise<HookResult> => {
        if (leaseClaimed) await verdictGuard.release({ callId: event.callId, succeeded: false })
        return block
      }
      if (review.detected !== null) {
        const block = await verdictGuard.guard({
          callId: event.callId,
          workspace: review.detected.workspace,
          prNumber: review.detected.prNumber,
          verdict: review.detected.verdict,
        })
        if (block !== null) return block
        leaseClaimed = true
      }
      if (review.dump !== null) return blockAfterLease(review.dump)

      // `/user` classifies as pass-through (no repo to mint for), so this block
      // must run BEFORE the pass-through return. Resolve the EFFECTIVE token per
      // `/user` invocation (a command-local `GH_TOKEN=…`/`GITHUB_TOKEN=…` overrides
      // process env, matching gh) and block only when that token is App / none-with-
      // minter — a command-local PAT override carries a user identity, so `/user`
      // works for it and must not be blocked.
      const userEndpointTokens = effectiveGhTokensForAuthenticatedUserEndpoint(command, {
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      })
      if (userEndpointTokens.some((token) => shouldMintAppToken(token, hasAppTokenResolver()))) {
        return blockAfterLease({ block: true, reason: appUserEndpointReason })
      }

      const processToken = effectiveProcessToken()
      const tokenClass = classifyGhToken(processToken?.value)
      if (
        (tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat') &&
        canUsePat(event.origin) &&
        usesGhApiGraphqlEndpoint(command)
      ) {
        return blockAfterLease({ block: true, reason: patGraphqlReason })
      }

      if (decision.kind === 'pass-through') {
        const patOverlay = canUsePat(event.origin) ? processPatOverlay() : undefined
        if (patOverlay !== undefined) {
          if (!canInjectPatIntoPassThroughGh(command)) {
            return blockAfterLease({
              block: true,
              reason:
                'A GitHub PAT can only be brokered to a single standalone known-safe `gh` command. ' +
                'Chaining, substitution, aliases, extensions, and config/auth management are blocked because a sibling or plugin could read the command-scoped token.',
            })
          }
          const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
          const overlay = existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}
          event.args[TYPECLAW_INTERNAL_BASH_ENV] = { ...overlay, ...patOverlay }
        }
        return 'fall-through'
      }

      // The `-R` strip is a pure syntax fix (`gh api` rejects `-R`), independent
      // of token minting, so apply it for EVERY token class — including the PAT
      // paths below that return without injecting. Only `inject` decisions carry
      // `rewrittenCommand`, and only after the single-bare/safe-pipeline gate in
      // analyzeGhCommand, so this never rewrites a blocked or unsafe shape.
      if (decision.kind === 'inject' && decision.rewrittenCommand !== undefined) {
        event.args.command = decision.rewrittenCommand
      }

      // When NO per-repo App minter is available, prefer the token the operator
      // deliberately exposed via `.env`: the sandbox inherits it into bash for
      // EVERY role, so the validated command just runs on it — no block, no
      // overlay except GH_REPO (non-secret) for a trusted-fallback repo. This runs
      // BEFORE the process-token-class branches so it is independent of gh's
      // GH_TOKEN>GITHUB_TOKEN process preference: an undeclared (process-only)
      // GH_TOKEN — even App-class `ghs_` — never masks a declared, inheritable
      // GITHUB_TOKEN, because sandboxInheritedGhToken() only considers names that
      // survive --clearenv. When a minter IS available it wins (least-privilege
      // short-lived per-repo token over a broad declared PAT) via the paths below.
      if (!hasAppTokenResolver() && sandboxInheritedGhToken() !== undefined) {
        if (decision.kind === 'inject' && fallbackRepoUsed && fallbackRepo !== undefined) {
          event.args[TYPECLAW_INTERNAL_BASH_ENV] = { GH_REPO: fallbackRepo }
        }
        return
      }

      // PAT classes (classic = cross-owner, fine-grained) are not re-minted per
      // repo; the process GH_TOKEN is the only token we have. App minting, when
      // available, is preferred for ALL roles (least-privilege per-repo token over
      // a broad PAT), so a PAT must not suppress minting. An entitled role with NO
      // minter receives the PAT through the narrow overlay; raw process.env and
      // credential files remain unavailable inside bash. Sandboxed PAT-only with no
      // minter and no `.env` declaration: block with guidance instead of failing
      // silently.
      // Set when a sandboxed PAT falls through to App minting: the tail's
      // shouldMintAppToken(process.env.GH_TOKEN) re-check would see the PAT and
      // bail, so this flag forces the mint that the PAT must not suppress.
      let mintForSandboxedPat = false
      if (tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat') {
        // Credential-entitled role, NO App minter: inject the PAT through the
        // runtime-owned overlay. Gated on `!hasAppTokenResolver()` — when a minter
        // is available it wins, so a declared/entitled PAT does not beat the
        // least-privilege per-repo App token; execution falls through to minting.
        if (canUsePat(event.origin) && !hasAppTokenResolver()) {
          if (decision.kind === 'inject') {
            event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
              [processToken?.envName ?? 'GH_TOKEN']: processToken?.value ?? '',
              ...(fallbackRepoUsed && fallbackRepo !== undefined ? { GH_REPO: fallbackRepo } : {}),
            }
          }
          return
        }
        // Sandboxed PAT, no minter, not declared in `.env`: the sandbox clears it
        // for this role, so there is no inheritable token. Block with guidance
        // rather than failing mute. (A declared `.env` PAT already returned via the
        // sandbox-inherited allow-path above; an available minter falls through.)
        if (!shouldMintAppToken(undefined, hasAppTokenResolver())) {
          warnSandboxedPatWithheldOnce()
          return blockAfterLease({ block: true, reason: sandboxedPatWithheldReason })
        }
        mintForSandboxedPat = true
      }

      // No App auth (no App-class GH_TOKEN and no live minter): leave whatever
      // is seeded so `gh` fails honestly rather than us guessing a token. The
      // sandboxed-PAT mint path bypasses this PAT-class re-check via the flag.
      if (!mintForSandboxedPat && !shouldMintAppToken(processToken?.value, hasAppTokenResolver())) return

      const result = await resolveTokenForRepo(decision.repoSlug)
      if (result.kind === 'unavailable') return blockAfterLease({ block: true, reason: result.reason })
      // Inject via the internal env overlay (delivered to the spawn / bwrap
      // --setenv by the bash wrapper) so the token never enters the command
      // string, where it could leak through logs or later hooks. When the repo
      // came from a trusted fallback (not an explicit -R), also set GH_REPO so
      // `gh` actually targets it — a token alone leaves the repo unresolved.
      // GH_REPO is non-secret; the token still scopes reach to that repo.
      event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
        GH_TOKEN: result.token,
        ...(fallbackRepoUsed ? { GH_REPO: decision.repoSlug } : {}),
      }
      return
    }

    return {
      hooks: {
        'tool.before': async (event) => {
          if (event.tool !== 'bash') return
          const command = event.args.command
          if (typeof command !== 'string') return

          if (containsGhCommandInvocation(command)) {
            const ghResult = await handleGhCommand({ event, command })
            if (ghResult !== 'fall-through') return ghResult
          }

          return
        },
        'tool.after': async (event) => {
          checkGraphqlAuthNudge({ tool: event.tool, result: event.result })
          const review = commitReviewIfSucceeded({
            sessionId: event.sessionId,
            callId: event.callId,
            result: event.result,
          })
          await verdictGuard.release({ callId: event.callId, succeeded: review.committed })
          // A backstop-recovered verdict had no guard() reservation, so release()
          // could not arm the lag shield — do it explicitly here so the next
          // same-commit submission is deduped.
          if (review.landedFromResult !== null) {
            await verdictGuard.noteLandedReview(review.landedFromResult)
          }
        },
      },
    }
  },
})
