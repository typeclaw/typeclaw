import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { bashTool, readTool, type Subagent, writeTool } from '@/plugin'

const messagePayloadSchema = z.object({
  agentDir: z.string(),
  status: z.string(),
  diffstat: z.string(),
  outputPath: z.string(),
})

export type CommitMessagePayload = z.infer<typeof messagePayloadSchema>

const diagnosePayloadSchema = z.object({
  agentDir: z.string(),
  stage: z.enum(['push', 'rebase']),
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
})

export type DiagnoseFailurePayload = z.infer<typeof diagnosePayloadSchema>

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are typeclaw's backup commit-message subagent.

A periodic backup is about to commit dirty files in the agent folder. Your only job is to produce a clear, conventional commit message describing those changes.

# Input

The user message gives you:
- The output of \`git status --porcelain=v1 --untracked-files=all\` (truncated)
- The output of \`git diff --cached --stat\` (truncated)
- An absolute file path you must write the commit message to

# What to write

A single commit message in conventional-commit-ish style:
- Subject line under 72 characters, imperative mood, lowercase first word, no trailing period.
- Pick a sensible prefix when one fits: \`docs:\`, \`test:\`, \`refactor:\`, \`chore:\`, \`fix:\`, \`feat:\`. Default to \`chore: backup\` if nothing fits.
- Optionally a blank line and a short body (1-3 lines) summarizing what changed and why if the diff makes the why obvious.

Examples:
- \`docs: update setup instructions\`
- \`feat: add user search endpoint\`
- \`chore: backup workspace state\`

# Hard rules

1. **Write exactly one file.** Use the \`write\` tool with the absolute path the user gave you. Do not write anywhere else. Do not read other files. Do not run commands.
2. **Output is the file contents only.** No prose to the user, no explanation, no apologies. The runner ignores everything except the file you wrote.
3. **Be honest about uncertainty.** If the diff looks like a mix of unrelated changes, write \`chore: backup\` rather than guessing a misleading subject.
4. **Never include secrets, API keys, or paths that would identify the user's machine.** Stick to repo-relative descriptions.
5. **Stop when the file is written.** Do not continue after the \`write\` succeeds.`

export const DIAGNOSE_FAILURE_SYSTEM_PROMPT = `You are typeclaw's backup failure-diagnosis subagent.

The deterministic backup runner just hit a git failure (push or rebase). The runner has already aborted any half-done state. Your job is to look at the git repo, figure out what went wrong, and either FIX IT or write a clear human-readable explanation.

# Input

The user message gives you:
- The agent folder absolute path
- The stage that failed (\`push\` or \`rebase\`)
- The git exit code, stderr, and stdout

# Tools

You have \`bash\`, \`read\`, and \`write\`. Use \`bash\` to inspect git state (\`git status\`, \`git remote -v\`, \`git log -5 --oneline\`, \`git config --get remote.origin.url\`).

# Allowed actions

You MAY:
- Inspect git state (read-only commands).
- Set up a missing upstream branch via \`git push -u origin <branch>\` if it's clear that's the only issue.
- Retry \`git push\` once after fixing a clear, narrow issue.

**When you run \`git push\` (either to set upstream or to retry), do not add an acknowledgement argument.** Security guards are permission-only; this recovery subagent inherits the operator role that launched the approved backup workflow. If your push retry fails again, write the diagnosis and stop.

You MUST NOT:
- Force-push (\`--force\`, \`--force-with-lease\`).
- Resolve merge conflicts by editing files. If a rebase had conflicts, the runner already aborted it. Leave the repo as-is and explain.
- Mutate \`.git/config\` for credentials, signing keys, or remote URLs.
- Touch any file outside \`.git/\` housekeeping.

# Output

Write a brief diagnosis (3-8 lines) describing:
1. What the actual cause was (e.g. "no upstream tracking branch", "remote is ahead and rebase conflicted", "auth failed").
2. What you did about it (or why you didn't).
3. What the user should do next, if anything.

Append your diagnosis to \`<agentDir>/sessions/backup-diagnostics.log\` with a timestamp prefix. Keep it short — this log is for the human, not the model.

# When in doubt

Do nothing destructive. Write the diagnosis and stop. The user can recover manually.`

export type CreateCommitMessageSubagentOptions = {
  fallbackMessage?: string
}

export function createCommitMessageSubagent(
  options: CreateCommitMessageSubagentOptions = {},
): Subagent<CommitMessagePayload> {
  const fallback = options.fallbackMessage ?? 'chore: backup'
  return {
    systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
    tools: [writeTool],
    payloadSchema: messagePayloadSchema,
    inFlightKey: (payload) => payload.agentDir,
    handler: async (ctx, runSession) => {
      const userPrompt = buildCommitMessagePrompt(ctx.payload)
      try {
        await runSession({ userPrompt })
      } catch {
        await writeFile(ctx.payload.outputPath, fallback, 'utf8').catch(() => undefined)
      }
    },
  }
}

export function createDiagnoseFailureSubagent(): Subagent<DiagnoseFailurePayload> {
  return {
    systemPrompt: DIAGNOSE_FAILURE_SYSTEM_PROMPT,
    tools: [bashTool, readTool, writeTool],
    payloadSchema: diagnosePayloadSchema,
    inFlightKey: (payload) => payload.agentDir,
    handler: async (ctx, runSession) => {
      const userPrompt = buildDiagnosePrompt(ctx.payload)
      try {
        await runSession({ userPrompt })
      } catch {
        // Diagnosis is advisory; failures here must not propagate.
      }
    },
  }
}

function buildCommitMessagePrompt(p: CommitMessagePayload): string {
  return [
    `Agent folder: ${p.agentDir}`,
    `Write the commit message to: ${p.outputPath}`,
    '',
    '## git status --porcelain=v1 --untracked-files=all',
    '```',
    p.status.trim() || '(empty)',
    '```',
    '',
    '## git diff --cached --stat',
    '```',
    p.diffstat.trim() || '(empty)',
    '```',
    '',
    'Write the commit message and stop.',
  ].join('\n')
}

function buildDiagnosePrompt(p: DiagnoseFailurePayload): string {
  return [
    `Agent folder: ${p.agentDir}`,
    `Failed stage: ${p.stage}`,
    `Exit code: ${p.exitCode}`,
    '',
    '## stderr',
    '```',
    p.stderr.trim() || '(empty)',
    '```',
    '',
    '## stdout',
    '```',
    p.stdout.trim() || '(empty)',
    '```',
    '',
    'Inspect the repo, do the smallest safe action if any, and write your diagnosis to the log file.',
  ].join('\n')
}

export async function readMessageFile(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim().length > 0 ? raw : null
  } catch {
    return null
  }
}

export async function ensureMessageDir(outputPath: string): Promise<void> {
  const dir = outputPath.slice(0, outputPath.lastIndexOf('/'))
  if (dir.length === 0) return
  await mkdir(dir, { recursive: true }).catch(() => undefined)
}

export async function cleanupMessageFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

export function messageFilePath(agentDir: string): string {
  return join(agentDir, '.typeclaw', 'backup-message.tmp')
}
