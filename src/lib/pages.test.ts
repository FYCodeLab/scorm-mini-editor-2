import { describe, it, expect } from "vitest";
import { parseLessons, buildPages, wrapOriginalHtml } from "./pages";
import { importZip } from "./scormPackage";
import { buildSampleZip } from "./sample";

const JS_COURSE = `<html><head><title>Demo</title></head><body><div class="main"></div><script>
const tasks=[
{module:1,title:'Cell types',pages:'Worksheet, pp. 3-4',kind:'classify',points:8,items:['A','B'],targets:['X','Y'],keys:[0,1]},
{module:1,title:'Reprogramming',pages:'Worksheet, p. 5',kind:'reprogram',points:3}
];
const syntheses=["Summary one about cells.", "Reprogramming converts cells."];
const imageUrls={welcome:'https://example.com/welcome.jpg'};
const readPhotos={0: ["https://example.com/photo0.jpg", "Photo 0 caption"]};
</script></body></html>`;

describe("pages (Editor 2)", () => {
  it("parses JS lessons and builds a Welcome + lesson page per task", async () => {
    const lessons = parseLessons(JS_COURSE);
    expect(lessons.map((l) => l.title)).toEqual(["Cell types", "Reprogramming"]);
    // Build a package-like object via a real import of a JS-course zip.
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("imsmanifest.xml", `<?xml version="1.0"?><manifest identifier="demo" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata><organizations default="ORG"><organization identifier="ORG"><title>Demo</title><item identifier="I" identifierref="R"><title>Demo</title></item></organization></organizations><resources><resource identifier="R" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>`);
    zip.file("index.html", JS_COURSE);
    const blob = await zip.generateAsync({ type: "blob" });
    const pkg = await importZip(await blob.arrayBuffer(), "js.zip");
    const pages = buildPages(pkg);
    expect(pages.map((p) => p.title)).toEqual(["Welcome", "Lesson 1 — Cell types", "Lesson 2 — Reprogramming"]);
    expect(pages[1].html).toContain("data-block-id");
    expect(pages[1].html).toContain("Summary one about cells");
    expect(pages[1].html).toContain("data-image-src=\"https://example.com/photo0.jpg\"");
    expect(pages[2].html).toContain("Reprogramming converts cells");
  });

  it("wraps generic HTML text in red-box spans and drops scripts", async () => {
    const blob = await buildSampleZip();
    const pkg = await importZip(await blob.arrayBuffer(), "sample.zip");
    const pages = buildPages(pkg);
    expect(pages.length).toBe(1);
    expect(pages[0].html).toContain("data-block-id");
    expect(pages[0].html).toContain("Photosynthesis Basics");
    expect(pages[0].html).not.toContain("<script");
    expect(pages[0].html).toContain('data-image-src="leaf.png"');
  });

  it("wrapOriginalHtml keeps block ids on text nodes", () => {
    const html = "<html><body><h1>Hello</h1><p>Keep me</p></body></html>";
    const out = wrapOriginalHtml(html, [{ id: "b1", file: "index.html", kind: "html-text", label: "Hello", group: "x", value: "Hello", start: html.indexOf("Hello"), end: html.indexOf("Hello") + 5, rich: true, original: "Hello", js: false }], []);
    expect(out).toContain('data-block-id="b1"');
    expect(out).toContain("Keep me");
  });
});
