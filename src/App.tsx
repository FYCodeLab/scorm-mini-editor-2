import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { importZip, exportZip, refreshFile, buildPreviewHtml, blobToDataUrl, type ScormPackage } from "./lib/scormPackage";
import { applyEdits } from "./lib/editables";
import { buildPages } from "./lib/pages";
import { buildSampleZip } from "./lib/sample";
import { isExternalUrl, isImagePath, safePath, svgLooksSafe } from "./lib/security";
import { buildEditor2Script } from "./lib/editor2Inject";
import RichTextEditor from "./components/RichTextEditor";

interface HistoryEntry { file: string; before: string; after: string; label: string; }
const sanitizeRich = (html: string) => DOMPurify.sanitize(html, { ALLOWED_TAGS: ["b","strong","i","em","u","span","p","br","h2","h3","h4","ul","ol","li","a"], ALLOWED_ATTR: ["style","href","target"], FORBID_TAGS: ["script","style","iframe","form","img"] });

export default function App() {
  const [pkg, setPkg] = useState<ScormPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  // Full-width screenshot scaling: the WYSIWYG is always rendered at the
  // MOOC's desktop width (1100px, or wider on a wide screen) and scaled
  // down uniformly to fit the container. No narrow-portrait reflow, no
  // stretching: the same layout in portrait and landscape, text small
  // in portrait, exactly as a screenshot of Moodle would look.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(1100);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w && w > 0) setWrapW(w); });
    ro.observe(el);
    setWrapW(el.getBoundingClientRect().width || 1100);
    return () => ro.disconnect();
  }, [pkg]);
  const VIEW_W = Math.max(1100, Math.round(wrapW));
  const VIEW_H = 720;
  const scale = wrapW > 0 ? wrapW / VIEW_W : 1;
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const blobUrls = useRef<string[]>([]);

  const pages = useMemo(() => (pkg ? buildPages(pkg) : []), [pkg]);
  const page = pages[pageIndex];
  const selectedBlock = useMemo(() => pkg?.blocks.find((b) => b.id === selectedId), [pkg, selectedId]);

  useEffect(() => { if (selectedBlock) setDraft(selectedBlock.value); }, [selectedBlock?.id]); // eslint-disable-line
  useEffect(() => () => { blobUrls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const isJsCourse = pages.length > 0 && pages[0].id === "welcome";
  // Faithful WYSIWYG: the course itself, rendered by its own HTML/CSS/JS
  // in a sandboxed iframe, with red rectangles injected on top.
  // For JS courses the iframe always loads the launch file and the
  // injected script navigates it to the selected lesson (jumpTo).
  // For generic courses it loads the selected HTML file directly.
  useEffect(() => {
    if (!pkg || !page) return;
    let cancelled = false;
    const lesson = isJsCourse ? pageIndex - 1 : null;
    const pageBlocks = isJsCourse
      ? pkg.blocks.filter((b) => {
          if (lesson === -1) return b.group === "Welcome";
          const L = (lesson ?? 0) + 1;
          return b.label.startsWith(`Lesson ${L} ·`) || b.label === `readPhotos[${lesson}] · caption`;
        })
      : pkg.blocks.filter((b) => b.file === page.file);
    const pageImages = isJsCourse
      ? pkg.images.filter((im) => {
          if (lesson === -1) return im.context === "imageUrls.welcome";
          return im.context === `readPhotos[${lesson}] · image` || im.context.startsWith("imageUrls.");
        })
      : pkg.images.filter((im) => im.file === page.file);
    // Deduplicate images by src for the injected script.
    const seenImg = new Set<string>();
    const uniqImages = pageImages.filter((im) => { if (seenImg.has(im.src)) return false; seenImg.add(im.src); return true; });
    (async () => {
      // Local images as data URLs (not Blob URLs) so they load inside the
      // sandboxed iframe on iOS Safari, where Blob-URL subresources fail.
      const localMap: Record<string, string> = {};
      const blobMap: Record<string, string> = {};
      for (const path of pkg.fileList.filter(isImagePath)) {
        const f = pkg.files.get(path);
        if (f?.blob && f.blob.size <= 5 * 1024 * 1024) {
          const url = await blobToDataUrl(f.blob);
          localMap[path.split("/").pop()!] = url;
          blobMap[url] = path;
        }
      }
      const html = await buildPreviewHtml(pkg, (url, resolved) => { if (url.startsWith("blob:")) blobUrls.current.push(url); blobMap[url] = resolved; }, isJsCourse ? undefined : page.file);
      return { html, localMap, blobMap };
    })()
      .then(({ html, localMap, blobMap }) => {
        if (cancelled) return;
        const script = buildEditor2Script({
          lesson,
          blocks: pageBlocks.map((b) => ({ id: b.id, text: b.value })),
          images: uniqImages.map((im) => ({ src: im.src })),
          localMap,
          blobMap,
        });
        const withScript = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : html + script;
        const url = URL.createObjectURL(new Blob([withScript], { type: "text/html" }));
        blobUrls.current.push(url);
        setPreviewUrl(url);
        setPreviewKey((k) => k + 1);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [pkg, page, pageIndex, isJsCourse]);

  // Messages from the iframe: red-box clicks.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "e2-select-block" && typeof e.data.id === "string") {
        setSelectedId(e.data.id); setSelectedImage(null);
        document.getElementById("editor-below")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (e.data?.type === "e2-select-image" && typeof e.data.src === "string") {
        setSelectedImage(e.data.src); setSelectedId(null);
        document.getElementById("editor-below")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const loadBlob = useCallback(async (blob: Blob, name: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const p = await importZip(await blob.arrayBuffer(), name);
      setPkg(p); setHistory([]); setRedoStack([]); setPageIndex(0); setSelectedId(null); setSelectedImage(null);
      if (p.warnings.length) setNotice(`Imported with warnings: ${p.warnings.join(" ")}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, []);

  const onDropFile = (f: File) => { if (!/\.zip$/i.test(f.name)) { setError("Please choose a .zip file."); return; } void loadBlob(f, f.name); };
  const go = (delta: number) => {
    if (!pages.length) return;
    setPageIndex((i) => Math.max(0, Math.min(pages.length - 1, i + delta)));
    setSelectedId(null); setSelectedImage(null);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const applyBlockEdit = () => {
    if (!pkg || !selectedBlock) return;
    const file = pkg.files.get(selectedBlock.file); if (!file?.text) return;
    const value = selectedBlock.rich ? sanitizeRich(draft) : draft;
    if (value === selectedBlock.value) { setNotice("No change to apply."); return; }
    try {
      const nextText = applyEdits(file.text, [{ start: selectedBlock.start, end: selectedBlock.end, value, rich: selectedBlock.rich, quote: selectedBlock.quote, js: selectedBlock.js, template: selectedBlock.template }]);
      const updated = new Map(pkg.files);
      updated.set(selectedBlock.file, { ...file, text: nextText, blob: new Blob([nextText], { type: "text/html" }) });
      const nextPkg = refreshFile({ ...pkg, files: updated }, selectedBlock.file);
      setHistory((h) => [...h, { file: selectedBlock.file, before: file.text!, after: nextText, label: selectedBlock.label }]);
      setRedoStack([]); setPkg(nextPkg);
      const reFound = nextPkg.blocks.find((b) => b.label === selectedBlock.label && b.value === value) ?? nextPkg.blocks.find((b) => b.label === selectedBlock.label);
      setSelectedId(reFound?.id ?? null); setNotice(`Applied: ${selectedBlock.label}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const restore = (entry: HistoryEntry, to: "before" | "after") => {
    if (!pkg) return;
    const file = pkg.files.get(entry.file); if (!file) return;
    const text = to === "before" ? entry.before : entry.after;
    const updated = new Map(pkg.files);
    updated.set(entry.file, { ...file, text, blob: new Blob([text], { type: "text/html" }) });
    setPkg(refreshFile({ ...pkg, files: updated }, entry.file));
  };
  const undo = () => { if (!history.length) return; const e = history[history.length - 1]; restore(e, "before"); setHistory(history.slice(0, -1)); setRedoStack((r) => [...r, e]); };
  const redo = () => { if (!redoStack.length) return; const e = redoStack[redoStack.length - 1]; restore(e, "after"); setRedoStack(redoStack.slice(0, -1)); setHistory((h) => [...h, e]); };

  const doExport = async () => {
    if (!pkg) return; setBusy(true);
    try {
      const blob = await exportZip(pkg);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = pkg.name.replace(/\.zip$/i, "") + "-edited.zip"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setNotice("Exported ZIP downloaded. It does not overwrite your original file.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const handleReplaceImage = async (f: File) => {
    if (!pkg || !selectedImage) return;
    if (!/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.name)) { setError("Choose a PNG, JPEG, GIF, WebP, SVG or AVIF image."); return; }
    if (f.size > 20 * 1024 * 1024) { setError("Image is larger than 20 MB."); return; }
    if (/\.svg$/i.test(f.name) && !svgLooksSafe(await f.text())) { setError("This SVG contains scripts or event handlers and was rejected for safety."); return; }
    const updated = new Map(pkg.files);
    const refs = pkg.images.filter((im) => im.src === selectedImage);
    // A local file clicked in the real course rendering (logo, or a
    // JS-template image like culture_dish_reference.png) may have no
    // ImageRef entry at all. If the path exists in the package, replace
    // the file itself — that is the correct local replacement.
    if (pkg.files.has(selectedImage) || [...pkg.files.keys()].some((k) => k.endsWith("/" + selectedImage))) {
      const path = pkg.files.has(selectedImage) ? selectedImage : [...pkg.files.keys()].find((k) => k.endsWith("/" + selectedImage))!;
      updated.set(path, { path, text: null, blob: f, isBinary: true });
      setPkg({ ...pkg, files: updated }); setNotice(`Replaced ${selectedImage}.`);
      setSelectedImage(null);
      return;
    }
    if (refs.length && refs[0].local) {
      const resolved = selectedImage.startsWith("/") ? selectedImage.slice(1) : selectedImage;
      const path = pkg.files.has(resolved) ? resolved : [...pkg.files.keys()].find((k) => k.endsWith("/" + resolved)) ?? resolved;
      updated.set(path, { path, text: null, blob: f, isBinary: true });
      setPkg({ ...pkg, files: updated }); setNotice(`Replaced ${selectedImage}.`);
    } else {
      let filename = (safePath(f.name) ?? "replacement.png").split("/").pop()!;
      let n = 1;
      while (updated.has(filename)) { const dot = filename.lastIndexOf("."); filename = `${filename.slice(0, dot)}-${n}${filename.slice(dot)}`; n++; }
      updated.set(filename, { path: filename, text: null, blob: f, isBinary: true });
      const filesToFix = new Set(refs.map((im) => im.file));
      // Fallback for template images with no offset entry: replace every
      // occurrence of the URL string in every HTML file.
      if (filesToFix.size === 0 && isExternalUrl(selectedImage)) {
        for (const hf of pkg.htmlFiles) {
          const hfFile = updated.get(hf);
          if (hfFile?.text && hfFile.text.includes(selectedImage)) {
            const text = hfFile.text.split(selectedImage).join(filename);
            updated.set(hf, { ...hfFile, text, blob: new Blob([text], { type: "text/html" }) });
          }
        }
      }
      for (const hf of filesToFix) {
        const hfFile = updated.get(hf); if (!hfFile?.text) continue;
        const r = pkg.images.filter((im) => im.file === hf && im.src === selectedImage).sort((a, b) => b.start - a.start);
        let text = hfFile.text;
        for (const x of r) text = text.slice(0, x.start) + filename + text.slice(x.end);
        updated.set(hf, { ...hfFile, text, blob: new Blob([text], { type: "text/html" }) });
      }
      const firstFile = refs[0]?.file ?? page?.file;
      let nextPkg = firstFile ? refreshFile({ ...pkg, files: updated }, firstFile) : { ...pkg, files: updated };
      // If the fallback rewrote other HTML files, recompute their blocks
      // too, so later edits on those files do not use stale offsets.
      if (filesToFix.size === 0 && isExternalUrl(selectedImage)) {
        for (const hf of pkg.htmlFiles) nextPkg = refreshFile(nextPkg, hf);
      }
      const mf = nextPkg.files.get("imsmanifest.xml");
      if (mf?.text && !mf.text.includes(`href="${filename}"`)) {
        const patched = mf.text.replace(/(<\/resource>)/i, `  <file href="${filename}"/>\n$1`);
        if (patched !== mf.text) nextPkg.files.set("imsmanifest.xml", { ...mf, text: patched, blob: new Blob([patched], { type: "text/xml" }) });
      }
      setPkg(nextPkg); setNotice(`External image replaced with local file ${filename}.`);
    }
    setSelectedImage(null);
  };

  const makeLocal = async () => {
    if (!pkg || !selectedImage) return; setBusy(true); setError(null);
    try {
      const res = await fetch(selectedImage, { mode: "cors" });
      if (!res.ok) throw new Error(`Server returned ${res.status}.`);
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Not an image.");
      const base = decodeURIComponent(selectedImage.split("?")[0].split("/").pop() || "image.png");
      await handleReplaceImage(new File([blob], safePath(base) ?? "image.png", { type: blob.type }));
    } catch {
      setError(`Could not download ${selectedImage}: the host does not allow cross-origin downloads (CORS), or it blocked the request. Upload a file you own instead. No restriction was bypassed.`);
    } finally { setBusy(false); }
  };

  if (!pkg) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-800">
        <header className="bg-teal-900 text-white px-6 py-5">
          <h1 className="text-2xl font-bold">SCORM Mini Editor 2 — Page Editor</h1>
          <p className="text-teal-100">One page at a time, in WYSIWYG. Editable parts are outlined in red — click one, then edit it below. No account, no server upload: everything runs on your computer.</p>
        </header>
        <main className="max-w-3xl mx-auto px-4 py-8">
          {error && <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-red-800">{error}</div>}
          <div className={`rounded-xl border-2 border-dashed p-10 text-center ${dragOver ? "border-teal-600 bg-teal-50" : "border-slate-300 bg-white"}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) onDropFile(f); }}>
            <p className="text-lg font-semibold">Import a SCORM ZIP</p>
            <p className="text-slate-500 my-2">Use the ← → arrows to move between pages. Click a red box to edit that text or image below the page.</p>
            <input ref={fileInput} type="file" accept=".zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onDropFile(f); }} />
            <button className="mt-2 rounded bg-teal-700 px-5 py-2.5 text-white font-semibold" onClick={() => fileInput.current?.click()} disabled={busy}>{busy ? "Importing…" : "Import SCORM ZIP"}</button>
            <div className="mt-3"><button className="text-teal-700 underline" onClick={async () => { const b = await buildSampleZip(); void loadBlob(b, "sample-scorm.zip"); }}>Or try the built-in demo course (no file needed)</button></div>
          </div>
          <p className="mt-6 text-sm text-slate-500">Difference from Editor 1: Editor 1 lists editable blocks in a side panel. Editor 2 shows the page itself, with editable parts in red, and the editor underneath. Same import/export engine, same manifest preservation, same limits: template-generated text without a red box is not editable, and preview here is the editable page itself — always test the exported ZIP in your real LMS before classroom use.</p>
        </main>
        <footer className="px-4 py-3 text-right text-xs text-slate-400">Made by FYCodeLab</footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col">
      <header className="bg-teal-900 text-white px-4 py-3 flex flex-wrap gap-2 items-center">
        <div className="mr-2"><div className="font-bold leading-tight">SCORM Mini Editor 2</div><div className="text-xs text-teal-200">{pkg.name} · SCORM {pkg.manifest.scormVersion}</div></div>
        <input ref={fileInput} type="file" accept=".zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onDropFile(f); }} />
        <button className="rounded bg-teal-700 px-3 py-1.5 text-sm" onClick={() => fileInput.current?.click()}>Import ZIP</button>
        <button className="rounded bg-white text-teal-900 px-3 py-1.5 text-sm font-semibold" onClick={doExport} disabled={busy}>Export SCORM ZIP</button>
        <button className="rounded border border-teal-300 px-3 py-1.5 text-sm disabled:opacity-50" onClick={undo} disabled={history.length === 0}>↩ Undo</button>
        <button className="rounded border border-teal-300 px-3 py-1.5 text-sm disabled:opacity-50" onClick={redo} disabled={redoStack.length === 0}>↪ Redo</button>
        <button className="rounded border border-red-300 px-3 py-1.5 text-sm" onClick={() => { setPkg(null); setSelectedId(null); setSelectedImage(null); }}>Close course</button>
      </header>
      {error && <div className="mx-4 mt-3 rounded border border-red-300 bg-red-50 p-3 text-red-800">{error} <button className="underline ml-2" onClick={() => setError(null)}>Dismiss</button></div>}
      {notice && <div className="mx-4 mt-3 rounded border border-teal-300 bg-teal-50 p-3 text-teal-900">{notice} <button className="underline ml-2" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {pkg.warnings.length > 0 && <div className="mx-4 mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm">Warnings: {pkg.warnings.join(" ")}</div>}

      {/* Page navigation */}
      <div className="flex items-center justify-center gap-4 px-4 py-3">
        <button aria-label="Previous page" className="rounded-full bg-teal-700 text-white w-11 h-11 text-2xl disabled:opacity-40" onClick={() => go(-1)} disabled={pageIndex === 0}>←</button>
        <div className="text-center">
          <div className="font-bold">{page?.title ?? "No pages"}</div>
          <div className="text-sm text-slate-500">Page {pages.length ? pageIndex + 1 : 0} of {pages.length}{page?.subtitle ? ` · ${page.subtitle}` : ""} · ← → keys also work</div>
        </div>
        <button aria-label="Next page" className="rounded-full bg-teal-700 text-white w-11 h-11 text-2xl disabled:opacity-40" onClick={() => go(1)} disabled={pageIndex >= pages.length - 1}>→</button>
      </div>

      {/* WYSIWYG section: the real course, full-width scaled screenshot */}
      <main className="px-4 pb-2">
        <p className="text-xs text-slate-500 mb-2 text-center">Red rectangle = editable. Click one, then edit it below.</p>
        <div ref={wrapRef} className="w-full" style={{ height: VIEW_H * scale, position: "relative", overflow: "hidden" }}>
          {previewUrl ? (
            <iframe key={previewKey} title="Course WYSIWYG" sandbox="allow-scripts" src={previewUrl} style={{ width: VIEW_W, height: VIEW_H, border: 0, position: "absolute", left: 0, top: 0, transform: `scale(${scale})`, transformOrigin: "0 0" }} />
          ) : (
            <p className="text-slate-500 text-center py-10">Loading the course page…</p>
          )}
          {!page && <p className="text-slate-500">No pages found in this package.</p>}
        </div>
      </main>

      {/* Editor below the WYSIWYG section */}
      <section id="editor-below" className="px-4 pb-6">
        <div className="max-w-4xl mx-auto rounded border bg-white p-4">
          {selectedBlock ? (
            <>
              <h2 className="font-bold">{selectedBlock.label}</h2>
              <p className="text-sm text-slate-500 mb-2">File: {selectedBlock.file} · {selectedBlock.rich ? "Formatting (bold, colour, size) is supported for this block." : "Plain text only: the course escapes HTML here, so a tag would be shown literally to learners."}</p>
              {selectedBlock.rich ? <RichTextEditor value={draft} onChange={setDraft} /> : <textarea className="w-full min-h-[140px] rounded border p-3 text-[15px]" value={draft} onChange={(e) => setDraft(e.target.value)} />}
              <div className="flex gap-2 mt-3">
                <button className="rounded bg-teal-700 px-4 py-2 text-white font-semibold" onClick={applyBlockEdit}>Apply change</button>
                <button className="rounded border px-4 py-2" onClick={() => setDraft(selectedBlock.value)}>Reset</button>
              </div>
            </>
          ) : selectedImage ? (
            <>
              <h2 className="font-bold">Image</h2>
              <p className="text-sm break-all mb-2">{selectedImage}</p>
              <input ref={replaceInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleReplaceImage(f); e.target.value = ""; }} />
              <div className="flex gap-2 flex-wrap">
                <button className="rounded bg-teal-700 px-4 py-2 text-white font-semibold" onClick={() => replaceInput.current?.click()}>Replace with upload</button>
                {!isExternalUrl(selectedImage) ? null : <button className="rounded border px-4 py-2" onClick={makeLocal} disabled={busy}>Make local (download)</button>}
              </div>
              <p className="text-xs text-slate-500 mt-2">Local replacement keeps the file name; an external replacement is added as a new local file and the URL is rewritten everywhere it appears.</p>
            </>
          ) : (
            <h2 className="font-bold">Text/image editor ⬇️</h2>
          )}
        </div>
      </section>
      <footer className="mt-auto px-4 py-3 text-right text-xs text-slate-400">Made by FYCodeLab</footer>
    </div>
  );
}
