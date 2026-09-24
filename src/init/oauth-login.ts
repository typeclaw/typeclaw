import { join } from 'node:path'

import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import {
  KNOWN_PROVIDERS,
  providerForModelRef,
  supportsOAuth,
  type KnownProviderId,
  type ModelRef,
} from '@/config/providers'
import { createSecretsStoreForAgent } from '@/secrets'

export type OAuthLoginResult = { ok: true } | { ok: false; reason: string }

export type OAuthLoginRunner = (options: { cwd: string; model: ModelRef | string }) => Promise<OAuthLoginResult>

// Wrap pi-ai's OAuth callbacks so the CLI doesn't have to know about the
// upstream callback shape. The CLI sees five lifecycle events:
// (1) onAuth(url) — print the URL the user must visit
// (2) onProgress(message) — show waiting/finalizing status
// (3) onSelect(message, options) — choose a provider-defined option by ID
// (4) onPrompt(prompt) — ask the user for a manual code if the browser flow
//     can't reach the local callback server. Fires only after the local
//     server gave up (bind error -> waitForCode resolves null).
// (5) onManualCodeInput() — concurrent paste input that RACES the local
//     callback server. Required for cross-device flows: pi-ai's openai-codex
//     OAuth hardcodes redirect_uri=http://localhost:1455/auth/callback, which
//     resolves to the *browser's* machine. When the user runs `typeclaw init`
//     over SSH or on a remote dev box and completes login on a different
//     laptop, the browser callback never reaches the CLI's local server and
//     waitForCode() hangs forever — so onPrompt would never fire either.
//     onManualCodeInput is the upstream-supported escape hatch: it shows a
//     paste field IMMEDIATELY alongside the URL, and whichever path lands a
//     code first wins. parseAuthorizationInput on the upstream side accepts
//     the full redirect URL, the bare `code=...&state=...` query string, or
//     just the code value.
export type OAuthSelectOption = Extract<AuthPrompt, { type: 'select' }>['options'][number]

export type OAuthCallbacks = {
  onAuth: (url: string, instructions?: string) => void
  onProgress?: (message: string) => void
  onPrompt: (message: string, placeholder?: string, signal?: AbortSignal) => Promise<string | null>
  onSecret: (message: string, placeholder?: string, signal?: AbortSignal) => Promise<string | null>
  onSelect: (
    message: string,
    options: readonly OAuthSelectOption[],
    signal?: AbortSignal,
  ) => Promise<OAuthSelectOption['id'] | null>
  onManualCodeInput?: (signal?: AbortSignal) => Promise<string>
}

// Default runner: real OAuth flow against pi-ai. Tests inject a stub to skip
// network entirely. The runner's only job is to log in, write to the secrets
// file, and report ok/error — it does NOT update typeclaw.json (the model
// ref is already chosen by the caller and written by `scaffold`).
export function makeOAuthLoginRunner(callbacks: OAuthCallbacks): OAuthLoginRunner {
  return async ({ cwd, model }) => {
    const providerId = providerForModelRef(model)
    const provider = KNOWN_PROVIDERS[providerId]
    if (!supportsOAuth(provider) || !provider.oauthProviderId) {
      return { ok: false, reason: `Provider ${provider.name} does not support OAuth` }
    }

    try {
      const modelRuntime = await ModelRuntime.create({
        credentials: createSecretsStoreForAgent(join(cwd, 'secrets.json')),
        modelsPath: null,
        refreshOnCreate: false,
      })
      await modelRuntime.login(provider.oauthProviderId, 'oauth', createOAuthInteraction(callbacks))
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

// Isolate the pi 0.87 AuthInteraction adaptation so manual-code prompt
// cancellation and callback forwarding remain behavior-testable without a
// live provider login.
export function createOAuthInteraction(callbacks: OAuthCallbacks): AuthInteraction {
  return {
    notify: (event) => {
      if (event.type === 'auth_url') callbacks.onAuth(event.url, event.instructions)
      else if (event.type === 'progress') callbacks.onProgress?.(event.message)
      else if (event.type === 'device_code') callbacks.onAuth(event.verificationUri, `Enter code ${event.userCode}`)
    },
    prompt: async (prompt) => {
      if (prompt.type === 'select') {
        const value = await callbacks.onSelect(prompt.message, prompt.options, prompt.signal)
        // pi-ai 0.87 requires select prompts to resolve with an option ID
        // (dist/auth/types.d.ts:153-155); reject stale/corrupt UI values as cancellation.
        if (value === null || !prompt.options.some((option) => option.id === value)) {
          throw new Error('Login cancelled by user')
        }
        return value
      }
      if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
        return await callbacks.onManualCodeInput(prompt.signal)
      }
      const callback = prompt.type === 'secret' ? callbacks.onSecret : callbacks.onPrompt
      if (prompt.type === 'text' || prompt.type === 'secret' || prompt.type === 'manual_code') {
        const value = await callback(prompt.message, prompt.placeholder, prompt.signal)
        if (value === null) throw new Error('Login cancelled by user')
        return value
      }
      const unknownPrompt: never = prompt
      throw new Error(`Unsupported OAuth prompt type: ${unknownPrompt}`)
    },
  }
}

// Test seam: lets unit tests assert "OAuth login was invoked with these
// params" without spinning up a real secrets store / browser callback server.
export type FakeOAuthLoginRunnerOptions = {
  result?: OAuthLoginResult
  onCalled?: (options: { cwd: string; model: ModelRef | string; providerId: KnownProviderId }) => void
}

export function makeFakeOAuthLoginRunner(options: FakeOAuthLoginRunnerOptions = {}): OAuthLoginRunner {
  return async ({ cwd, model }) => {
    const providerId = providerForModelRef(model)
    options.onCalled?.({ cwd, model, providerId })
    return options.result ?? { ok: true }
  }
}
