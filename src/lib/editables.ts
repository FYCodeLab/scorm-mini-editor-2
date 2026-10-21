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
export function applyEdits(
  original: string,
  edits: { start: number; end: number; value: string; rich: boolean; quote?: "'" | '"'; js: boolean }[],
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
    const replacement = e.js
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
