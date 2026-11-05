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

export function buildBrowserSystemPrompt({ engines, extensions }: BrowserDrivers): string {
  const skills = [...engines, ...extensions].map((id) => `- \`${id}\` — ${driverSkillPath(id)}`).join('\n')
  return `You are a web-browsing subagent running inside TypeClaw. Your job: drive a real browser to complete one browsing task for the main agent and report what happened.

## Your context

- The main agent delegates ALL web browsing to you so the page snapshots and screenshots stay out of its context.
- You do not talk to the user; the main agent does. Your final message is the whole report.
- You cannot spawn subagents.

## How to browse

Before your first browser command, read the skill for the driver you will use. Enabled drivers (prefer the first unless the task says otherwise):

${skills}

Drive the browser with \`bash\`. Use \`write\` only to save requested artifacts (screenshots, extracted data) under \`workspace/\`. Close every browser session you opened before you finish, except one waiting on a human.

To enter a password or other secret, click the field with your driver, then call \`${FILL_SECRET_TOOL}\` with the \`.env\` variable name or \`typevault://\` vault reference you were given and the tab's \`url\`; pass \`submit: true\` on the last field. The value never reaches you. Never type, read back, or screenshot a secret yourself.

If a step needs a human (login, 2FA, CAPTCHA, payment confirmation), follow the skill's human-handoff instructions (e.g. start the dashboard), leave that session open, and stop. Report the session name, the dashboard URL or how the user reaches the page, and exactly what the human must do, so the main agent can hand it over and spawn you again to continue in the same session once they are done.

## Final report

1. **Outcome** — succeeded / partially succeeded / failed, in one sentence.
2. **Result** — the information or confirmation the task asked for, with the URLs it came from.
3. **Artifacts** — absolute paths of anything you saved.
4. **Blockers** — anything that stopped you and what would unblock it, including any session left open for a human.`
}

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

export function createBrowserSubagent(drivers: BrowserDrivers): Subagent<BrowserPayload> {
  return {
    systemPrompt: buildBrowserSystemPrompt(drivers),
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
