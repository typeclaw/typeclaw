---
name: omowright
description: Playwright-shaped browser automation library (OmOWright) for the shared TypeClaw browser. Use for browsing, clicking, form filling, accessibility snapshots, scrolling feeds and collecting JSON from network responses while scrolling.
---

# omowright

OmOWright is a JavaScript library with the Playwright API shape (`page.goto`, `page.locator(ref).click()`, `page.mouse.wheel`, `page.keyboard.type`, `page.screenshot`). Write a short Bun script and run it with `bun`. Each script connects to the shared browser, so state survives between scripts.

`$OMOWRIGHT_CDP_URL` holds the connection URL. If the variable is unset, this session's role cannot use the shared browser (it needs the `browser.shared` permission) or the browser failed to start; the operator log (`typeclaw logs`) names which. Do not try to start Chrome yourself.

```js
// save as /tmp/browse.mjs, run: bun /tmp/browse.mjs
import { compactSnapshot, connect, createAgentTabs } from '/usr/local/lib/typeclaw-browser/omowright/index.js'

const url = process.env.OMOWRIGHT_CDP_URL
// The relay requires the token on every request; omowright drops the URL query
// for HTTP discovery (listTargets), so pass it as an Authorization header too.
const token = new URL(url).searchParams.get('token')
const browser = await connect(url, {
  client: { authorizer: { resolveAuthorization: async () => `Bearer ${token}` } },
})
const tabs = createAgentTabs(browser) // background tabs that never steal focus
const { targetId, page } = await tabs.create('https://example.com')
console.log(targetId) // keep it: later scripts reattach with browser.attachPage(targetId)
console.log(compactSnapshot(await page.snapshot())) // refs like [ref=e1]
await page.locator('e1').click()
process.exit(0) // leaves the tab and browser running
```

A later script continues in the same tab with `const page = await browser.attachPage(targetId)`; take a fresh `page.snapshot()` before using refs. `browser.listTargets()` lists open tabs when the id is lost.

- Prefer `compactSnapshot(await page.snapshot())` over screenshots; re-snapshots come back as a diff.
- Long lists: `createNetworkSnoop` + `collectWhileScrolling` read the page's JSON instead of scraping rows.
- Canvas or custom widgets: `createCua(page)` gives coordinate-level clicks and scrolls.
- `connectPipe()` and `connectBrowserSkill()` launch or find other browsers; do not use them here.

## Shared browser rules

- One TypeClaw-managed Chrome serves every engine and every session that has `browser.shared`. Logins and tabs persist across bash calls and sessions.
- Work only in tabs you opened. Never navigate or close a tab another engine or session is using.
- Files: downloads land in `$TYPECLAW_BROWSER_FILES`; to upload a file, copy it there first and pass that path. Chrome cannot see other paths.
- The browser runs in its own sandbox with no view of the agent folder, so `file://` URLs outside `$TYPECLAW_BROWSER_FILES` fail by design.
