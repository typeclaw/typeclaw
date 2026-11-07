// SECURITY/CORRECTNESS: rules are gated on BOTH the emitting tool name and a
// verbatim upstream pi-coding-agent error substring. `bash` (the only tool that
// raises sandbox/subagent-policy errors) appears only in the timeout rule, whose
// pattern is pi's own timeout status after printed output and so can never match
// a sandbox or policy refusal. Abort/cleanup/guard failures never match any
// pattern, so internal control
// errors are never decorated with a nonsensical "read the file first" hint. A
// wording drift upstream simply stops decorating (fails safe) rather than
// mis-firing on the wrong error class.

const HINT_PREFIX = 'Hint:'

type RemediationRule = {
  // Built-in tool names whose thrown errors this rule may decorate.
  tools: readonly string[]
  // `upstream` is the exact substring the matching pi tool emits, kept next to
  // the pattern so the regex can be re-verified against the dependency on bumps.
  upstream: string
  test: RegExp
  hint: string
}

// First matching rule wins; keep the most specific patterns first. Upstream
// sources: node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{edit,read,ls,grep,bash}.js
const RULES: readonly RemediationRule[] = [
  {
    // bash.js joins the captured output and the status with a blank line, and
    // emits the bare status when nothing was printed. Only the printed-output
    // form is decorated: there the command may have finished its work and then
    // never exited (an open browser/CDP connection, a server, a watcher), which
    // models otherwise misreport as the work itself timing out. Output alone
    // does not prove completion (it may be progress), so the hint stays
    // conditional.
    tools: ['bash'],
    upstream: '<output>\n\nCommand timed out after N seconds',
    test: /\S\s*\n\nCommand timed out after \d+ seconds/,
    hint: `${HINT_PREFIX} the command printed output and then did not exit before the timeout killed it. It may have finished its work and been kept alive by an open connection, server, or watcher, or it may still have been working; the output alone does not show which. Check the output and the resulting state (for a browser, reattach to the tab and snapshot it) before reporting success or failure, and do not blindly repeat steps with side effects (a click, a submit, a write) that may already have gone through. Make scripts exit when done, for example with \`process.exit(0)\`.`,
  },
  {
    tools: ['edit'],
    upstream: 'Could not find edits[0] in <path>. / Could not find the exact text in <path>.',
    test: /Could not find (the exact text|edits\[\d+\]) in /i,
    hint: `${HINT_PREFIX} the oldText must match the file byte-for-byte. Re-read the file with the \`read\` tool to copy the exact current text — including all whitespace, indentation, and newlines — then retry \`edit\` with that exact oldText. Do not hand-type or reformat it.`,
  },
  {
    tools: ['edit'],
    upstream: 'No changes made to <path>. The replacement(s) produced identical content',
    test: /No changes made to .+\. The replacements? produced identical content/i,
    hint: `${HINT_PREFIX} the newText is identical to the oldText, so the edit is a no-op. If you intended a change, make oldText and newText differ; if the file is already correct, do not retry this edit.`,
  },
  {
    tools: ['read'],
    upstream: 'Offset N is beyond end of file (M lines total)',
    test: /Offset \d+ is beyond end of file/i,
    hint: `${HINT_PREFIX} the file has fewer lines than the offset you requested. Read from a smaller offset, or read the whole file without an offset first to see its length.`,
  },
  {
    // typeclaw-owned: enforceAndPinToolFiles (src/agent/tool-file-safety.ts,
    // throws at :95 and :451) runs BEFORE tool.execute inside the builtin
    // wrapper, so a missing input path surfaces THIS string — not the upstream
    // `File not found:` — for every input-pinning tool. This is the common
    // missing-path case for read/grep/find/ls.
    tools: ['read', 'ls', 'grep', 'find'],
    upstream: 'tool input did not exist while being authorized: <path>',
    test: /tool input did not exist while being authorized: /i,
    hint: `${HINT_PREFIX} the path does not exist. Verify it before retrying — use \`ls\` on the parent directory or \`find\` to locate the file. Paths are relative to the agent root unless absolute.`,
  },
  {
    // Fallback for the raw upstream not-found strings some tools still emit when
    // a path resolves at pin time but disappears before the tool reads it.
    tools: ['read', 'ls', 'grep', 'find'],
    upstream: 'File not found: <path> / Path not found: <path>',
    test: /(File|Path) not found: /i,
    hint: `${HINT_PREFIX} verify the path before retrying — use \`ls\` on the parent directory or \`find\` to locate the file. Paths are relative to the agent root unless absolute.`,
  },
]

export function remediateToolErrorMessage(toolName: string, message: string): string {
  if (typeof message !== 'string' || message.length === 0) return message
  for (const rule of RULES) {
    if (!rule.tools.includes(toolName)) continue
    if (!rule.test.test(message)) continue
    if (message.includes(rule.hint)) return message
    return `${message}\n\n${rule.hint}`
  }
  return message
}
