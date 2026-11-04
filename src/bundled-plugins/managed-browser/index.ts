import { join } from 'node:path'

import { z } from 'zod'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import { fillSecretIntoFocusedField, type FillSecretOutcome } from '@/browser/fill-secret'
import { type ManagedBrowser, startManagedBrowser } from '@/browser/managed-browser'
import { BROWSER_ENGINES, type BrowserConfig, needsManagedBrowser } from '@/browser/registry'
import { readVaultValue } from '@/bundled-plugins/typevault/runtime'
import { getConfig } from '@/config'
import { readEnvFile } from '@/init/env-file'
import type { PermissionService } from '@/permissions'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import { definePlugin, defineTool, type Hooks } from '@/plugin'
import { resolveFillableEnvNames, SECRET_ENV_PREFIX } from '@/sandbox/env-exposure'

const SKILLS_ROOT = join(import.meta.dir, 'skills')

export default definePlugin({
  plugin: async (ctx) => {
    // Boot snapshot: `browser` is restart-required, matching the image layers
    // and the browser process started below.
    const browser = getConfig().browser
    const skillsDirs = browserSkillDirs(browser)
    if (!needsManagedBrowser(browser)) return { skillsDirs }

    let managed: ManagedBrowser
    try {
      managed = await startManagedBrowser({ agentDir: ctx.agentDir, browser, logger: ctx.logger })
    } catch (error) {
      ctx.logger.error(`managed browser failed to start; browser engines are unavailable: ${String(error)}`)
      return { skillsDirs }
    }
    const overlay = browserEnvOverlay(browser, managed)
    const bashHook = sharedBrowserBashHook(ctx.permissions, overlay)
    const fillGuard = fillSecretGuardHook(ctx.permissions)

    return {
      skillsDirs,
      tools: { [FILL_SECRET_TOOL]: createFillSecretTool(managed.cdpUrl) },
      hooks: {
        'tool.before': async (event, hookCtx) => {
          await bashHook(event, hookCtx)
          return fillGuard(event, hookCtx)
        },
      },
      onDispose: () => managed.stop(),
    }
  },
})

export function sharedBrowserBashHook(
  permissions: PermissionService,
  overlay: Record<string, string>,
): NonNullable<Hooks['tool.before']> {
  return (event) => {
    if (event.tool !== 'bash') return
    if (!permissions.has(event.origin, CORE_PERMISSIONS.browserShared)) return
    const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
    const current = existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}
    event.args[TYPECLAW_INTERNAL_BASH_ENV] = { ...current, ...overlay }
  }
}

export const FILL_SECRET_TOOL = 'browser_fill_secret'
const VAULT_REF_PREFIX = 'tv://'

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
          'The .env variable name, e.g. TYPECLAW_SECRET_GITHUB_PASSWORD, or a vault reference like tv://github/bot#password',
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
