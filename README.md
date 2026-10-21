# SCORM Mini Editor 2 — Page Editor

A second, page-first SCORM editor on the same GitHub account as
[SCORM Mini Editor](https://github.com/FYCodeLab/scorm-mini-editor).

**Live app:** https://fycodelab.github.io/scorm-mini-editor-2/
**Repository:** https://github.com/FYCodeLab/scorm-mini-editor-2

Same engine, different interaction: instead of a side list of editable
blocks, Editor 2 shows **one page at a time, in WYSIWYG form**, with
**← → arrows** to move between pages. Every editable part is outlined in
a **red rectangle**. Click a red rectangle, and its editor appears
**under the page**: a text editor for text, an image-replacement panel
for images. Parts without a red rectangle are not editable.

Faithful rendering (updated 2026-10-21): the WYSIWYG is **the course
itself**, rendered by its own HTML/CSS/JS inside a sandboxed iframe —
not a reconstruction. For the SupBiotech course that means the lime
frame, the logo and pills, the two-column grid (text card on the left,
image card on the right), and the bottom bar, exactly as on Moodle.
The earlier stacked reconstruction (text on top, image below, with
jagged inline red outlines) is gone: red marks are now rectangles
around whole containers (title, synthesis box, photo), and the
course's own Back/Next buttons are disabled in edit mode so the iframe
cannot silently leave the page the arrows selected. Use the
**Landscape (wide) / Portrait (narrow)** frame toggle above the page:
portrait keeps the MOOC's two-column layout, so text will be small —
as on Moodle — rather than reflowing into a single column.

Everything runs in your browser. No backend, account, database or paid API.
Your SCORM ZIP is never uploaded to GitHub or any server.

## How to use it

1. Open the live app, **Import SCORM ZIP** (or drag and drop, or try the
   built-in demo course).
2. Use the **← →** arrows (or the left/right keyboard arrows) to move
   between pages. The counter reads “Page 3 of 13”, for example.
3. Click a **red box** in the page. The editor for that text or image
   appears underneath the page.
4. Edit, click **Apply change**, use **Undo / Redo** in the top bar.
5. Click **Export SCORM ZIP**. The download is a new file
   (`<original>-edited.zip`); your original is never overwritten.
6. Reimport the exported ZIP to verify, then test it in your real LMS
   (e.g. Moodle) before classroom use.

## What a “page” is

- **JavaScript courses (like the SupBiotech reference course):** one page
  per lesson — Welcome, then Lesson 1 to Lesson 12. The iframe is
  navigated to that lesson's Read page via the course's own `jumpTo()`.
  Editable parts on that page (title, summary, photo, caption, quiz
  items where present) get red rectangles; quiz type and points have
  none because they are not editable.
- **Ordinary multi-page HTML courses:** one page per HTML file, rendered
  by that file's own HTML/CSS/JS in the same sandboxed iframe, with red
  rectangles injected on editable elements.

## What is editable, and what is not

Editable in red boxes: static HTML text, JavaScript data text (lesson
titles, worksheet references, summaries, quiz items, questions, captions),
local images and external images (replace with an upload, or try
“Make local”).

Not editable (no red box): HTML generated inside JavaScript template
strings, conditional instruction sentences, SVG illustrations drawn by
code, scoring keys, points, navigation logic, and the welcome intro text
of the reference course. This is deliberate: editing those by blind
string replacement could break the course, so Editor 2 shows them plain
instead of pretending they are safe to change.

The manifest is copied byte-for-byte on export, except for the one
documented case in Editor 1: a newly added local image that replaces an
external one is listed as a file in the manifest resource.

## Difference from Editor 1

| | Editor 1 | Editor 2 (this repo) |
|---|---|---|
| Navigation | Side list of blocks, search | ← → arrows, one page at a time |
| Editable marker | List selection | Red box on the page itself |
| Editor location | Centre panel | Under the WYSIWYG page |
| Engine | Same JSZip / parser / export code | Same |

## Development and tests

```bash
npm install
npm run dev
npm run test    # 18 tests: manifest, JS literal parser, edits, ZIP round-trip, pages, faithful-WYSIWYG injection script
npm run build
```

Faithful rendering was additionally verified locally (not committed,
because it needs the reference ZIP) by running the real course in
jsdom: Lesson 3 renders with two cards (text left, image right),
the title, the Yamanaka synthesis container and the Nobel photo all
carry red rectangles, and the synthesis rectangle is a container, not
an inline span.

## Deployment

GitHub Pages is served from the `gh-pages` branch (built site), with
Vite `base: '/scorm-mini-editor-2/'`. The intended GitHub Actions workflow
(`.github/workflows/deploy.yml`) could not be pushed with the current
GitHub token, which lacks the `workflow` scope — see Editor 1's README
for the same blocker. Until the token is re-authorised with `workflow`
scope (or the workflow is added via the web UI), redeploy by rebuilding
and pushing `dist/` to `gh-pages`.

## Limitations

- The WYSIWYG page is the course itself in a sandboxed iframe, which is
  as close to Moodle as a browser preview can get — but it is still not
  an LMS test. Always test the exported ZIP in your LMS before
  classroom use.
- Real LMS (Moodle) verification of exported packages is still outstanding.
- No screenshots yet (no browser in the build environment to capture real
  ones).

## License

MIT — see `LICENSE`.
