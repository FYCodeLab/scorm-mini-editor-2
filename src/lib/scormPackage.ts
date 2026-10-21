import JSZip from "jszip";
import { parseManifest, validateManifest, type ScormManifest } from "./manifest";
import { extractFileEditables, extractStaticImages, scanExternalImages, type EditableBlock, type ImageRef } from "./editables";
import { isExternalUrl, isHtmlPath, isImagePath, safePath, MAX_ZIP_BYTES, MAX_TOTAL_UNCOMPRESSED } from "./security";

export interface PackageFile {
  path: string;
  /** Text content for text files; null for binary files (see blob). */
  text: string | null;
  blob: Blob | null;
  isBinary: boolean;
}

export interface ScormPackage {
  name: string;
  manifest: ScormManifest;
  files: Map<string, PackageFile>;
  fileList: string[];
  warnings: string[];
  /** Editable blocks per HTML file, computed on import and recomputed after edits. */
  blocks: EditableBlock[];
  images: ImageRef[];
  htmlFiles: string[];
  /** Files listed in the manifest but not present, etc. */
  manifestWarnings: string[];
}

const TEXT_EXT = /\.(html?|xhtml|xml|css|js|json|txt|md)$/i;

export async function importZip(data: ArrayBuffer, name: string): Promise<ScormPackage> {
  if (data.byteLength > MAX_ZIP_BYTES) throw new Error(`ZIP is larger than the ${MAX_ZIP_BYTES / 1024 / 1024} MB limit.`);
  const zip = await JSZip.loadAsync(data);
  const files = new Map<string, PackageFile>();
  let total = 0;
  const rawNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  for (const raw of rawNames) {
    const path = safePath(raw);
    if (!path) continue; // path traversal: silently drop the unsafe entry and warn below
    const entry = zip.files[raw];
    const blob = await entry.async("blob");
    total += blob.size;
    if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error("Uncompressed total exceeds the 500 MB safety limit.");
    const isBinary = !TEXT_EXT.test(path);
    let text: string | null = null;
    if (!isBinary) {
      try { text = await entry.async("string"); } catch { text = null; }
    }
    files.set(path, { path, text, blob, isBinary });
  }
  const manifestFile = files.get("imsmanifest.xml") ?? [...files.values()].find((f) => f.path.endsWith("/imsmanifest.xml"));
  if (!manifestFile || manifestFile.text === null) {
    throw new Error("This ZIP does not contain a readable imsmanifest.xml, so it is not a SCORM package this editor can open.");
  }
  const manifest = parseManifest(manifestFile.text);
  const fileList = [...files.keys()].sort();
  const manifestWarnings = validateManifest(manifest, fileList);
  const warnings: string[] = [...manifestWarnings];
  if (rawNames.some((n) => safePath(n) === null)) warnings.push("One or more ZIP entries with unsafe paths (.. or absolute paths) were skipped.");
  if (!manifest.launchHref) warnings.push("No launch file found; the first HTML file will be used for preview.");

  const htmlFiles = fileList.filter(isHtmlPath);
  const blocks: EditableBlock[] = [];
  const images: ImageRef[] = [];
  for (const hf of htmlFiles) {
    const f = files.get(hf);
    if (!f?.text) continue;
    const ex = extractFileEditables(hf, f.text);
    blocks.push(...ex.blocks);
    images.push(...ex.images);
    images.push(...extractStaticImages(hf, f.text));
    images.push(...scanExternalImages(hf, f.text));
  }
  // Deduplicate image refs by (file, src, start)
  const seen = new Set<string>();
  const dedupImages = images.filter((im) => {
    const k = `${im.file}|${im.src}|${im.start}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  return { name, manifest, files, fileList, warnings, blocks, images: dedupImages, htmlFiles, manifestWarnings };
}

/** Recompute blocks/images for a single edited file (used after edits are applied). */
export function refreshFile(pkg: ScormPackage, file: string): ScormPackage {
  const f = pkg.files.get(file);
  const blocks = pkg.blocks.filter((b) => b.file !== file);
  const images = pkg.images.filter((im) => im.file !== file);
  if (f?.text) {
    const ex = extractFileEditables(file, f.text);
    blocks.push(...ex.blocks);
    images.push(...ex.images, ...extractStaticImages(file, f.text));
  }
  return { ...pkg, blocks, images, fileList: [...pkg.files.keys()].sort(), htmlFiles: [...pkg.files.keys()].filter(isHtmlPath).sort() };
}

export async function exportZip(pkg: ScormPackage): Promise<Blob> {
  const zip = new JSZip();
  // Manifest is never rewritten: it is copied byte-for-byte from the import.
  for (const path of [...pkg.files.keys()].sort()) {
    const f = pkg.files.get(path)!;
    if (f.text !== null && !f.isBinary) zip.file(path, f.text);
    else if (f.blob) zip.file(path, f.blob);
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/**
 * Convert a Blob to a data: URL (base64). Data URLs, unlike Blob URLs,
 * load inside a sandboxed iframe (allow-scripts only, opaque origin) on
 * every browser including iOS Safari, where Blob-URL subresources from
 * the parent page can fail and leave e.g. the course logo blank.
 * Only used for files up to 5 MB; larger files fall back to Blob URLs.
 */
export async function blobToDataUrl(blob: Blob, mime?: string): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const type = mime ?? blob.type ?? "application/octet-stream";
  return `data:${type};base64,${btoa(bin)}`;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", css: "text/css",
  js: "text/javascript", html: "text/html", json: "application/json",
};

/** Resolve a relative asset path against the launch file's directory. */
export function resolveRelative(baseFile: string, ref: string): string {
  if (isExternalUrl(ref) || ref.startsWith("data:") || ref.startsWith("#")) return ref;
  const dir = baseFile.includes("/") ? baseFile.slice(0, baseFile.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const seg of (dir + ref).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Build a preview document for the launch HTML file:
 * - local asset references (src/href) are rewritten to Blob URLs created from the package,
 * - a SCORM 1.2 API stub is injected that reports score/status via postMessage
 *   (it does NOT claim LMS persistence; see README "Preview vs LMS"),
 * - a click reporter is injected so clicking a preview element can select the
 *   matching editable block in the editor (best effort; JS-generated content
 *   maps to its JS-data block by text match).
 * The result is meant for a sandboxed iframe (allow-scripts only).
 */
export async function buildPreviewHtml(pkg: ScormPackage, onBlob?: (url: string, resolved: string) => void, fileOverride?: string): Promise<string> {
  const launch = fileOverride ?? pkg.manifest.launchHref ?? pkg.htmlFiles[0];
  if (!launch) throw new Error("No HTML file to preview.");
  const file = pkg.files.get(launch) ?? pkg.files.get(decodeURIComponent(launch));
  if (!file?.text) throw new Error(`Launch file "${launch}" has no readable text content.`);
  const assetUrls = new Map<string, string>();
  const urlFor = async (ref: string): Promise<string | null> => {
    const resolved = resolveRelative(launch, ref.split("#")[0].split("?")[0]);
    const f = pkg.files.get(resolved);
    if (!f?.blob) return null;
    if (!assetUrls.has(resolved)) {
      const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
      const url = f.blob.size <= 5 * 1024 * 1024
        ? await blobToDataUrl(f.blob, MIME_BY_EXT[ext] ?? f.blob.type)
        : URL.createObjectURL(f.blob);
      assetUrls.set(resolved, url);
      onBlob?.(url, resolved);
    }
    return assetUrls.get(resolved)!;
  };
  let html = file.text;
  // Collect every local src/href and url(...) ref first (async conversion),
  // then rewrite — a replace callback cannot be async.
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (!isExternalUrl(m[1]) && !m[1].startsWith("data:") && !m[1].startsWith("#") && !m[1].startsWith("mailto:")) refs.add(m[1]);
  }
  for (const m of html.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    if (!isExternalUrl(m[2]) && !m[2].startsWith("data:")) refs.add(m[2]);
  }
  const resolvedUrls = new Map<string, string>();
  for (const ref of refs) {
    const url = await urlFor(ref);
    if (url) resolvedUrls.set(ref, url);
  }
  // Rewrite src/href attributes pointing at local files. For src, keep the
  // original path in data-original-src so Editor 2 can map a click on the
  // (data/blob) image back to the package file it replaces.
  html = html.replace(/((?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (whole, pre, ref, post) => {
    const url = resolvedUrls.get(ref);
    if (!url) return whole;
    const isSrc = /src/i.test(pre);
    return isSrc ? `${pre}${url}${post} data-original-src="${ref}"` : `${pre}${url}${post}`;
  });
  // Rewrite url(...) in inline <style> blocks.
  html = html.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, q, ref) => {
    const url = resolvedUrls.get(ref);
    return url ? `url(${q}${url}${q})` : whole;
  });
  const shim = `<script>
window.API = {
  _data: {},
  LMSInitialize: function(){ window.parent.postMessage({type:'scorm', event:'initialize'}, '*'); return 'true'; },
  LMSFinish: function(){ window.parent.postMessage({type:'scorm', event:'finish'}, '*'); return 'true'; },
  LMSGetValue: function(k){ return this._data[k] || ''; },
  LMSSetValue: function(k, v){ this._data[k] = String(v); window.parent.postMessage({type:'scorm', event:'set', key:k, value:String(v)}, '*'); return 'true'; },
  LMSCommit: function(){ window.parent.postMessage({type:'scorm', event:'commit', data:this._data}, '*'); return 'true'; },
  LMSGetLastError: function(){ return '0'; },
  LMSGetErrorString: function(){ return ''; },
  LMSGetDiagnostic: function(){ return ''; }
};
document.addEventListener('click', function(e){
  var t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  var text = (t.innerText || t.textContent || '').trim().slice(0, 200);
  if (text) window.parent.postMessage({type:'editor-select', text: text}, '*');
}, true);
<\/script>`;
  if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${shim}</head>`);
  else html = shim + html;
  return html;
}

export function listLocalImages(pkg: ScormPackage): string[] {
  return pkg.fileList.filter(isImagePath);
}

export function listExternalImages(pkg: ScormPackage): string[] {
  const set = new Set<string>();
  for (const im of pkg.images) if (!im.local) set.add(im.src);
  // Also scan all HTML for any http(s) image URL.
  for (const hf of pkg.htmlFiles) {
    const text = pkg.files.get(hf)?.text ?? "";
    for (const m of text.matchAll(/https?:\/\/[^\s"'`<>]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"'`<>]*)?/gi)) set.add(m[0]);
  }
  return [...set].sort();
}
