import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

/**
 * Lightweight contenteditable editor (no Tiptap dependency, same toolbar
 * contract: bold/italic, size, colour, highlight, alignment, headings,
 * lists, undo/redo). The parent sanitizes the HTML before it is written
 * back into a course file.
 */
export default function RichTextEditor({ value, onChange, placeholder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastValue = useRef(value);

  useEffect(() => {
    if (ref.current && lastValue.current !== value) {
      ref.current.innerHTML = value;
      lastValue.current = value;
    }
  }, [value]);

  const exec = (cmd: string, arg?: string) => {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, arg);
    if (ref.current) {
      lastValue.current = ref.current.innerHTML;
      onChange(ref.current.innerHTML);
    }
  };

  const wrapSelection = (tag: string, style?: string) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text) return;
    const styleAttr = style ? ` style="${style}"` : "";
    document.execCommand("insertHTML", false, `<${tag}${styleAttr}>${text.replace(/</g, "&lt;")}</${tag}>`);
    if (ref.current) {
      lastValue.current = ref.current.innerHTML;
      onChange(ref.current.innerHTML);
    }
  };

  const btn = "px-2 py-1 rounded border bg-white hover:bg-slate-100 text-sm";
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2 items-center">
        <button type="button" className={btn} title="Bold" onClick={() => exec("bold")}><b>B</b></button>
        <button type="button" className={btn} title="Italic" onClick={() => exec("italic")}><i>I</i></button>
        <button type="button" className={btn} title="Underline" onClick={() => exec("underline")}><u>U</u></button>
        <select className={btn} title="Font size" defaultValue="" onChange={(e) => { if (e.target.value) wrapSelection("span", `font-size:${e.target.value}px`); e.target.value = ""; }}>
          <option value="" disabled>Size</option>
          {[12, 14, 16, 18, 20, 24, 28].map((s) => <option key={s} value={s}>{s}px</option>)}
        </select>
        <label className={btn} title="Text colour">A <input type="color" className="w-6 h-5 align-middle" onChange={(e) => exec("foreColor", e.target.value)} /></label>
        <label className={btn} title="Highlight">🖍 <input type="color" className="w-6 h-5 align-middle" defaultValue="#ffff00" onChange={(e) => exec("hiliteColor", e.target.value)} /></label>
        <button type="button" className={btn} onClick={() => exec("justifyLeft")}>Left</button>
        <button type="button" className={btn} onClick={() => exec("justifyCenter")}>Centre</button>
        <button type="button" className={btn} onClick={() => exec("justifyRight")}>Right</button>
        <select className={btn} title="Heading" defaultValue="" onChange={(e) => { if (e.target.value) exec("formatBlock", e.target.value); e.target.value = ""; }}>
          <option value="" disabled>Style</option>
          <option value="p">Paragraph</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>
        <button type="button" className={btn} onClick={() => exec("insertUnorderedList")}>• List</button>
        <button type="button" className={btn} onClick={() => exec("insertOrderedList")}>1. List</button>
        <button type="button" className={btn} onClick={() => exec("undo")}>↩ Undo</button>
        <button type="button" className={btn} onClick={() => exec("redo")}>↪ Redo</button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        className="min-h-[160px] w-full rounded border bg-white p-3 text-[15px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-teal-600"
        data-placeholder={placeholder}
        onInput={(e) => {
          const html = (e.target as HTMLDivElement).innerHTML;
          lastValue.current = html;
          onChange(html);
        }}
        dangerouslySetInnerHTML={{ __html: value }}
      />
    </div>
  );
}
