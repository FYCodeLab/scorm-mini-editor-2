/**
 * Injected script for Editor 2's faithful WYSIWYG.
 *
 * The WYSIWYG is NOT a reconstruction: it is the course itself, rendered
 * by its own HTML/CSS/JS inside a sandboxed iframe, exactly as Moodle
 * would render it (two-column grid, lime frame, pills, bottom bar).
 * This script only adds, on top of that rendering:
 *  - navigation to the requested lesson (via the course's own jumpTo(),
 *    when it exists),
 *  - clean red rectangles around editable elements (block containers,
 *    not inline text spans, so the box is a rectangle, not a jagged
 *    line-by-line outline),
 *  - click-to-select: clicking a red box posts its block/image id to the
 *    parent, which opens the editor below the page.
 * Course navigation buttons (.bottom) are blocked in edit mode so the
 * iframe cannot silently leave the page the Editor 2 arrows selected.
 */
export interface InjectBlock { id: string; text: string }
export interface InjectImage { src: string }
export interface InjectInfo {
  lesson: number | null; // -1 = welcome, >=0 = lesson index, null = generic HTML page
  blocks: InjectBlock[];
  images: InjectImage[];
  /** local file name -> Blob URL, for JS-template local images (e.g. culture_dish_reference.png). */
  localMap: Record<string, string>;
  /** Blob URL -> local file name, reverse map for click reporting. */
  blobMap: Record<string, string>;
}

function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Returns a <script>…</script> string to insert before </body>. */
export function buildEditor2Script(info: InjectInfo): string {
  const data = safeJson(info);
  // NOTE: this script is written without any literal "</script>" sequence.
  const body = `
(function(){
  var INFO = ${data};
  var style = document.createElement('style');
  style.textContent = '.e2-red{outline:3px solid #dc2626 !important;outline-offset:2px;cursor:pointer !important}';
  document.head.appendChild(style);
  function textOf(el){ return (el.innerText || el.textContent || '').trim(); }
  function originalSrc(img){
    var d = img.getAttribute('data-original-src');
    if (d) return d;
    if (INFO.blobMap[img.src]) return INFO.blobMap[img.src];
    return img.getAttribute('src') || img.src || '';
  }
  function fixLocalImages(){
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++){
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      if (!src || src.indexOf('blob:') === 0 || src.indexOf('http') === 0 || src.indexOf('data:') === 0) continue;
      var name = src.split('/').pop().split('?')[0].split('#')[0];
      if (INFO.localMap[name]) img.src = INFO.localMap[name];
    }
  }
  function applyRed(){
    fixLocalImages();
    var all = Array.prototype.slice.call(document.querySelectorAll('body *'));
    // Blocks: prefer an exact match, else the smallest element containing the full text.
    INFO.blocks.forEach(function(b){
      var want = (b.text || '').trim();
      if (want.length < 2) return;
      var best = null, bestLen = Infinity;
      for (var i = 0; i < all.length; i++){
        var el = all[i];
        if (el.classList.contains('e2-red')) continue;
        var t = textOf(el);
        if (t === want){ best = el; break; }
        if (t.length > want.length && t.length < want.length + 160 && t.indexOf(want) !== -1 && t.length < bestLen){
          // Prefer elements that are not the whole page (skip body/main wrappers with huge text).
          if (el.tagName !== 'BODY' && el.tagName !== 'MAIN' && el.className !== 'main'){ best = el; bestLen = t.length; }
        }
      }
      if (best){ best.classList.add('e2-red'); best.setAttribute('data-e2-block', b.id); }
    });
    // Images: match by original src (external URL, data-original-src, or blob map).
    var imgs = document.querySelectorAll('img');
    for (var j = 0; j < imgs.length; j++){
      var img = imgs[j];
      var orig = originalSrc(img);
      var hit = INFO.images.some(function(im){ return im.src === orig || im.src === img.src; });
      if (hit){ img.classList.add('e2-red'); img.setAttribute('data-e2-image', orig); }
    }
  }
  var timer = null;
  function schedule(){ if (timer) clearTimeout(timer); timer = setTimeout(applyRed, 120); }
  if (document.body){
    var obs = new MutationObserver(function(muts){
      for (var i = 0; i < muts.length; i++){ if (muts[i].type === 'childList'){ schedule(); break; } }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  document.addEventListener('click', function(e){
    var t = e.target;
    var red = t && t.closest ? t.closest('.e2-red') : null;
    if (red){
      e.preventDefault(); e.stopPropagation();
      var bid = red.getAttribute('data-e2-block');
      var isrc = red.getAttribute('data-e2-image');
      if (bid) window.parent.postMessage({type:'e2-select-block', id: bid}, '*');
      else if (isrc) window.parent.postMessage({type:'e2-select-image', src: isrc}, '*');
      return;
    }
    var bottomBtn = t && t.closest ? t.closest('.bottom button') : null;
    if (bottomBtn){ e.preventDefault(); e.stopPropagation(); }
  }, true);
  function navigate(){
    if (INFO.lesson === null) return;
    if (typeof window.jumpTo === 'function'){
      try{ window.jumpTo(INFO.lesson, INFO.lesson === -1 ? 'welcome' : 'read'); }catch(err){}
      setTimeout(applyRed, 50);
    }
  }
  // The course script runs before this one (it is earlier in the body),
  // so jumpTo already exists here. Still, retry once in case of ordering.
  navigate();
  setTimeout(navigate, 300);
  applyRed();
})();
`;
  return `<script>${body}</script>`;
}
