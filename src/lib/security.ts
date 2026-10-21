/** Security helpers: path traversal, size limits, SVG safety. */

export const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024;

/** Return a safe relative path, or null if it escapes the package root. */
export function safePath(raw: string): string | null {
  if (!raw) return null;
  let p = raw.replace(/\\/g, "/").trim();
  if (p.startsWith("/")) p = p.slice(1);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p);
}

export function isHtmlPath(p: string): boolean {
  return /\.(html?|xhtml)$/i.test(p);
}

export function isExternalUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Reject SVGs containing script / event handlers / foreignObject / javascript: URIs. */
export function svgLooksSafe(svg: string): boolean {
  const lower = svg.toLowerCase();
  const bad = ["<script", "onload=", "onclick=", "onerror=", "<foreignobject", "javascript:", "href=\"data:text/html"];
  return !bad.some((b) => lower.includes(b));
}

export function escapeJsString(value: string, quote: "'" | '"'): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/<\/script/gi, "<\\/script");
}

export function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
