---
name: typevault
description: Use secrets from this agent's TypeVault vault without putting them in the transcript. Use when a task needs an API key, password, token, OAuth credential, SSH key or TOTP code that lives in the vault or in a project's `.typevault/`, when asked to join a project's vault, or when the user mentions TypeVault, the vault, or storing a secret.
---

# TypeVault

This agent keeps secrets in its own TypeVault vault. The `typevault` command in your bash already holds a live grant for your role's tier and every tier below it (`owner` > `trusted` > `member` > `guest`), so you can use what your role may use without asking for a key. Every read is audited with your session.

## Rules

- **Never print a secret.** Use `typevault run` so values go into the child's environment and its output is redacted. Values your grant has read are also scrubbed from tool output, so a printed value shows up as `[redacted]`; that is not a bug to work around.
- **Never put a secret on the command line or in a file you then read.** Pass values on stdin.
- **Always give a `--reason`.** It is written to the audit trail.
- If a secret you need is not listed, your role cannot reach it, or nobody stored it yet. Tell the user; don't look for it elsewhere.

## Look around

```sh
typevault ls                     # entries your grant reaches
typevault whoami                 # your grant, its tiers and expiry
```

Entries are named `typevault://<service>[/<account>][#<field>]`, e.g. `typevault://openai`, `typevault://github/bot#password`.

## Use secrets

```sh
typevault run --only typevault://openai --reason "summarize the report" -- sh -c 'curl -H "Authorization: Bearer $OPENAI" https://api.openai.com/v1/models'
typevault run --only typevault://github/bot --reason "log in to GitHub" -- ./login.sh
DATABASE_URL=typevault://postgres/prod#url typevault run --reason "run migrations" -- bun run migrate
```

- Env names come from the entry name: `typevault://github/bot#password` -> `GITHUB_BOT_PASSWORD`, `typevault://openai` -> `OPENAI`. To choose the name, set a variable to a `typevault://` reference as above.
- Quote `$VAR` references in single quotes so your shell does not expand them before `run` sets them.
- `run` loads every entry of your own tier; entries from lower tiers load only when `--only` names them exactly.
- TOTP fields hold the current code, never the seed.

## A project's own vault

The `typevault` command always opens this agent's vault, even inside a project. For a project that keeps its own `.typevault/`, run the project's CLI from its checkout instead, e.g. `bun typevault ...` when the project depends on `typevault`. Your bash already holds this agent's machine identity for project vaults, so nothing asks for a password.

```sh
bun typevault join     # prints the `typevault member add ...` line
```

Send the user that line for a vault owner to run, and never use `join --name` or pick a password: the identity is already set up. Once they add you and push, pull and use the project's CLI (`bun typevault ls`, `bun typevault run ...`) with the same rules as above.

## Fill a web form

Call `browser_fill_secret` with a vault reference as `name` (e.g. `typevault://github/bot#password`) after focusing the field. The value is typed into the page and never comes back to you.

## Ask the user for a secret

When a secret you need is not in the vault, call `vault_request` with the entry name, a preset (`api_key`, `password`, ...) and a reason. Send the user the returned link **and** match code, and tell them to check the code on the page before submitting. Never ask them to paste a secret into chat. The value is stored in your role's tier when they submit; check with `typevault ls`.

If `vault_request` says the page has no public URL yet, its tunnel is still starting; try again in a moment.

## Store secrets

```sh
printf '%s' "$VALUE_FROM_ENV" | typevault set typevault://service/account --preset api_key --stdin
```

A secret is stored in your role's tier, so roles below yours cannot read it. Never type a secret value into a command yourself, even piped.
