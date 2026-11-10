import { typevaultCliPath } from './cli-path'

// The `typevault` command in model bash. Its grant and vault reach bash under
// TypeClaw's own names, so a project's own typevault CLI (`bun typevault` in a
// checkout) never finds a TYPEVAULT_* variable steering it to the agent's
// vault. Only this command maps them back.
const env = process.env
if (env.TYPECLAW_VAULT_DIR) {
  env.TYPEVAULT_DIR = env.TYPECLAW_VAULT_DIR
  env.TYPEVAULT_GLOBAL = '1'
}
if (env.TYPECLAW_VAULT_GRANT) env.TYPEVAULT_GRANT = env.TYPECLAW_VAULT_GRANT
// typevault strips its own TYPEVAULT_* variables from a `run` child; these
// would otherwise hand the child the session's whole grant.
delete env.TYPECLAW_VAULT_DIR
delete env.TYPECLAW_VAULT_GRANT

await import(typevaultCliPath())
