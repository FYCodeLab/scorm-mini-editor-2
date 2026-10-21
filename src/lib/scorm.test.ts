import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseManifest, validateManifest } from "./manifest";
import { findConstLiteral, getField, str } from "./jsLiteral";
import { applyEdits, extractFileEditables } from "./editables";
import { importZip, exportZip, buildPreviewHtml } from "./scormPackage";
import { buildSampleZip, SAMPLE_MANIFEST } from "./sample";
import { safePath, svgLooksSafe } from "./security";

describe("manifest detection", () => {
  it("detects SCORM 1.2 and the launch file", () => {
    const m = parseManifest(SAMPLE_MANIFEST);
    expect(m.scormVersion).toBe("1.2");
    expect(m.launchHref).toBe("index.html");
    expect(m.orgTitle).toContain("Photosynthesis");
    expect(validateManifest(m, ["imsmanifest.xml", "index.html", "leaf.png"])).toEqual([]);
  });
  it("detects SCORM 2004 from schemaversion", () => {
    const m = parseManifest(SAMPLE_MANIFEST.replace("1.2", "2004 4th Edition"));
    expect(m.scormVersion).toBe("2004");
  });
  it("reports a missing launch file", () => {
    const m = parseManifest(SAMPLE_MANIFEST);
    expect(validateManifest(m, ["imsmanifest.xml"]).length).toBeGreaterThan(0);
  });
});

describe("JS literal parser", () => {
  it("parses objects with numeric keys (e.g. readPhotos)", () => {
    const lit = findConstLiteral("const readPhotos={0: [\"https://example.com/a.png\", \"Caption\"], 1: [\"https://example.com/b.png\", \"Other\"]};", "readPhotos");
    expect(lit?.node.kind).toBe("object");
    const first = getField(lit!.node, "0");
    expect(first?.kind).toBe("array");
    if (first?.kind === "array") expect(str(first.items[1])).toBe("Caption");
  });
});

describe("security", () => {
  it("rejects path traversal", () => {
    expect(safePath("../evil.txt")).toBeNull();
    expect(safePath("/abs/path.png")).toBe("abs/path.png");
    expect(safePath("a/../b.png")).toBe("b.png");
  });
  it("rejects script SVGs", () => {
    expect(svgLooksSafe('<svg onload="alert(1)"></svg>')).toBe(false);
    expect(svgLooksSafe('<svg><circle r="1"/></svg>')).toBe(true);
  });
});

describe("HTML text modifications", () => {
  it("extracts and applies a static text edit without touching other content", () => {
    const html = "<h1>Hello world</h1><p>Keep me</p>";
    const { blocks } = extractFileEditables("index.html", html);
    const target = blocks.find((b) => b.value.includes("Hello"));
    expect(target).toBeDefined();
    const out = applyEdits(html, [{ start: target!.start, end: target!.end, value: "Hello edited", rich: target!.rich, quote: target!.quote, js: target!.js }]);
    expect(out).toContain("Hello edited");
    expect(out).toContain("Keep me");
  });
  it("JS string edits escape quotes instead of breaking the literal", () => {
    const html = `<script>const tasks=[{title:'Cell types',points:8}];</script>`;
    const { blocks } = extractFileEditables("index.html", html);
    const title = blocks.find((b) => b.label.includes("Title"));
    expect(title?.value).toBe("Cell types");
    const out = applyEdits(html, [{ start: title!.start, end: title!.end, value: "Cell types — it's new", rich: false, quote: title!.quote, js: true }]);
    expect(out).toContain("Cell types — it\\'s new");
    expect(out).toContain("points:8");
  });
  it("rejects overlapping edits", () => {
    expect(() => applyEdits("abcdef", [
      { start: 0, end: 3, value: "x", rich: false, js: false },
      { start: 2, end: 5, value: "y", rich: false, js: false },
    ])).toThrow();
  });
});

describe("ZIP import / export / reimport (synthetic package)", () => {
  it("round-trips: import, edit text, replace image, export, reimport", async () => {
    const blob = await buildSampleZip();
    const pkg = await importZip(await blob.arrayBuffer(), "sample.zip");
    expect(pkg.manifest.scormVersion).toBe("1.2");
    expect(pkg.htmlFiles).toContain("index.html");
    const block = pkg.blocks.find((b) => b.value.includes("Plants turn sunlight"));
    expect(block).toBeDefined();
    const editedHtml = applyEdits(pkg.files.get("index.html")!.text!, [
      { start: block!.start, end: block!.end, value: "<p>Plants turn sunlight into sugars — <b>edited</b>.</p>", rich: true, js: false },
    ]);
    // Note: html-text blocks hold raw text nodes, so a paragraph edit replaces
    // the text node; the test below edits the node value directly instead.
    void editedHtml;
    const textNode = pkg.blocks.find((b) => b.kind === "html-text" && b.value.includes("Plants turn"));
    const html2 = applyEdits(pkg.files.get("index.html")!.text!, [
      { start: textNode!.start, end: textNode!.end, value: "Plants turn sunlight into sugars — edited.", rich: false, js: false },
    ]);
    pkg.files.get("index.html")!.text = html2;
    pkg.files.get("index.html")!.blob = new Blob([html2], { type: "text/html" });
    // Replace the image with a different 1x1 PNG (red instead of green).
    const red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADAgH/8z6ZJgAAAABJRU5ErkJggg==";
    const bin = atob(red);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    pkg.files.set("leaf.png", { path: "leaf.png", text: null, blob: new Blob([bytes], { type: "image/png" }), isBinary: true });

    const out = await exportZip(pkg);
    const pkg2 = await importZip(await out.arrayBuffer(), "exported.zip");
    expect(pkg2.manifest.raw).toBe(pkg.manifest.raw); // manifest byte-identical
    expect(pkg2.files.get("index.html")!.text).toContain("edited");
    expect(pkg2.files.get("leaf.png")!.blob!.size).toBeGreaterThan(0);
    expect(pkg2.manifest.launchHref).toBe("index.html");
  });

  it("preview builds without the launch file's assets missing", async () => {
    const blob = await buildSampleZip();
    const pkg = await importZip(await blob.arrayBuffer(), "sample.zip");
    const preview = await buildPreviewHtml(pkg);
    expect(preview).toContain("window.API");
    expect(preview).toContain("blob:");
  });
});

describe("unsupported packages", () => {
  it("rejects a ZIP without a manifest", async () => {
    const zip = new JSZip();
    zip.file("index.html", "<h1>hi</h1>");
    const blob = await zip.generateAsync({ type: "blob" });
    await expect(importZip(await blob.arrayBuffer(), "no-manifest.zip")).rejects.toThrow(/imsmanifest/);
  });
  it("never lets a traversal entry escape the package root", async () => {
    // JSZip itself normalises "../evil.txt" to "evil.txt" on write; the
    // import-time guarantee is that no entry is ever stored outside the
    // root and safePath() rejects a raw traversal path outright.
    expect(safePath("../../etc/passwd")).toBeNull();
    const zip = new JSZip();
    zip.file("imsmanifest.xml", SAMPLE_MANIFEST);
    zip.file("index.html", "<h1>hi</h1>");
    zip.file("../evil.txt", "nope");
    const blob = await zip.generateAsync({ type: "blob" });
    const pkg = await importZip(await blob.arrayBuffer(), "t.zip");
    expect(pkg.fileList.every((f) => !f.startsWith("..") && !f.startsWith("/"))).toBe(true);
  });
});
