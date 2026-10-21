import { findConstLiteral, getField, str, type JsNode } from "./jsLiteral";
import type { EditableBlock, ImageRef } from "./editables";
import { escapeHtmlAttr } from "./security";
import type { ScormPackage } from "./scormPackage";

export interface Page {
  id: string;
  /** "Welcome", "Lesson 3 — Reprogramming to iPSCs", or an HTML file name. */
  title: string;
  subtitle: string;
  /** Rendered HTML for the WYSIWYG area. Editable pieces carry
   *  data-block-id="<block id>"; images carry data-image-src="<src>".
   *  Anything without those attributes is NOT editable and is shown plain. */
  html: string;
  /** File the page's editable content lives in (for generic pages). */
  file: string;
}

function blockFor(pkg: ScormPackage, file: string, label: string): EditableBlock | undefined {
  return pkg.blocks.find((b) => b.file === file && b.label === label);
}

function span(block: EditableBlock | undefined, inner: string, cls = ""): string {
  if (!block) return `<span class="${cls}">${inner}</span>`;
  return `<span data-block-id="${block.id}" class="ed ${cls}">${inner}</span>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface LessonData {
  index: number;
  title: string;
  pagesRef: string;
  kind: string;
  points: number;
  imageKey: string;
}

/** Parse the tasks array (reference-style JS courses) without evaluating code. */
export function parseLessons(html: string): LessonData[] {
  const lit = findConstLiteral(html, "tasks");
  if (!lit || lit.node.kind !== "array") return [];
  const out: LessonData[] = [];
  lit.node.items.forEach((task, i) => {
    if (task.kind !== "object") return;
    out.push({
      index: i,
      title: str(getField(task, "title")) ?? `Lesson ${i + 1}`,
      pagesRef: str(getField(task, "pages")) ?? "",
      kind: str(getField(task, "kind")) ?? "",
      points: getField(task, "points")?.kind === "number" ? (getField(task, "points") as { value: number }).value : 0,
      imageKey: str(getField(task, "image")) ?? "",
    });
  });
  return out;
}

function lessonBlocks(pkg: ScormPackage, file: string, i: number) {
  const L = i + 1;
  return {
    title: blockFor(pkg, file, `Lesson ${L} · Title`),
    pages: blockFor(pkg, file, `Lesson ${L} · Worksheet reference`),
    synthesis: blockFor(pkg, file, `Lesson ${L} · “Remember that…” summary`),
    items: pkg.blocks.filter((b) => b.file === file && b.label.startsWith(`Lesson ${L} · Item `)),
    targets: pkg.blocks.filter((b) => b.file === file && b.label.startsWith(`Lesson ${L} · Category `)),
    questions: pkg.blocks.filter((b) => b.file === file && (b.label.includes(`Lesson ${L} · Question `) || b.label.includes(`Lesson ${L} · Q`))),
    caption: blockFor(pkg, file, `readPhotos[${i}] · caption`),
  };
}

/** Build the WYSIWYG pages for a package. JS lessons first, else one page per HTML file. */
export function buildPages(pkg: ScormPackage): Page[] {
  const launch = pkg.manifest.launchHref ?? pkg.htmlFiles[0];
  const launchFile = launch ? pkg.files.get(launch) ?? pkg.files.get(decodeURIComponent(launch)) : undefined;
  const lessons = launchFile?.text ? parseLessons(launchFile.text) : [];
  if (lessons.length > 0 && launchFile) {
    const file = launch;
    const pages: Page[] = [];
    // Welcome page
    const welcomeImg = pkg.images.find((im) => im.file === file && im.context === "imageUrls.welcome");
    const titleBlock = pkg.blocks.find((b) => b.file === file && b.kind === "html-title");
    let welcomeHtml = `<h1>${span(titleBlock, esc(pkg.manifest.orgTitle ?? "Welcome"))}</h1>`;
    if (welcomeImg) {
      welcomeHtml += `<div data-image-src="${escapeHtmlAttr(welcomeImg.src)}" class="imgwrap"><img src="${escapeHtmlAttr(welcomeImg.src)}" alt="Welcome image"></div><p class="small">Welcome image — click the red box to replace it.</p>`;
    }
    welcomeHtml += `<p>Estimated completion time: 45 minutes maximum. <em>(In the WYSIWYG below, the Welcome title, subtitle, heading and intro paragraphs are editable via their red boxes.)</em></p>`;
    pages.push({ id: "welcome", title: "Welcome", subtitle: pkg.manifest.orgTitle ?? "", html: welcomeHtml, file });

    lessons.forEach((lesson, i) => {
      const b = lessonBlocks(pkg, file, i);
      const photo = pkg.images.find((im) => im.file === file && im.context === `readPhotos[${i}] · image`);
      let html = `<h1>${span(b.title, esc(lesson.title))}</h1>`;
      html += `<p class="subtitle">${span(b.pages, esc(lesson.pagesRef))} · ${esc(lesson.kind)} · ${lesson.points} point${lesson.points === 1 ? "" : "s"} <em>(type and points are not editable)</em></p>`;
      if (b.synthesis) {
        html += `<section class="card"><h2>In this chapter, remember that…</h2><p>${span(b.synthesis, b.synthesis.value)}</p></section>`;
      }
      if (photo) {
        html += `<div data-image-src="${escapeHtmlAttr(photo.src)}" class="imgwrap"><img src="${escapeHtmlAttr(photo.src)}" alt="Lesson illustration"></div>`;
        if (b.caption) html += `<p class="credit">${span(b.caption, esc(b.caption.value))}</p>`;
        else html += `<p class="credit">Photo source is part of the image data above.</p>`;
      }
      if (b.items.length) {
        html += `<h2>Quiz items</h2><ul>${b.items.map((it) => `<li>${span(it, esc(it.value))}</li>`).join("")}</ul>`;
      }
      if (b.targets.length) {
        html += `<h2>Categories</h2><ul>${b.targets.map((it) => `<li>${span(it, esc(it.value))}</li>`).join("")}</ul>`;
      }
      if (b.questions.length) {
        html += `<h2>Questions</h2><ul>${b.questions.map((it) => `<li>${span(it, esc(it.value))}</li>`).join("")}</ul>`;
      }
      if (!b.synthesis && !b.items.length && !b.questions.length) {
        html += `<p><em>This lesson's interactive activity is generated by JavaScript code (for example a counting or microscope simulation). Its instructions and labels are template text and have no red box; the editable parts above are its title, worksheet reference and summary.</em></p>`;
      }
      pages.push({ id: `lesson-${i}`, title: `Lesson ${i + 1} — ${lesson.title}`, subtitle: lesson.pagesRef, html, file });
    });
    return pages;
  }

  // Generic fallback: one page per HTML file, with red boxes around editable text.
  return pkg.htmlFiles.map((hf, idx) => {
    const text = pkg.files.get(hf)?.text ?? "";
    const blocks = pkg.blocks.filter((b) => b.file === hf && b.kind !== "html-title");
    const titleBlock = pkg.blocks.find((b) => b.file === hf && b.kind === "html-title");
    const html = wrapOriginalHtml(text, blocks, pkg.images.filter((im) => im.file === hf));
    return {
      id: `html-${idx}`,
      title: titleBlock?.value ?? hf,
      subtitle: hf,
      html: titleBlock ? `<h1>${span(titleBlock, esc(titleBlock.value))}</h1>` + html : html,
      file: hf,
    };
  });
}

/**
 * Wrap editable text nodes and <img> tags in the original HTML with red-box
 * markers, then keep only the body content (scripts, styles and head are
 * dropped so course CSS cannot break the editor UI). Pure string work,
 * so it runs in Node tests too.
 */
export function wrapOriginalHtml(html: string, blocks: EditableBlock[], images: ImageRef[]): string {
  type Edit = { start: number; end: number; replacement: string };
  const edits: Edit[] = [];
  for (const b of blocks) {
    edits.push({ start: b.start, end: b.end, replacement: `<span data-block-id="${b.id}" class="ed">${b.value}</span>` });
  }
  for (const im of images) {
    // Find the <img ...> tag containing this src offset.
    const tagStart = html.lastIndexOf("<img", im.start);
    if (tagStart === -1) continue;
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1 || tagEnd < im.end) continue;
    const tag = html.slice(tagStart, tagEnd + 1);
    const withData = tag.replace(/<img\b/, `<img data-image-src="${escapeHtmlAttr(im.src)}"`);
    edits.push({ start: tagStart, end: tagEnd + 1, replacement: `<span class="imgwrap">${withData}</span>` });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) {
    // Skip an edit that overlaps a later (higher-offset) edit already applied.
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  // Drop scripts/styles/head, keep body content.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(out);
  return body ? body[1] : out;
}

export type { JsNode };
