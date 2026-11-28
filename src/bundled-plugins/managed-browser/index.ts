import { join } from 'node:path'

import { z } from 'zod'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import { fillSecretIntoFocusedField, type FillSecretOutcome } from '@/browser/fill-secret'
import { type ManagedBrowser, startManagedBrowser } from '@/browser/managed-browser'
import { answerPasskeyPrompt } from '@/browser/passkey'
import { BROWSER_ENGINES, type BrowserConfig, needsManagedBrowser } from '@/browser/registry'
import {
  planPasskeyRegistration,
  readPasskeyForSignIn,
  readVaultValue,
  recordPasskeySignIn,
  savePasskeyRegistration,
} from '@/bundled-plugins/typevault/runtime'
import { getConfig } from '@/config'
import { readEnvFile } from '@/init/env-file'
import type { PermissionService } from '@/permissions'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import { definePlugin, defineTool, type Hooks } from '@/plugin'
import { resolveFillableEnvNames, SECRET_ENV_PREFIX } from '@/sandbox/env-exposure'
import { isTypevaultLive } from '@/typevault/envelope-store'

const SKILLS_ROOT = join(import.meta.dir, 'skills')

export default definePlugin({
  plugin: async (ctx) => {
    // Boot snapshot: `browser` is restart-required, matching the image layers
    // and the browser process started below.
    const config = getConfig()
    const browser = config.browser
    const skillsDirs = browserSkillDirs(browser)
    const vaultLive = isTypevaultLive(config.typevault.enabled, ctx.agentDir)
    if (!needsManagedBrowser(browser, vaultLive)) return { skillsDirs }

    let managed: ManagedBrowser
    try {
      managed = await startManagedBrowser({ agentDir: ctx.agentDir, browser, logger: ctx.logger })
    } catch (error) {
      ctx.logger.error(`managed browser failed to start; browser engines are unavailable: ${String(error)}`)
      return { skillsDirs }
    }
    // Each session gets its own CDP URL so the tabs it opens close when it ends.
    const bashHook = sharedBrowserBashHook(ctx.permissions, (sessionId) =>
      browserEnvOverlay(browser, { ...managed, cdpUrl: managed.sessionCdpUrl(sessionId) }),
    )
    const fillGuard = fillSecretGuardHook(ctx.permissions)
    const passkeyGuard = passkeyGuardHook(ctx.permissions)

    return {
      skillsDirs,
      tools: {
        [FILL_SECRET_TOOL]: createFillSecretTool(managed.cdpUrl),
        // Passkeys live only in the vault, so without one the tool could do nothing but fail.
        ...(vaultLive ? { [PASSKEY_TOOL]: createPasskeyTool(managed.cdpUrl) } : {}),
      },
      hooks: {
        'tool.before': async (event, hookCtx) => {
          await bashHook(event, hookCtx)
          return (await fillGuard(event, hookCtx)) ?? passkeyGuard(event, hookCtx)
        },
        'session.end': (event) => managed.endSession(event.sessionId),
      },
      onDispose: () => managed.stop(),
    }
  },
})

export function sharedBrowserBashHook(
  permissions: PermissionService,
  overlayFor: (sessionId: string) => Record<string, string>,
): NonNullable<Hooks['tool.before']> {
  return (event) => {
    if (event.tool !== 'bash') return
    if (!permissions.has(event.origin, CORE_PERMISSIONS.browserShared)) return
    const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
    const current = existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}
    event.args[TYPECLAW_INTERNAL_BASH_ENV] = { ...current, ...overlayFor(event.sessionId) }
  }
}

export const FILL_SECRET_TOOL = 'browser_fill_secret'
const VAULT_REF_PREFIX = 'typevault://'

// The tool drives the shared browser, so it needs `browser.shared` like bash's
// CDP URL does. Typing the withheld TYPECLAW_SECRET_* tier is runtime-owned
// credential use, which `fs.see.secrets` authorizes; ordinary .env vars are
// already in that role's bash, so typing them needs nothing more. This gates
// who may USE a secret, not who may observe it: every `browser.shared` holder
// drives the same pages over CDP and can watch what is typed there.
export function fillSecretGuardHook(permissions: PermissionService): NonNullable<Hooks['tool.before']> {
  return (event) => {
    if (event.tool !== FILL_SECRET_TOOL) return
    if (!permissions.has(event.origin, CORE_PERMISSIONS.browserShared)) {
      return { block: true, reason: `${FILL_SECRET_TOOL} needs the ${CORE_PERMISSIONS.browserShared} permission` }
    }
    const name = event.args['name']
    if (typeof name === 'string' && name.startsWith(VAULT_REF_PREFIX)) {
      return permissions.has(event.origin, CORE_PERMISSIONS.vaultUse)
        ? undefined
        : { block: true, reason: `${VAULT_REF_PREFIX} values need the ${CORE_PERMISSIONS.vaultUse} permission` }
    }
    if (
      typeof name === 'string' &&
      name.startsWith(SECRET_ENV_PREFIX) &&
      !permissions.has(event.origin, CORE_PERMISSIONS.fsSeeSecrets)
    ) {
      return {
        block: true,
        reason: `${SECRET_ENV_PREFIX}* values need the ${CORE_PERMISSIONS.fsSeeSecrets} permission`,
      }
    }
  }
}

export function createFillSecretTool(
  cdpUrl: string,
  fill: typeof fillSecretIntoFocusedField = fillSecretIntoFocusedField,
) {
  return defineTool({
    description: [
      'Type the value of a .env variable into the focused field of a shared-browser tab without the value ever entering your context.',
      'Focus the field first with your browser engine (click it), then call this. Pass `url` (exact or prefix) when several tabs are open.',
      `Accepts any ordinary .env variable and the ${SECRET_ENV_PREFIX}* tier, which is hidden from bash and reachable only through this tool.`,
      `With TypeVault enabled, \`name\` can also be a vault reference such as ${VAULT_REF_PREFIX}github/bot#password, read through this session's grant.`,
      'With `submit: true` it presses Enter (submitting the form directly only if Enter did nothing) and waits for the page to navigate; if it does not, the field is cleared so the value is not left on the page.',
      'The result names the tab and field, never the value. Never read the field back, screenshot a non-password field after filling, or echo the variable.',
    ].join(' '),
    parameters: z.object({
      name: z
        .string()
        .describe(
          'The .env variable name, e.g. TYPECLAW_SECRET_GITHUB_PASSWORD, or a vault reference like typevault://github/bot#password',
        ),
      url: z.string().optional().describe('Exact URL or prefix of the target tab'),
      submit: z.boolean().default(false),
    }),
    fileOperands: { nonFile: ['name', 'url'] },
    execute: async (args, ctx) => {
      if (args.name.startsWith(VAULT_REF_PREFIX)) {
        const read = await readVaultValue(ctx.sessionId, args.name, 'fill a browser field')
        if (!read.ok) return text(`Not filled: ${read.reason}.`)
        const outcome = await fill({
          cdpUrl,
          value: read.value,
          submit: args.submit,
          ...(args.url === undefined ? {} : { url: args.url }),
        })
        return text(describeOutcome(args.name, outcome))
      }
      const fillable = new Set(resolveFillableEnvNames(readEnvFile(ctx.agentDir), process.env))
      if (!fillable.has(args.name)) {
        return text(
          `${args.name} is not a fillable variable: declare it with a non-empty value in .env (runtime controls are never fillable).`,
        )
      }
      const value = process.env[args.name]
      if (value === undefined || value.length === 0) {
        return text(
          `${args.name} is in .env but not loaded yet; the operator must restart the agent after editing .env.`,
        )
      }
      const outcome = await fill({
        cdpUrl,
        value,
        submit: args.submit,
        ...(args.url === undefined ? {} : { url: args.url }),
      })
      return text(describeOutcome(args.name, outcome))
    },
  })
}

export const PASSKEY_TOOL = 'browser_passkey'

// Every passkey action reads or writes the vault through the session's grant, so it needs `vault.use` as well as
// the shared browser, like a vault reference in `browser_fill_secret`.
export function passkeyGuardHook(permissions: PermissionService): NonNullable<Hooks['tool.before']> {
  return (event) => {
    if (event.tool !== PASSKEY_TOOL) return
    for (const permission of [CORE_PERMISSIONS.browserShared, CORE_PERMISSIONS.vaultUse]) {
      if (!permissions.has(event.origin, permission)) {
        return { block: true, reason: `${PASSKEY_TOOL} needs the ${permission} permission` }
      }
    }
  }
}

export function createPasskeyTool(cdpUrl: string, answer: typeof answerPasskeyPrompt = answerPasskeyPrompt) {
  return defineTool({
    description: [
      'Register or sign in with a passkey in a shared-browser tab, using a credential kept in the vault; the private key never enters your context.',
      'First focus the site\'s passkey button with your browser driver without clicking it (the "Create a passkey" button for `register`, "Sign in with a passkey" for `use`), then call this: it presses the button and answers the site\'s passkey prompt.',
      '`register` saves the new passkey to `name` (e.g. typevault://github/bot, or typevault://github/bot#work for a field other than `passkey`); `use` signs in with the passkey stored there.',
      'Pass `url` (exact or prefix) when several tabs are open.',
      'Chrome removes every virtual authenticator on a tab when any DevTools connection to it detaches, so this call also removes one your own browser driver added to that tab.',
    ].join(' '),
    parameters: z.object({
      action: z.enum(['register', 'use']),
      name: z.string().describe('Vault reference, e.g. typevault://github/bot'),
      url: z.string().optional().describe('Exact URL or prefix of the target tab'),
    }),
    fileOperands: { nonFile: ['name', 'url'] },
    execute: async (args, ctx) => {
      if (!args.name.startsWith(VAULT_REF_PREFIX)) {
        return text(`Not done: \`name\` must be a ${VAULT_REF_PREFIX} reference.`)
      }
      const tab = args.url === undefined ? {} : { url: args.url }
      if (args.action === 'register') {
        const planned = await planPasskeyRegistration(ctx.sessionId, args.name, 'register a passkey')
        if (!planned.ok) return text(`Not registered: ${planned.reason}.`)
        const outcome = await answer({ cdpUrl, ...tab })
        if (outcome.status === 'refused') return text(`Not registered: ${outcome.reason}.`)
        if (outcome.status === 'not-used') {
          return text(
            `Not registered: the page on ${outcome.url} did not ask to create a passkey; check that the focused button is the site's create-passkey button.`,
          )
        }
        const saved = await savePasskeyRegistration(
          ctx.sessionId,
          planned.plan,
          outcome.credential,
          URL.parse(outcome.url)?.origin,
        )
        return text(
          saved.ok
            ? `Registered a passkey for ${outcome.credential.rp_id} and saved it as ${saved.name}.`
            : `The site registered a passkey, but saving it failed: ${saved.reason}. Remove it from the site's account settings, since it can't be used again.`,
        )
      }
      const read = await readPasskeyForSignIn(ctx.sessionId, args.name, 'sign in with a passkey')
      if (!read.ok) return text(`Not signed in: ${read.reason}.`)
      const outcome = await answer({ cdpUrl, ...tab, credential: read.signIn.passkey })
      if (outcome.status === 'refused') return text(`Not signed in: ${outcome.reason}.`)
      if (outcome.status === 'not-used') {
        return text(
          `Not signed in: the page on ${outcome.url} did not ask for the passkey; check that the focused button starts the site's passkey sign-in.`,
        )
      }
      const recorded = await recordPasskeySignIn(ctx.sessionId, read.signIn, outcome.credential)
      return text(
        recorded.ok
          ? `Gave the page on ${outcome.url} a passkey assertion. Check the page to confirm the site signed you in.`
          : `Gave the page on ${outcome.url} a passkey assertion, but its sign count was not recorded: ${recorded.reason}. Check the page to confirm the site signed you in.`,
      )
    },
  })
}

function describeOutcome(name: string, outcome: FillSecretOutcome): string {
  switch (outcome.status) {
    case 'refused':
      return `Not filled: ${outcome.reason}.`
    case 'filled':
      return `Filled ${name} into ${outcome.field} on ${outcome.url}.`
    case 'submitted':
      return `Filled ${name} into ${outcome.field} on ${outcome.url} and submitted; the page navigated.`
    case 'not-navigated':
      return (
        `Filled ${name} into ${outcome.field} on ${outcome.url} and submitted, but the page did not navigate. ` +
        (outcome.cleared
          ? 'The field was cleared; check the page for an error.'
          : 'The field could not be cleared (cross-origin frame); check the page for an error.')
      )
  }
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

export function browserSkillDirs(browser: BrowserConfig): string[] {
  const ids = [...browser.engines.filter((id) => id !== 'agent-browser'), ...browser.extensions]
  // One root per id (skills/<id>/<skill>/SKILL.md) so disabled engines stay out of the catalog.
  return ids.map((id) => join(SKILLS_ROOT, id))
}

export function browserEnvOverlay(
  browser: BrowserConfig,
  managed: Pick<ManagedBrowser, 'cdpUrl' | 'filesDir' | 'bskRelay' | 'token'>,
) {
  const env: Record<string, string> = {
    TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl,
    TYPECLAW_BROWSER_FILES: managed.filesDir,
  }
  // agent-browser is in every image and bundled skills (qa, PDF) call it
  // directly, so it always joins the shared browser while one is running.
  for (const id of new Set(['agent-browser' as const, ...browser.engines])) {
    Object.assign(env, BROWSER_ENGINES[id].env(managed.cdpUrl))
  }
  if (managed.bskRelay !== undefined) {
    Object.assign(env, { TYPECLAW_BSK_RELAY: managed.bskRelay, TYPECLAW_BSK_TOKEN: managed.token })
  }
  return env
}
