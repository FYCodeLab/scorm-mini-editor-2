import { findConstLiteral, getField, str, type JsNode } from "./jsLiteral";
import { escapeJsString, isExternalUrl } from "./security";

export type EditableKind = "html-title" | "html-text" | "js-text" | "js-image" | "unsupported";

export interface EditableBlock {
  id: string;
  file: string;
  kind: EditableKind;
  /** Human label, e.g. "Lesson 1 — Cell types · Title" */
  label: string;
  group: string;
  value: string;
  /** Offsets of the replaceable content inside the original file text. */
  start: number;
  end: number;
  quote?: "'" | '"';
  /** True when the block is rich HTML (static HTML text); false = plain text. */
  rich: boolean;
  /** Original value, for change detection / undo snapshots. */
  original: string;
  /** True when the value lives inside a JS string literal (needs JS escaping). */
  js: boolean;
  /** True when the value lives inside a JS template literal (`…`): escape backtick and ${, not quotes. */
  template?: boolean;
}

export interface ImageRef {
  id: string;
  file: string;
  /** Local zip path, or external URL. */
  src: string;
  local: boolean;
  /** Where it was found, e.g. "index.html · <img>" or "index.html · readPhotos[3]". */
  context: string;
  start: number;
  end: number;
  quote?: "'" | '"';
  alt?: string;
}

let counter = 0;
const nid = () => `b${++counter}`;

/** Decode JS escape sequences in a raw string capture, one pass, so a
 * re-imported edited value does not double-escape on the next edit. */
function unescapeJs(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\" || i + 1 >= raw.length) { out += c; continue; }
    const n = raw[i + 1];
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "u" && raw.slice(i + 2, i + 6).match(/^[0-9a-fA-F]{4}$/)) { out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)); i += 4; }
    else out += n; // \\, \', \", \`, \$, \/
    i++;
  }
  return out;
}

/** Extract static HTML text nodes (outside <script>/<style>) and the page <title>. */
export function extractHtmlBlocks(file: string, html: string): EditableBlock[] {
  const blocks: EditableBlock[] = [];
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (titleMatch && titleMatch[1].trim()) {
    const start = titleMatch.index + titleMatch[0].indexOf(titleMatch[1]);
    blocks.push({ id: nid(), file, kind: "html-title", label: "Page title", group: file, value: titleMatch[1], start, end: start + titleMatch[1].length, rich: false, original: titleMatch[1], js: false });
  }
  // Walk tags, tracking script/style depth.
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<!--[\s\S]*?-->/g;
  let lastEnd = 0;
  let depth = 0; // script/style depth
  let m: RegExpExecArray | null;
  const handleText = (text: string, start: number) => {
    if (depth > 0) return;
    if (text.trim().length < 2) return;
    if (/^\s*$/.test(text)) return;
    // Skip pure punctuation / page-code artefacts
    blocks.push({ id: nid(), file, kind: "html-text", label: text.trim().slice(0, 80), group: file, value: text, start, end: start + text.length, rich: true, original: text, js: false });
  };
  while ((m = tagRe.exec(html)) !== null) {
    handleText(html.slice(lastEnd, m.index), lastEnd);
    const tag = m[0];
    const name = (m[1] ?? "").toLowerCase();
    if (tag.startsWith("<!--")) { lastEnd = tagRe.lastIndex; continue; }
    if (name === "script" || name === "style") {
      if (!tag.startsWith("</")) depth++;
      else depth = Math.max(0, depth - 1);
    }
    lastEnd = tagRe.lastIndex;
  }
  handleText(html.slice(lastEnd), lastEnd);
  return blocks;
}

/** Structure-aware extraction from the reference-style JS data: tasks, syntheses, imageUrls, readPhotos. */
export function extractJsBlocks(file: string, html: string): { blocks: EditableBlock[]; images: ImageRef[] } {
  const blocks: EditableBlock[] = [];
  const images: ImageRef[] = [];
  const pushStr = (node: JsNode | undefined, label: string, group: string, rich = false) => {
    if (node && node.kind === "string" && node.value.trim().length > 0) {
      blocks.push({ id: nid(), file, kind: "js-text", label, group, value: node.value, start: node.start, end: node.end, quote: node.quote, rich, original: node.value, js: true });
    }
  };
  const pushImg = (node: JsNode | undefined, context: string) => {
    if (node && node.kind === "string" && node.value.trim()) {
      const local = !isExternalUrl(node.value);
      images.push({ id: nid(), file, src: node.value, local, context, start: node.start, end: node.end, quote: node.quote });
    }
  };

  const tasksLit = findConstLiteral(html, "tasks");
  if (tasksLit?.node.kind === "array") {
    tasksLit.node.items.forEach((task, i) => {
      const group = `Lesson ${i + 1}`;
      const title = str(getField(task, "title"));
      pushStr(getField(task, "title"), `Lesson ${i + 1} · Title`, group);
      pushStr(getField(task, "pages"), `Lesson ${i + 1} · Worksheet reference`, group);
      const items = getField(task, "items");
      if (items?.kind === "array") items.items.forEach((it, j) => pushStr(it, `Lesson ${i + 1} · Item ${j + 1}`, group));
      const targets = getField(task, "targets");
      if (targets?.kind === "array") targets.items.forEach((it, j) => pushStr(it, `Lesson ${i + 1} · Category ${j + 1}`, group));
      const questions = getField(task, "questions");
      if (questions?.kind === "array") {
        questions.items.forEach((q, qi) => {
          if (q.kind !== "array") return;
          pushStr(q.items[0], `Lesson ${i + 1} · Question ${qi + 1}`, group);
          const opts = q.items[1];
          if (opts?.kind === "array") opts.items.forEach((o, oj) => pushStr(o, `Lesson ${i + 1} · Q${qi + 1} option ${oj + 1}`, group));
        });
      }
      void title;
    });
  }

  const synth = findConstLiteral(html, "syntheses");
  if (synth?.node.kind === "array") {
    synth.node.items.forEach((s, i) => pushStr(s, `Lesson ${i + 1} · “Remember that…” summary`, `Lesson ${i + 1}`, true));
  }

  const urls = findConstLiteral(html, "imageUrls");
  if (urls?.node.kind === "object") {
    for (const e of urls.node.entries) pushImg(e.value, `imageUrls.${e.key}`);
  }

  const photos = findConstLiteral(html, "readPhotos");
  if (photos?.node.kind === "object") {
    for (const e of photos.node.entries) {
      if (e.value.kind === "array") {
        pushImg(e.value.items[0], `readPhotos[${e.key}] · image`);
        pushStr(e.value.items[1], `readPhotos[${e.key}] · caption`, `Lesson ${Number(e.key) + 1}`);
      }
    }
  }

  // Welcome page: its title, subtitle, eyebrow and body are NOT in the
  // data literals above — they are hard-coded in render()'s welcome
  // branch (a header() call plus one template literal). They are safe
  // to edit because that branch runs only for the Welcome page, unlike
  // template text shared by all 12 lessons. Extract them by structure
  // (first header() call in the welcome branch, first <h2>, the two
  // readtext paragraphs, the notice, the Good luck line, the credit),
  // never by exact string match, so an edit does not break re-extraction.
  const wStart = html.indexOf("if(step<0)");
  if (wStart !== -1) {
    const wEnd = html.indexOf("if(step===12)", wStart);
    const seg = wEnd === -1 ? html.slice(wStart) : html.slice(wStart, wEnd);
    const at = (rel: number) => wStart + rel;
    const pushWelcome = (rawValue: string, start: number, end: number, label: string, rich: boolean, template: boolean, quote?: "'" | '"') => {
      // Decode escapes so the editor shows the text learners see, not the
      // source escapes; applyEdits re-escapes on save, so no double-escaping.
      const value = unescapeJs(rawValue);
      if (value.trim().length > 0) {
        blocks.push({ id: nid(), file, kind: "js-text", label: `Welcome · ${label}`, group: "Welcome", value, start, end, quote, rich, original: value, js: true, template });
      }
    };
    // header('Title','Subtitle','Eyebrow') — single-quoted, escapes allowed.
    const headerRe = /header\(\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'\s*\)/;
    const hm = headerRe.exec(seg);
    if (hm) {
      // Offsets of each captured group inside the segment.
      let cursor = hm.index + "header(".length;
      const groups = [hm[1], hm[2], hm[3]];
      const labels = ["Title", "Subtitle", "Eyebrow"];
      for (let gi = 0; gi < 3; gi++) {
        const open = seg.indexOf("'", cursor);
        const close = seg.indexOf("'", open + 1);
        // Skip escaped quotes: find the unescaped closing quote.
        let c = open + 1;
        while (c < seg.length && (seg[c] !== "'" || seg[c - 1] === "\\")) c++;
        void close;
        pushWelcome(groups[gi], at(open + 1), at(c), labels[gi], false, false, "'");
        cursor = c + 1;
      }
    }
    const tagBlock = (re: RegExp, label: string, rich: boolean, occurrence = 0) => {
      let n = -1; let m: RegExpExecArray | null;
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((m = rx.exec(seg)) !== null) {
        n++;
        if (n === occurrence) {
          const inner = m[1];
          const innerStart = m.index + m[0].indexOf(inner);
          pushWelcome(inner, at(innerStart), at(innerStart + inner.length), label, rich, true);
          return;
        }
      }
    };
    tagBlock(/<h2>([\s\S]*?)<\/h2>/, "Heading", false);
    tagBlock(/<p class="readtext">([\s\S]*?)<\/p>/, "Intro paragraph 1", true, 0);
    tagBlock(/<p class="readtext">([\s\S]*?)<\/p>/, "Intro paragraph 2", true, 1);
    tagBlock(/<div class="notice">([\s\S]*?)<\/div>/, "Modules notice", true);
    // Good luck line: <p><b>Good luck!</b></p> — capture the inner HTML.
    const gl = /<p>(<b>Good luck!<\/b>)<\/p>/.exec(seg);
    if (gl) {
      const s = gl.index + gl[0].indexOf(gl[1]);
      pushWelcome(gl[1], at(s), at(s + gl[1].length), "Good luck", true, true);
    }
    tagBlock(/<div class="credit">([\s\S]*?)<\/div>/, "Photo credit", false);
    // bottom('bar text','Start','next()')
    const bm = /bottom\(\s*'((?:\\.|[^'\\])*)'/.exec(seg);
    if (bm) {
      const open = seg.indexOf("'", bm.index + "bottom(".length);
      let c = open + 1;
      while (c < seg.length && (seg[c] !== "'" || seg[c - 1] === "\\")) c++;
      pushWelcome(bm[1], at(open + 1), at(c), "Bottom bar", false, false, "'");
    }
  }

  return { blocks, images };
}

/** All editable blocks + image refs for one HTML file. */
export function extractFileEditables(file: string, html: string) {
  const htmlBlocks = extractHtmlBlocks(file, html);
  const js = extractJsBlocks(file, html);
  return { blocks: [...htmlBlocks, ...js.blocks], images: js.images };
}

/** Extract <img src> refs (static HTML only) for the image library. */
export function extractStaticImages(file: string, html: string): ImageRef[] {
  const out: ImageRef[] = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const alt = /alt\s*=\s*(["'])([^"']*)\1/i.exec(m[0])?.[2];
    const srcStart = m.index + m[0].indexOf(m[2]);
    out.push({ id: nid(), file, src: m[2], local: !isExternalUrl(m[2]), context: "Static <img>", start: srcStart, end: srcStart + m[2].length, quote: m[1] as "'" | '"', alt });
  }
  return out;
}

/**
 * Apply a set of block edits to file text, from the end backwards so
 * offsets stay valid. JS-string blocks are JS-escaped; HTML blocks are
 * inserted as-is (the editor sanitizes rich HTML first, and escapes plain
 * titles). Throws on overlapping edits.
 */
/** Escape a value for insertion into a JS template literal (`…`). */
export function escapeTemplateLiteral(value: string, rich: boolean): string {
  let v = rich ? value : value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return v
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")
    .replace(/<\/script/gi, "<\\/script");
}

export function applyEdits(
  original: string,
  edits: { start: number; end: number; value: string; rich: boolean; quote?: "'" | '"'; js: boolean; template?: boolean }[],
): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[i].start < sorted[j].end && sorted[j].start < sorted[i].end) {
        throw new Error("Overlapping edits detected; the file was not modified.");
      }
    }
  }
  let out = original;
  for (const e of sorted) {
    const replacement = e.template
      ? escapeTemplateLiteral(e.value, e.rich)
      : e.js
        ? escapeJsString(e.value, e.quote ?? "'")
        : e.rich
          ? e.value
          : e.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    out = out.slice(0, e.start) + replacement + out.slice(e.end);
  }
  return out;
}

/** Scan any file text for external image URLs (including JS template literals). */
export function scanExternalImages(file: string, text: string): ImageRef[] {
  const out: ImageRef[] = [];
  const re = /https?:\/\/[^\s"'`<>]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"'`<>]*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ id: nid(), file, src: m[0], local: false, context: "External URL in file", start: m.index, end: m.index + m[0].length });
  }
  return out;
}
