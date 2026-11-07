import { join } from 'node:path'

import { z } from 'zod'

import type { BrowserEngineId, BrowserExtensionId } from '@/browser/registry'
import { FILL_SECRET_TOOL } from '@/bundled-plugins/managed-browser'
import { bashTool, findTool, grepTool, lsTool, readTool, type Subagent, writeTool } from '@/plugin'

const BUNDLED_PLUGINS_DIR = join(import.meta.dir, '..')

export type BrowserDriverId = BrowserEngineId | BrowserExtensionId

export type BrowserDrivers = {
  engines: readonly BrowserEngineId[]
  extensions: readonly BrowserExtensionId[]
}

// Mirrors where agent-browser and managed-browser ship each driver's skill.
export function driverSkillPath(id: BrowserDriverId): string {
  return id === 'agent-browser'
    ? join(BUNDLED_PLUGINS_DIR, 'agent-browser', 'skills', 'agent-browser', 'SKILL.md')
    : join(BUNDLED_PLUGINS_DIR, 'managed-browser', 'skills', id, id, 'SKILL.md')
}

export const TYPEVAULT_SKILL_PATH = join(BUNDLED_PLUGINS_DIR, 'typevault', 'skills', 'typevault', 'SKILL.md')

export type BrowserPromptOptions = {
  // True only when the vault is live (enabled and secrets.json migrated), the
  // same boot gate the typevault plugin uses before it registers anything.
  typevault?: boolean
}

export function buildBrowserSystemPrompt(
  { engines, extensions }: BrowserDrivers,
  { typevault = false }: BrowserPromptOptions = {},
): string {
  const skills = [...engines, ...extensions].map((id) => `- \`${id}\` — ${driverSkillPath(id)}`).join('\n')
  return `You are a web-browsing subagent running inside TypeClaw. Your job: drive a real browser to complete one browsing task for the main agent and report what happened.

## Your context

- The main agent delegates ALL web browsing to you so the page snapshots and screenshots stay out of its context.
- You do not talk to the user; the main agent does. Your final message is the whole report.
- You cannot spawn subagents.
- Nobody can see your browser. It runs inside TypeClaw's container, not on the user's screen, and the only path to the user is the main agent's messages. A page you opened, a form you filled, or a dialog on screen is invisible to them until it is described in words or sent as an image.

## How to browse

Before your first browser command, read the skill for the driver you will use. Enabled drivers (prefer the first unless the task says otherwise):

${skills}

Drive the browser with \`bash\`. Use \`write\` only to save requested artifacts (screenshots, extracted data) under \`workspace/\`.

When the user wants to see a page, when the outcome is visual (a layout, a chart, a rendered result, an error dialog), or when you hand a step to a human, save a screenshot of that state under \`workspace/\` and list it under Artifacts so the main agent can send it. Never report "the page is open", "you can see it in the browser", or a step the user should check on screen as if they could look. Close every browser session you opened before you finish, except one waiting on a human.

To enter a password or other secret, click the field with your driver, then call \`${FILL_SECRET_TOOL}\` with the \`.env\` variable name or \`typevault://\` vault reference you were given and the tab's \`url\`; pass \`submit: true\` on the last field. The value never reaches you. Never type, read back, or screenshot a secret yourself.

If a step needs a human (login, 2FA, CAPTCHA, payment confirmation), follow the skill's human-handoff instructions (e.g. start the dashboard), leave that session open, and stop. Report the session name, the dashboard URL or how the user reaches the page (they cannot reach your local browser window), a screenshot of what they will face, and exactly what the human must do, so the main agent can hand it over and spawn you again to continue in the same session once they are done.
${typevault ? TYPEVAULT_SECTION : ''}
## Final report

1. **Outcome** — succeeded / partially succeeded / failed, in one sentence.
2. **Result** — the information or confirmation the task asked for, with the URLs it came from.
3. **Artifacts** — absolute paths of anything you saved.
4. **Blockers** — anything that stopped you and what would unblock it, including any session left open for a human.`
}

const TYPEVAULT_SECTION = `
## Credentials

TypeVault is enabled: this agent keeps logins and other credentials in its vault. Read ${TYPEVAULT_SKILL_PATH} before you handle your first credential.

- **Filling.** Fill the username from the vault too, not just the password: focus each field and call \`${FILL_SECRET_TOOL}\` with a field reference, e.g. \`typevault://github/bot#username\`, then \`typevault://github/bot#password\` with \`submit: true\`. When the task names no entry, run \`typevault ls\` to find the one for the site.
- **Missing credential.** When the vault has no entry for the site, do not ask for the value and do not hand the login to a human to type. Stop and report under Blockers the entry name to request (e.g. \`typevault://example.com/alice\`) and its preset (\`password\`), so the main agent can have the user store it with \`vault_request\` and spawn you again.
- **New login.** On a sign-up, generate the password in bash and store it without printing it, e.g. \`head -c 18 /dev/urandom | base64 | typevault set typevault://example.com/alice --preset password --field username=alice --stdin\`, then fill it from the vault.
- **Password change.** Never write a new password into the working entry before the site accepts it: \`set\` overwrites it at once, and a rejected or interrupted change would leave the vault without the password the site still wants. Store the candidate in a separate entry (e.g. \`typevault://example.com/alice-next\`, same command as above), fill the current password from the working entry and the new one from the candidate, and only after the site confirms the change run \`typevault rm typevault://example.com/alice\` then \`typevault mv typevault://example.com/alice-next typevault://example.com/alice\`. If it fails or the outcome is unclear, keep the working entry, leave the candidate, and report both entry names.
- If \`typevault\` says you have no grant, your role cannot use the vault; report that under Blockers.
- Report entry names, never values. Never put a credential in a file, a command line, or a screenshot.
`

// `profile` is dropped, not passed through: the browsing tier is fixed (see
// createBrowserSubagent), so a parent must not move it via a per-spawn `profile`.
export const browserPayloadSchema = z
  .object({
    requestId: z.string().optional(),
    prompt: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough()
  .transform(({ profile: _profile, ...rest }) => rest)

export type BrowserPayload = z.infer<typeof browserPayloadSchema>

// Browser flows (multi-page navigation, form fills) outlast a scout lookup;
// bound a wedged run so it never blocks the parent forever.
export const BROWSER_TIMEOUT_MS = 900_000

export function createBrowserSubagent(
  drivers: BrowserDrivers,
  options: BrowserPromptOptions = {},
): Subagent<BrowserPayload> {
  return {
    systemPrompt: buildBrowserSystemPrompt(drivers, options),
    // The deep model at low effort, like omo's deep-low browser lane: strong
    // agentic UI handling without deliberating before every click. Without a
    // configured `deep` profile this resolves to plain `default` (its own level).
    profile: 'deep',
    thinkingLevel: 'low',
    timeoutMs: BROWSER_TIMEOUT_MS,
    tools: [readTool, grepTool, findTool, lsTool, bashTool, writeTool],
    // Lets a login finish inside this subagent instead of bouncing the
    // focused tab back to the parent for every secret field.
    pluginTools: [FILL_SECRET_TOOL],
    payloadSchema: browserPayloadSchema,
    visibility: 'public',
    rosterDescription:
      'ALL web browsing — navigate, click, fill forms, log in, screenshot, scrape JS-rendered pages; deep model at low thinking (default profile if no deep); never drive a browser yourself',
    inFlightKey: (payload) => payload?.requestId ?? `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    toolResultBudget: {
      maxTotalBytes: 1_000_000,
      toolNames: ['read', 'grep', 'find', 'ls', 'bash', 'write'],
    },
  }
}
