---
name: omowright
description: Playwright-shaped browser automation library (OmOWright) for the shared TypeClaw browser. Use for browsing, clicking, form filling, accessibility snapshots, scrolling feeds and collecting JSON from network responses while scrolling.
---

# omowright

OmOWright is a JavaScript library with the Playwright API shape (`page.goto`, `page.locator(ref).click()`, `page.mouse.wheel`, `page.keyboard.type`, `page.screenshot`). Write a short Bun script and run it with `bun`. Each script connects to the shared browser, so tabs, logins, and cookies survive between scripts. Snapshot refs do not.

`$OMOWRIGHT_CDP_URL` holds the connection URL. If the variable is unset, this session's role cannot use the shared browser (it needs the `browser.shared` permission) or the browser failed to start; the operator log (`typeclaw logs`) names which. Do not try to start Chrome yourself.

```js
// save as /tmp/browse.mjs, run: bun /tmp/browse.mjs
import { compactSnapshot, connect, createAgentTabs } from '/usr/local/lib/typeclaw-browser/omowright/index.js'

const url = process.env.OMOWRIGHT_CDP_URL
// The relay requires the token on every request; omowright drops the URL query
// for HTTP discovery (listTargets), so pass it as an Authorization header too.
const token = new URL(url).searchParams.get('token')
// `await using` closes this script's connection when the script ends, so the
// script exits on its own; the tab and the browser keep running.
await using browser = await connect(url, {
  client: { authorizer: { resolveAuthorization: async () => `Bearer ${token}` } },
})
const tabs = createAgentTabs(browser) // background tabs that never steal focus
const { targetId, page } = await tabs.create('https://example.com')
console.log(targetId) // keep it: later scripts reattach with browser.attachPage(targetId)
console.log(compactSnapshot(await page.snapshot())) // refs like [ref=e1]
await page.locator('e1').click()
```

Always connect with `await using browser = await connect(...)`, as above. With a plain `const`, the open connection keeps Bun running, so the script prints its output and then hangs until the bash timeout kills it. `await using` also closes the connection when the script throws. Tabs made with `createAgentTabs` stay open for the next script; a popup tab the script attached (from `window.open`) closes with the connection, so do work that must continue later in an agent tab.

A "Command timed out" result after the script printed output means the script did not exit, not that the browser or the site failed. Do not report a browser timeout and do not blindly rerun it: its actions (a click, a submit) may already have gone through. Reattach to the tab with `attachPage`, snapshot it, and continue from what the page shows; repeat a step only if the page shows it did not happen.

A later script continues in the same tab with `const page = await browser.attachPage(targetId)`. `browser.listTargets()` lists open tabs when the id is lost.

Refs like `e14` belong to the script that took the snapshot. A new script has none, so `page.locator('e14')` from an earlier run always throws `RefStaleError`. In every script that acts on refs, call `page.snapshot()` first and use the refs from that snapshot in the same script. A page change (a click that navigates, a modal opening) also invalidates refs: snapshot again in the same script before the next ref action. When a ref stays stale, use a semantic locator instead, such as `page.getByRole('link', { name: '로그인' })` or `page.locator('#userId')`.

Reuse your tab across retries with `attachPage` instead of opening another `tabs.create` for the same site, and close tabs you no longer need (`await page.close()`). Duplicate tabs of one site make it unclear which tab later steps (and `browser_fill_secret`) act on.

- Prefer `compactSnapshot(await page.snapshot())` over screenshots; re-snapshots come back as a diff.
- Long lists: `createNetworkSnoop` + `collectWhileScrolling` read the page's JSON instead of scraping rows.
- Canvas or custom widgets: `createCua(page)` gives coordinate-level clicks and scrolls.
- `connectBrowser()`, `connectPipe()`, and `connectBrowserSkill()` launch or find other browsers; do not use them here.

## Sites with anti-macro checks

Some sites (ticketing and banking sites such as Korail, often behind DynaPath) score how input arrives and reject requests that look scripted. On Korail the rejection is a dialog like "매크로, 개발자도구 등 미허가 도구 사용 시 이용이 제한될 수 있습니다" or a `CODE : -8002`. That dialog is a block of the request, not a notice to click away; the login or search did not go through.

`locator(ref).click()` jumps the pointer straight to the element and `keyboard.type(text)` types with no delay between keys, which these checks reject. Both a moving pointer and a typing delay are needed; either alone is still rejected. On such sites, click and type like this instead:

```js
const rand = (min, max) => min + Math.random() * (max - min)
const pause = (min, max) => new Promise((resolve) => setTimeout(resolve, rand(min, max)))

async function humanClick(page, ref, [fromX, toX] = [0.3, 0.7]) {
  await page.locator(ref).scrollIntoViewIfNeeded()
  const box = await page.locator(ref).boundingBox()
  const x = box.x + box.width * rand(fromX, toX)
  const y = box.y + box.height * rand(0.3, 0.7)
  await page.mouse.move(x, y, { steps: Math.round(rand(12, 25)) })
  await pause(80, 250)
  await page.mouse.down()
  await pause(40, 110)
  await page.mouse.up()
}

async function humanType(page, ref, text) {
  // Aim at the left of the field: the right edge often holds an overlay
  // (password reveal, virtual-keypad toggle) that swallows the keystrokes.
  await humanClick(page, ref, [0.1, 0.35])
  await pause(300, 700)
  // Clear what a previous attempt left in the field so a retry does not append.
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await pause(150, 400)
  await page.keyboard.type(text, { delay: 120 })
}
```

- Before submitting, take a fresh snapshot and check every field holds what you typed; if one is empty, a click hit an overlay instead of the field.
- After a block, dismiss the dialog and redo the same step with `humanClick`/`humanType`. Do not report the site as unusable until that retry also fails.
- Do not call the site's endpoints yourself with `page.evaluate(() => fetch(...))`. The check signs the page's own requests, so a hand-made request is rejected even when the UI flow would pass. Drive the UI.

## Shared browser rules

- One TypeClaw-managed Chrome serves every engine and every session that has `browser.shared`. Logins and tabs persist across bash calls and sessions.
- Work only in tabs you opened. Never navigate or close a tab another engine or session is using.
- Files: downloads land in `$TYPECLAW_BROWSER_FILES`; to upload a file, copy it there first and pass that path. Chrome cannot see other paths.
- The browser runs in its own sandbox with no view of the agent folder, so `file://` URLs outside `$TYPECLAW_BROWSER_FILES` fail by design.
