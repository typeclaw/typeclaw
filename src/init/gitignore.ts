export const GITIGNORE_FILE = '.gitignore'

export function buildGitignore(): string {
  return `# Truly ignored: secrets, runtime junk, and the agent's free-write zone.
# Never enter git history under any circumstance.
.env
.env.local
node_modules/
workspace/
mounts/
channels/state/
.DS_Store

# System-managed: gitignored by default so the agent never stages them by hand,
# but TypeClaw force-commits them on its own schedule (sessions/ via auto-backup,
# memory/ via the dreaming subagent, channels/sessions.json via the channel
# router). Treat them as runtime-owned, not agent-owned.
sessions/
memory/
channels/sessions.json
`
}
