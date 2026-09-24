import { isCancel, log, note, password, select, text } from '@clack/prompts'

import type { OAuthCallbacks } from '@/init/oauth-login'

// Shared between `typeclaw init` (src/cli/init.ts) and `typeclaw provider
// add/set` (src/cli/provider.ts). Both call into the same OAuth runner, so
// they need to render the same UX: a note() box with the URL + cross-device
// guidance, a select() prompt for provider-defined choices, a text() prompt
// for the post-callback manual fallback, and a concurrent onManualCodeInput
// prompt for users whose browser is on a different host than the CLI. See
// src/init/oauth-login.ts for the contract on each callback and why
// onManualCodeInput is required for cross-device.
//
// Returns `{ callbacks, dispose }` rather than bare callbacks because pi-ai
// races `onManualCodeInput()` against the local callback server. Pi 0.87 aborts
// the losing manual prompt through its prompt signal (pi-ai
// dist/auth/oauth/anthropic.js:216-221,266); dispose remains a fallback for
// callers that end OAuth before pi reaches that race. Each call site
// (init/provider) MUST call `dispose()` in a finally after the OAuth runner
// returns so any still-live clack prompt is cancelled cleanly.
export type OAuthCallbackHandle = {
  callbacks: OAuthCallbacks
  dispose: () => void
}

export function buildOAuthCallbacks(providerName: string): OAuthCallbackHandle {
  const controller = new AbortController()
  const { signal } = controller
  const promptSignal = (upstream?: AbortSignal): AbortSignal =>
    upstream === undefined ? signal : AbortSignal.any([signal, upstream])
  return {
    dispose: () => controller.abort(),
    callbacks: {
      onAuth: (url, instructions) => {
        // Don't put the URL inside note(): clack wraps long lines with the box
        // border `│` on each wrapped segment, which corrupts the URL when the
        // user copy-pastes it. Keep instructional text in the box, but print
        // the URL itself as a bare console.log line that any terminal will
        // hyperlink intact.
        const preamble = [
          `Open this URL in your browser to sign in to ${providerName}.`,
          '',
          'If the page after sign-in shows a code to copy (or a "this site can\'t',
          'be reached" / "could not establish connection" error), copy that code —',
          'or the full address from the top of the browser — and paste it below.',
        ]
        if (instructions) preamble.push('', instructions)
        note(preamble.join('\n'), 'Browser login')
        console.log(url)
        console.log('')
      },
      onProgress: (message) => {
        log.info(message)
      },
      onPrompt: async (message, placeholder, upstreamSignal) => {
        const value = await text({
          message,
          signal: promptSignal(upstreamSignal),
          ...(placeholder !== undefined ? { placeholder } : {}),
        })
        if (isCancel(value)) return null
        return value
      },
      // clack's password() has no placeholder option (PasswordOptions).
      onSecret: async (message, _placeholder, upstreamSignal) => {
        const value = await password({ message, signal: promptSignal(upstreamSignal) })
        if (isCancel(value)) return null
        return value
      },
      onSelect: async (message, options, upstreamSignal) => {
        const value = await select({
          message,
          options: options.map((option) => ({
            value: option.id,
            label: option.label,
            hint: option.description,
          })),
          signal: promptSignal(upstreamSignal),
        })
        if (isCancel(value)) return null
        return value
      },
      onManualCodeInput: async (upstreamSignal) => {
        const value = await text({
          message:
            'After signing in, paste the code shown on the page (some providers offer a copy button), or the full redirect address from the top of the browser:',
          placeholder: 'code, or http://localhost:1455/auth/callback?code=...&state=...',
          signal: promptSignal(upstreamSignal),
        })
        if (isCancel(value)) throw new Error('Login cancelled by user')
        return value
      },
    },
  }
}
