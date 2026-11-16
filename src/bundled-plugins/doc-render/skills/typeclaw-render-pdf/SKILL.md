---
name: typeclaw-render-pdf
description: "The ONLY supported way to produce a polished, professionally designed PDF (and optionally attach it to a channel). Load this whenever you need to deliver a document as a PDF rather than raw markdown — reports, summaries, briefs, one-pagers, dashboards, meeting notes, docs, render report, export document, anything a human would want to download, print, or forward, including a researcher's report file shipped as a Slack/Discord attachment. Triggers: 'make a PDF', 'export to PDF', 'markdown to PDF', 'PDF report', 'render report', 'export document', 'the report', 'attach the report', 'send me a PDF', 'as a PDF', 'turn this into a document', 'make it look good', 'beautiful PDF', 'nicer PDF', a researcher/subagent result you want to ship as a file, 'PDF로', 'PDF로 만들어', 'PDF로 변환', 'PDF 첨부', '리포트', '보고서', '예쁘게'. Provided by the bundled `doc-render` plugin: you design the document yourself as self-contained HTML/CSS (cover, headline numbers, charts, tables — whatever fits), and a bundled script prints it to PDF with the Chrome already in the image (nothing to install). Handles CJK/Korean/Japanese/Chinese: CJK fonts are opt-in, so if the output has tofu (□□□) boxes it tells you to enable `docker.file.cjkFonts` and restart, then regenerates — it never auto-downloads a font. Also load before saying you cannot produce PDFs — you can. NEVER build a PDF with jsPDF, pdfkit, a canvas text dump, or Python ReportLab — this skill is the only correct path. Covers the one-time install, writing the HTML, the render command, and how to attach the PDF to Slack/Discord/Telegram/KakaoTalk. For operating on EXISTING PDFs (merge, split, extract text, fill forms), this is not the skill — use pypdf/qpdf instead; doc-render produces documents, it does not read them."
---

# typeclaw-render-pdf

You produce PDFs by **designing the document in HTML** and printing it. The
bundled `doc-render` plugin ships a **render script** that prints your HTML
with the Chrome already in the image. There is no template and no injected
stylesheet: you write all the CSS, so each document is designed for its own
content.

The output should look like a designer made it — a cover, headline numbers,
charts, side-by-side panels — **not** like Markdown run through a converter.
That is the whole point of this path: you are the designer.

The flow: **(1)** write the document as `.html`, **(2)** run the render
script, **(3)** attach the PDF if a channel asked for it. There is nothing to
install: the script prints with the image's Chrome through headless Chrome's
own print-to-PDF.

> Do **not** reach for `jsPDF`, `pdfkit`, a `<canvas>` text dump, or Python
> `ReportLab`. They produce unstyled text and broken CJK. If you catch yourself
> about to `bun add` any PDF or browser library, stop.

## When to use this

- A report, brief, one-pager, or dashboard the user wants as a downloadable file.
- A subagent (e.g. the `researcher`) handed you a `research-<slug>.md` to ship
  as a PDF — read it, then **design** it as HTML (don't paste it into `<pre>`).
- Any channel message asking for "a PDF" / "the report attached" / "예쁘게 PDF로".

When plain markdown in chat is fine, **don't** make a PDF. This is for when a
_file_ is the deliverable.

## Step 1 — write the HTML

Write one self-contained `.html` file (CSS in a `<style>` block) in any
agent-writable directory (`workspace/`, `public/`, or next to the source
`.md`). Put local images beside it and reference them relatively. Charts are
inline `<svg>` or plain CSS (bars as sized `<div>`s); no JS chart libraries.

### Print essentials

Browsers print badly by default. Always include these; without an `@page`
`size`, Chrome falls back to US Letter:

```css
@page {
  size: A4;
  margin: 18mm 16mm;
  @bottom-right {
    content: counter(page) ' / ' counter(pages);
    font: 8pt sans-serif;
    color: #888;
  }
}
html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
} /* keep backgrounds */
h1,
h2,
h3 {
  break-after: avoid;
}
figure,
tr,
.card {
  break-inside: avoid;
}
thead {
  display: table-header-group;
} /* repeat table headers across pages */
```

- A full-bleed cover: give it its own named page (`@page cover { margin: 0 }`,
  `.cover { page: cover; height: 297mm; break-after: page }`).
- Size with `mm`/`pt`, not `vh`; an A4 page is 210 × 297 mm.
- **Fonts:** nothing is bundled and remote fonts are not allowed. Use a stack
  that degrades well, and include the CJK fallback:
  `font-family: Inter, "Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", "Noto Sans CJK KR", "Noto Sans CJK JP", "Noto Sans CJK SC", sans-serif;`
  Get hierarchy from size, weight, spacing, and color, not from a fancy face.

### Design like a designer

- **Lead with the conclusion.** The cover and first-page headline state the
  finding ("Edge inference became the default"), not the topic ("Q2 Report").
- **Numbers up front.** Put the 3–4 headline figures in a row of cards.
- **Compare side by side** with CSS grid instead of stacking everything.
- **Tables over repeated bullets**, with status as small colored pills and
  figures right-aligned (`font-variant-numeric: tabular-nums`).
- **One accent color** chosen for the subject (navy for finance, teal for
  health, indigo for tech), plus neutrals. Callouts are rare.
- **Keep prose short.** Short paragraphs under clear sections; no walls of text.
- **Vary the design per document.** Don't reuse one layout for everything.
- **Everything local.** No CDN fonts, scripts, stylesheets, or remote images.

### Charts

A chart should make one point; let its title say it ("Churn halved after the
March price change"), not just name the data. If there's no point to make, a
table or a sentence may serve better.

Good defaults, not rules — break them when the content calls for it:

- Pick the form from the question: trends → lines; comparisons → sorted
  horizontal bars; part-of-whole → a stacked bar (pies only for 2–3 parts);
  progress → a bar against a target.
- Position and length read more precisely than angle, area, or color.
- Bars usually start at zero, because readers compare their length.
- Label lines and bars directly instead of using a legend; keep gridlines
  faint and ticks round; put units where the reader looks.
- Gray by default, the accent for what the title is about; the chart should
  still read in grayscale.
- Annotate the moment that explains the shape; note the source and date.
- Too many series? Small multiples with a shared scale often read better.
- Derive coordinates from the data (a small script that emits the `<svg>`
  works well); shapes placed by eye drift from the numbers.

## Step 2 — render

```sh
cd /agent/workspace            # wherever your .html lives
bun run /agent/node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts brief.html brief.pdf
```

On success it prints `wrote brief.pdf (<N> bytes)`. On failure it exits 1 with
Chrome's last error lines; fix the markup or path it names, and do **not**
switch to another PDF library. `no Chrome at …` means the image has no browser at the default path; set
`AGENT_BROWSER_EXECUTABLE_PATH` to a Chrome/Chromium binary.

Check the result before sending: if layout matters, screenshot a page with a
browser engine (`agent-browser` is always installed) or re-read the HTML for overflowing tables or orphaned headings
and fix them with `break-inside: avoid` / `break-before: page`.

## Handling CJK content

CJK fonts are **opt-in** (the `docker.file.cjkFonts` toggle). With `Noto Sans CJK`
in your font stack (see Print essentials), Korean/Japanese/Chinese render
automatically **when those fonts are present**. When the toggle is off, CJK
glyphs come out as tofu (□) boxes. **Do not** download, vendor, or `curl` a font
to work around this, and **do not** silently deliver a tofu PDF.

If the document contains CJK and the PDF shows tofu (or you know CJK fonts
aren't enabled), tell the user and offer the fix:

> This report has Korean/Japanese/Chinese text but the container has no CJK font
> — they're opt-in, so the PDF comes out as tofu boxes. Want me to set
> `docker.file.cjkFonts: true` in `typeclaw.json`? It's a boot setting, so after
> I edit it you'll run `typeclaw restart` from the host project directory, and
> then I'll regenerate the PDF.

Only after the user agrees: edit `typeclaw.json` (use the `typeclaw-config`
skill), ask them to `typeclaw restart`, and regenerate afterwards.

## Archiving an existing web page

To capture a **live URL** as a PDF rather than author a document, drive a
browser engine; with the always-installed `agent-browser` that is
`agent-browser open <url>`, then `agent-browser pdf out.pdf`.

## Step 3 — deliver

- **Channel asked for the PDF** — attach it:

  ```
  channel_send(text: "Here's the report.", attachments: [{ path: "/agent/workspace/brief.pdf", filename: "Edge-AI-Brief.pdf" }])
  ```

  Use a human-friendly `filename` and an absolute path. Slack, Discord, Telegram,
  and KakaoTalk upload the file; LINE and the GitHub adapter have no attachment
  support, so there post a link or paste the markdown.

- **Replying in a thread** — use `channel_reply` with the same `attachments` shape.

- **No channel** (TUI session) — just report the path.

## If you got the markdown from a subagent

The `researcher` subagent writes its report to `research-<slug>.md` and returns a
`<report>` block naming the file. Read it, design the HTML from its content
(cover, KPIs, charts from its numbers), render, and attach. You do the PDF
step — the researcher's `bash` is read-only and it only emits markdown by design.

## Customizing

For a durable house style (brand colors, logo, layout), copy this file to
`.agents/skills/<your-name>/SKILL.md` (use a **different** `name`; bundled
skills win name collisions) and describe the style there.

## Don'ts

- **Don't** convert markdown mechanically into `<p>`/`<ul>` and call it done —
  design the layout; that is what makes the document look designed.
- **Don't** link remote assets or add `<script>` that fetches anything.
- **Don't** install packages to render: no `bun add`, no `package.json` /
  `node_modules` under `workspace/`, and no changes to the protected agent-root
  dependencies.
- **Don't** attach a PDF to a GitHub channel — that adapter rejects attachments.
