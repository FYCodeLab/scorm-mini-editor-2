import { describe, it, expect } from "vitest";
import { buildEditor2Script } from "./editor2Inject";
import { buildPreviewHtml, importZip } from "./scormPackage";
import { buildSampleZip } from "./sample";

describe("Editor 2 faithful WYSIWYG injection", () => {
  it("builds a syntactically valid script that navigates and posts red-box clicks", () => {
    const script = buildEditor2Script({
      lesson: 2,
      blocks: [{ id: "b1", text: "Reprogramming converts cells." }],
      images: [{ src: "https://example.com/photo.jpg" }],
      localMap: { "culture_dish_reference.png": "blob:fake" },
      blobMap: {},
    });
    expect(script.startsWith("<script>")).toBe(true);
    expect(script).toContain("jumpTo");
    expect(script).toContain("e2-red");
    expect(script).toContain("e2-select-block");
    expect(script).toContain("e2-select-image");
    // No unescaped closing script tag inside the body.
    const inner = script.slice("<script>".length, -"</script>".length);
    expect(inner).not.toContain("</script>");
    // Parses as JavaScript (does not execute: document/window are absent here).
    expect(() => new Function(inner)).not.toThrow();
  });

  it("preview with a file override keeps data-original-src on local images", async () => {
    const blob = await buildSampleZip();
    const pkg = await importZip(await blob.arrayBuffer(), "sample.zip");
    const html = await buildPreviewHtml(pkg, undefined, "index.html");
    expect(html).toContain("window.API");
    expect(html).toContain('data-original-src="leaf.png"');
    expect(html).toContain("data:image/png;base64,");
  });
});
