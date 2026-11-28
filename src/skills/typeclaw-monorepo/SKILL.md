---
name: typeclaw-monorepo
description: Use this skill whenever you are about to write code that another part of your agent folder might want to reuse, or you need to decide where new code goes. Triggers include "create a package", "extract this into a library", "make this reusable", "where should this script live", "add a workspace", "edit root scripts", "bun workspaces", "packages/", "monorepo", or any tool/utility/library you intend to call from more than one place. Read it before scaffolding anything under `packages/` — the layout has conventions for plugins, custom scripts, and root-level wiring that you must not improvise around.
---

# typeclaw-monorepo

Your agent folder is a **bun monorepo**. The root `package.json` declares `"workspaces": ["packages/*"]`, and each subdirectory of `packages/` is a fully independent bun package that can be installed, depended on, and run from anywhere in the agent folder. This skill exists so you put new code in the right place, follow the workspace conventions, and do not surprise the user with random script files scattered around.

## The two zones, and which to pick

You have two free-write zones at the agent root: `workspace/` and `packages/`. Both are exempt from the non-workspace-write guard so you can edit them without acknowledging anything, but their relationship to git is opposite, and picking the wrong one is the most common mistake.

| Zone         | Purpose                                                                  | Tracked in git?                                                                                           | Reusable?                                    |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `workspace/` | One-off scripts, scratch work, throwaway experiments                     | **No** — entire dir is gitignored                                                                         | No (the dir itself is invisible to git)      |
| `packages/`  | Reusable packages, custom local plugins, shared utilities, internal libs | **Yes** — every file is tracked and MUST be committed when edited (only `*/node_modules/` ignored inside) | Yes (committed and importable across agents) |

The two columns to internalize:

- **Guard allowlist** (write permission): `workspace/` and `packages/` are both free-write — no `acknowledgeGuards` needed. This is about whether the agent can write the file at all.
- **Git tracking** (persistence): `workspace/` is gitignored end-to-end (a true scratch zone, lost on clone), while `packages/` is fully tracked (committed to git, shipped with the agent folder, visible in PRs). This is about whether the file survives.

Anything you put in `packages/` MUST land in a commit — see `typeclaw-git`. The non-`node_modules/` files in `packages/` are not gitignored; treating them as throwaway will surprise the user when their PR includes a half-baked package they did not expect.

**Decision rule, top to bottom — stop at the first match:**

1. **Will another script or another part of the agent folder import this?** → `packages/<name>/`. Even if "another part" is just "tomorrow's me writing a sibling script", a reusable thing belongs here.
2. **Is this a custom local typeclaw plugin you are authoring?** → `packages/<plugin-name>/`. If you are adding an existing or published plugin, keep its npm package specifier in `typeclaw.json#plugins`; do not create or guess a `./packages/...` path.
3. **Will the user want to track this in git, see it in PRs, depend on it from a cron job?** → `packages/<name>/`.
4. **Is this throwaway** — a one-shot data transformation, a debug script, a scratch experiment that exists for one task and dies? → `workspace/`.
5. **Default if unsure** → `packages/<name>/`. Better to commit something reusable than to lose something useful in the gitignored void.

The hidden cost of getting this wrong: code in `workspace/` is invisible to git (the entire `workspace/` dir is gitignored as a "free-write zone"), so a reusable utility you put there will silently disappear on the next clone, the next session that runs `git clean`, or the next time a user tarballs the agent folder for backup.

## Anatomy of a `packages/<name>/` package

A bun workspace package is just a normal package directory:

```
packages/
  my-utility/
    package.json        # name, version, dependencies, scripts
    index.ts            # entrypoint
    index.test.ts       # tests, if appropriate
```

Minimal `packages/my-utility/package.json`:

```json
{
  "name": "my-utility",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./index.ts",
  "exports": {
    ".": "./index.ts"
  }
}
```

Notes that catch people:

- **`private: true`** keeps the package out of any accidental publish. Default to `true` unless the user explicitly asks for a publishable package.
- **`type: "module"`** matches the agent root and avoids ESM/CJS surprises. Always set it.
- **`main` and `exports` point at `index.ts` directly.** Bun executes TypeScript natively in the workspace; no build step required.
- **`name` is the import specifier.** `import { foo } from 'my-utility'` works from anywhere in the agent folder once you `bun install`. Pick a name you would not be embarrassed to type — descriptive and lowercase, no scope unless you have a reason.
- **No version churn.** Workspace packages stay at `0.0.0` unless the user explicitly versions them. Bun resolves them by name, not by version.

## Wiring a workspace package into another package

To depend on `packages/my-utility` from another package (e.g. `packages/my-plugin`), add it to that package's `dependencies` with the workspace protocol:

```json
{
  "name": "my-plugin",
  "dependencies": {
    "my-utility": "workspace:*"
  }
}
```

The agent-root install then links it (see [`bun install` and the monorepo](#bun-install-and-the-monorepo)). Bun symlinks the workspace package into `packages/my-plugin/node_modules/my-utility` and `import` resolves it normally. The `*` matches any version because workspace packages don't track versions.

To depend on a workspace package from the **agent root** (e.g. so cron `exec` jobs or root scripts can call into it), add it to the **root** `package.json#dependencies` the same way (see [Editing the root `package.json`](#editing-the-root-packagejson)):

```json
{
  "dependencies": {
    "typeclaw": "file:../typeclaw",
    "agent-browser": "^0.39.1",
    "my-utility": "workspace:*"
  }
}
```

## Custom typeclaw plugins live under `packages/`

This section is only for plugins you are **authoring locally** in the agent folder. If the user asks to add/install an existing or published plugin, use the plugin's npm package specifier in `typeclaw.json#plugins` (for example, `"typeclaw-gws-multi-account"`) and do **not** fabricate a `./packages/...` path.

If you are writing a typeclaw plugin (anything that uses `definePlugin` from `typeclaw/plugin`), the canonical home is `packages/<plugin-name>/`. The workflow:

1. **Author**: `packages/my-plugin/index.ts` exports `definePlugin({ ... })` as default.
2. **Wire**: edit `typeclaw.json` so the `plugins` array contains the local path:

   ```json
   {
     "plugins": ["./packages/my-plugin"]
   }
   ```

3. **Per-plugin config block** uses the **derived name** (basename of the path with extensions stripped — see the `typeclaw-plugins` skill for the full naming rule). For `./packages/my-plugin`, the derived name is `my-plugin`, so:

   ```json
   {
     "plugins": ["./packages/my-plugin"],
     "my-plugin": {
       "/* ... your config ... */": ""
     }
   }
   ```

4. **Restart**: `plugins[]` is `restart-required`. Run `typeclaw restart` (or call the `restart` tool); reload alone will not pick up a new plugin entry.

Read the `typeclaw-plugins` skill before authoring the plugin code — it covers `definePlugin`, hooks, tools, subagents, cron, the engine boundary, and the failure-mode error messages.

## Editing the root `package.json`

The root `package.json` is yours to change, like everything else in the monorepo. Add a dependency with `bun add <pkg>` (or edit the file and run `bun install`) at the agent root. Each direct dependency's `bin` commands are on your sandbox PATH from the next bash call.

Install scripts run only inside the container. The host's `typeclaw start` installs with `--ignore-scripts`, and bun runs a dependency's `postinstall` only when the package is trusted. When a CLI needs its postinstall (for example to download a native binary), run `bun pm trust <pkg>`: it adds the package to `trustedDependencies` and runs the pending script. Do this from bash, not by asking the operator; their host install never runs it.

If your role cannot write the agent root, bash refuses the write. Tell the user which package is needed and that an owner session can add it.

What typically goes there:

- **`scripts`**: convenience scripts the user (or you, in cron `exec` jobs) can run. Example: `"scripts": { "summarize": "bun run packages/summarizer/index.ts" }`. Then `bun summarize` from anywhere in the agent folder runs it.
- **`dependencies`** / **`devDependencies`**: libraries the root actually uses. Ask only for what the code imports today.
- **`workspaces`**: by default `["packages/*"]`. The user may extend it (e.g. `["packages/*", "tools/*"]`) if they want a second workspace root.

**Patterns to avoid at the root:**

- **Don't add a `main` or `bin` field at the root.** The root package is a workspace coordinator, not an executable. Put entrypoints inside `packages/<name>/`.
- **Don't change `name`, `private`, or `type`.** These are scaffolded by typeclaw and the rest of the system assumes them.
- **Don't add the typeclaw or agent-browser deps to packages.** They live at the root and are shared via the bun workspace mechanism. If a workspace package needs typeclaw types, depend on it via `"typeclaw": "workspace:*"` only if it needs the plugin SDK at runtime — and even then, `import { definePlugin } from 'typeclaw/plugin'` resolves through the root's `node_modules` automatically.

## When you start a new package, do this exactly

1. **Pick a name.** Lowercase, kebab-case, descriptive. `journal-store`, not `js`. Plugin packages are named after what the plugin does, not what it is — `standup-log`, not `my-plugin`.
2. **Create the directory.** `packages/<name>/`.
3. **Write `package.json`** using the minimal template above. Set `name` to the directory name (they don't have to match, but matching avoids confusion).
4. **Write `index.ts`** with the actual code.
5. **Add tests** as `<file>.test.ts` next to the implementation if the logic is non-trivial.
6. **Run the agent-root install** — only needed when you add dependencies or a new package. Run `bun install` at the agent root from bash; that links new workspace packages, so there is no separate registration step.
7. **Commit.** Per `typeclaw-git`, commit the new package immediately with the decision context — why this is reusable, what it solves.

## `bun install` and the monorepo

Run `bun install` (or `bun add`) at the **agent root**, never from inside a `packages/<name>/` directory. You run it yourself from bash; it runs inside the container sandbox, so packages get Linux binaries and their trusted install scripts run there. `typeclaw start` also installs on the host, but only when its startup check finds a root dependency missing, and always with `--ignore-scripts`. The root install:

- Resolves all workspace packages and creates symlinks
- Hoists shared dependencies to the root `node_modules/`
- Honors per-package dependencies that are not in the root

Per-package `node_modules/` is gitignored (`packages/*/node_modules/` in `.gitignore`), but those directories rarely have anything in them after a hoist — bun puts most things at the root.

If you see `Cannot find module 'my-utility'` after creating a new workspace package, the fix is the agent-root install: run `bun install` at the agent root. There is no separate "register the workspace" step.

None of this applies to a project checkout under `workspace/` (or `mounts/`, `/tmp`). That is a separate repo, not part of this monorepo: run `bun install`, `bun add`, and its build steps there yourself as the work needs.

## Things you must not do

- **Do not put reusable code in `workspace/`.** It will be lost. Re-read the decision rule above if you're tempted.
- **Do not put one-off throwaway scripts in `packages/`.** Each `packages/<name>` is a real package the user will see in git, in PRs, and in dependency graphs. Keep it small. If it's a 10-line script that runs once, `workspace/scratch-<date>.ts` is correct.
- **Do not edit the root `workspaces` field to point outside `packages/*`** unless the user explicitly asks. The default convention is part of the agent's identity layout; extending it surprises every other tool that walks the workspace.
- **Do not version workspace packages with semver** unless the user is publishing them. Internal packages stay at `0.0.0` and depend on each other via `workspace:*`.
- **Do not nest workspaces.** A package inside `packages/` cannot itself declare `workspaces`. Bun rejects nested workspaces, and even if it didn't, the cognitive load is not worth it.
- **Do not add `node_modules/` to `packages/<name>/.gitignore`.** The root `.gitignore` already covers `packages/*/node_modules/`. Adding a sub-`.gitignore` is noise that will get out of sync.

## Cross-references

- **`typeclaw-plugins`** — read this before authoring any custom plugin. Covers the plugin SDK, hooks, tools, subagents, cron, plugin commands (`typeclaw <name>`), naming derivation, and failure modes.
- **`typeclaw-git`** — commit policy. Every new package and every meaningful edit to `package.json` (root or workspace) gets a commit immediately with decision context.
- **`typeclaw-cron`** — if your package is invoked from a cron job, the `prompt` / `exec` / `handler` choice and the schedule semantics live there. The best practice for scheduled `exec → LLM` work is a plugin cron job with `kind: 'handler'`; the cron-exec → plugin-CLI-command shell-out is the fallback when the same logic must also be invocable as a reusable CLI command.
