/**
 * Scans a 4e adventure PDF for monster stat blocks, entirely inside the browser (Foundry):
 *   pdf.js        reads the PDF, renders each page and gives the positions of the text layer
 *   locate.js     finds the stat block headers and their boxes from those positions
 *   image-core.js cuts each block out of the page image and turns its dark bars into dark-on-light text
 *   tesseract.js  reads the block image
 *   parseMV.js    turns the text into a block (traps and hazards are skipped)
 *
 * The libraries are loaded from the module's own vendor folder, so nothing is downloaded.
 */
import { locateBlocks, matchHeader } from "./locate.js";
import { crop, findBars, barExtent, invertBars } from "./image-core.js";
import { TRAP_ROLES } from "../parser/parseMV.js";
import { buildVocab } from "../parser/clean.js";
import { parseBlockBest } from "../parser/index.js";

const DPI = 300;

/**
 * Some PDFs space out their text ("W i l l", "Level 2 2", "H P 1"). Join runs of single characters
 * and normalise the bullet that separates keywords.
 */
export function despace(t) {
  let s = t.replace(/(?<![\w])((?:[A-Za-z0-9,;()+\-] ){2,}[A-Za-z0-9,;()+\-])(?![\w])/g, (m) => m.replace(/ /g, ""));
  s = s.replace(/\bH P\b/g, "HP").replace(/(?<![\d,+\-])(\d) (\d)(?![\d])/g, "$1$2").replace(/\s[•·]\s/g, " ✦ ");
  s = s.replace(/\b(?:hit|lnt|Jnt|1nt)(?=\s*\d+\s*\()/g, "Int");
  // joining can glue words together again: restore the spaces the parsers rely on
  s = s.replace(/\b(Str|Dex|Con|Int|Wis|Cha|HP|AC|XP|Level|Speed|Initiative)(?=\d)/g, "$1 ").replace(/(\d)\((?=[+\-–])/g, "$1 (").replace(/\)(?=[A-Z][a-z]{2})/g, ") ");
  return s;
}

/** Group pdf.js text items into lines: items on one baseline, split where the gap is wide (columns, right-aligned text). */
export function linesFromItems(items, viewport) {
  const words = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const h = it.height || Math.abs(it.transform[3]) || 8;
      // the viewport maps PDF user space to page-image coordinates (handles crop boxes and rotation)
      const [x0, base] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      const y1 = base + h * 0.2;
      return { x0, x1: x0 + it.width, y0: y1 - h, y1, t: it.str.trim() };
    })
    .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  // rows by vertical centre
  const rows = [];
  for (const w of words) {
    const mid = (w.y0 + w.y1) / 2;
    const row = rows.find((r) => Math.abs(r.mid - mid) < Math.min(4, (w.y1 - w.y0) * 0.45));
    if (row) { row.words.push(w); row.mid = (row.mid * (row.words.length - 1) + mid) / row.words.length; }
    else rows.push({ mid, words: [w] });
  }
  const lines = [];
  for (const row of rows) {
    row.words.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const w of row.words) {
      const h = w.y1 - w.y0;
      if (cur && w.x0 - cur.x1 < Math.max(6, h * 0.9)) {
        cur.words.push(w); cur.x1 = Math.max(cur.x1, w.x1); cur.y0 = Math.min(cur.y0, w.y0); cur.y1 = Math.max(cur.y1, w.y1);
      } else {
        cur = { x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, words: [w] };
        lines.push(cur);
      }
    }
  }
  for (const l of lines) l.text = despace(l.words.map((w) => w.t).join(" "));
  return lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}


/* ---------------- Monster Manual layout, read straight from the text layer ---------------- */

const MM_POWER_RE = /\((?:standard|move|minor|free|immediate|no action|opportunity|when|at-will|encounter|daily|recharge)[^)]*\)/i;
const MM_USAGE_RE = /\((?:[^()]*;\s*)?(?:at-will|encounter|daily|recharge)[^)]*\)/i;
const isFooterRow = (t) => FOOTER_RE.test(t) || (t.match(/\b(?:Str|Dex|Con|Int|Wis|Cha)\s*\d+/g) || []).length >= 2;
const FOOTER_RE = /^(?:Str|Dex|Con|Int|Wis|Cha)\s*\d|^Equipment\b|^Skills\b|^(?:[A-Z][a-z]+(?: [A-Z][a-z]+)? [+-]\d+,? ?)+$/;

/** Join lines that sit on the same row, left to right, into reading rows. */
function rowsOf(lines) {
  const sorted = [...lines].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  const rows = [];
  for (const l of sorted) {
    const mid = (l.y0 + l.y1) / 2;
    const row = rows.find((r) => Math.abs(r.mid - mid) < 3);
    if (row) row.lines.push(l); else rows.push({ mid, lines: [l] });
  }
  return rows.map((r) => ({ y0: Math.min(...r.lines.map((l) => l.y0)), y1: Math.max(...r.lines.map((l) => l.y1)), text: r.lines.sort((a, b) => a.x0 - b.x0).map((l) => l.text).join(" ") }));
}

/**
 * The text of one stat block taken from the PDF's own text layer (no OCR).
 * In the Monster Manual layout the ability scores and equipment come after the Alignment line,
 * so the block is read down to the last of those lines.
 */
export function layerBlockText(page, b, pages = null) {
  const { x0, x1, y0 } = b.box;
  const inColumn = page.lines.filter((l) => l.x0 >= x0 - 3 && l.x1 <= x1 + 3 && l.y0 >= y0 - 1);
  const rows = rowsOf(inColumn);
  const out = [];
  let sawEnd = false, lastY = null;
  for (const r of rows) {
    if (!sawEnd) {
      if (r.y0 > b.box.y1 + 60 && b.endFound) break;
      out.push(r.text);
      if (/^align\w*\b/i.test(r.text) || (/\blanguages?\b/i.test(r.text) && /align/i.test(r.text))) { sawEnd = true; lastY = r.y1; }
      else if (!b.endFound && r.y0 > b.box.y1) break;
    } else {
      if (r.y0 - lastY > 16) break;
      if (isFooterRow(r.text) || (/^Equipment\b/i.test(out[out.length - 1]) && /^[a-z]/.test(r.text))) { out.push(r.text); lastY = r.y1; }
      else break;
    }
  }
  const nextRows = () => {
    if (!pages) return { rows: [], inRight: false };
    const inRight = x1 < page.width - 60 && page.lines.some((l) => l.x0 >= x1 - 10 && l.y0 < b.box.y0 && l.x1 <= page.width);
    const mid = page.width * 0.55;
    const next = inRight ? { page, test: (l) => l.x0 >= x1 - 10 } : pages[page.n] ? { page: pages[page.n], test: (l) => l.x1 <= mid } : null;
    return { rows: next ? rowsOf(next.page.lines.filter(next.test)) : [], inRight };
  };
  const isEnd = (t) => /^align\w*\b/i.test(t) || (/\blanguages?\b/i.test(t) && /align/i.test(t));
  // the block carries on in the next column or on the next page: read on until its Alignment line
  if (!sawEnd) {
    const { rows: rows2 } = nextRows();
    let started = false;
    for (const [k, r] of rows2.entries()) {
      if (matchHeader(r.text)) break;
      // skip pictures' captions and headings until the text of the block carries on
      if (!started) {
        if (/^[a-z]/.test(r.text) || MM_POWER_RE.test(r.text) || /^(?:Alignment|Skills|Str\b)/.test(r.text)) started = true;
        else continue;
      }
      out.push(r.text);
      if (isEnd(r.text)) {
        sawEnd = true; lastY = r.y1;
        for (const f of rows2.slice(k + 1, k + 6)) { if (f.y0 - lastY > 16 || !isFooterRow(f.text)) break; out.push(f.text); lastY = f.y1; }
        break;
      }
    }
  } else if (!out.some((t) => /^Str\s*\d/.test(t))) {
    // the ability scores were pushed into the next column or page
    const { rows: rows2 } = nextRows();
    let got = false;
    for (const r of rows2.slice(0, 8)) {
      if (matchHeader(r.text)) break;
      if (isFooterRow(r.text)) { out.push(r.text); got = true; } else if (got) break;
    }
  }
  return out.join("\n");
}

/** True when the block text uses "m Scimitar (standard; at-will) ✦ Fire"-style power headers. */
export function isMonsterManualLayout(text) {
  return text.split("\n").some((l) => MM_POWER_RE.test(l) && MM_USAGE_RE.test(l) && !/^(?:Attack|Hit|Miss|Effect)\b/i.test(l));
}

function toGray(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  return { width, height, gray };
}

function grayToCanvas(img, margin = 12) {
  const w = img.width + margin * 2, h = img.height + margin * 2;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  const id = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.gray.length; i++) { const v = img.gray[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  ctx.putImageData(id, margin, margin);
  return canvas;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("could not load " + src));
    document.head.appendChild(s);
  });
}

/**
 * @param {File|ArrayBuffer} file
 * @param {{ base: string, onProgress?: (p:{stage:string,current?:number,total?:number,message:string})=>void }} opts
 *        base: URL of the module folder, e.g. "modules/draw-steel-4e-converter"
 * @returns {{ blocks: object[], skipped: object[] }}
 */
export async function scanPdf(file, { base, onProgress = () => {}, shouldCancel = () => false, onDebug = null }) {
  onProgress({ stage: "load", message: "Loading PDF reader…" });
  const pdfjs = await import(`/${base}/vendor/pdfjs/pdf.min.mjs`.replace("//", "/"));
  pdfjs.GlobalWorkerOptions.workerSrc = `/${base}/vendor/pdfjs/pdf.worker.min.mjs`.replace("//", "/");
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;

  onProgress({ stage: "text", current: 0, total: doc.numPages, message: "Reading the text layer…" });
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({ n, width: vp.width, height: vp.height, lines: linesFromItems(content.items, vp) });
    if (n % 5 === 0) onProgress({ stage: "text", current: n, total: doc.numPages, message: `Reading the text layer… ${n}/${doc.numPages}` });
  }
  const vocab = buildVocab(pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n"));
  const located = locateBlocks(pages);
  if (!located.length) return { blocks: [], skipped: [] };

  let worker = null;
  const getWorker = async () => {
    if (worker) return worker;
    onProgress({ stage: "ocr-init", message: "Starting the text reader…" });
    await loadScript(`/${base}/vendor/tesseract/tesseract.min.js`.replace("//", "/"));
    worker = await globalThis.Tesseract.createWorker("eng", 1, {
      workerPath: `/${base}/vendor/tesseract/worker.min.js`.replace("//", "/"),
      corePath: `/${base}/vendor/tesseract/`.replace("//", "/"),
      langPath: `/${base}/vendor/tesseract/`.replace("//", "/"),
      gzip: false,
      workerBlobURL: false
    });
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
    return worker;
  };

  const blocks = [], skipped = [], seen = new Map();
  let pageNo = 0, pageImg = null;
  try {
    for (const [i, b] of located.entries()) {
      if (shouldCancel()) break;
      onProgress({ stage: "ocr", current: i + 1, total: located.length, message: `Reading stat block ${i + 1} of ${located.length}: ${b.rawName || "…"}` });
      if (TRAP_ROLES.has(b.role)) { skipped.push({ name: b.rawName, page: b.page, reason: "trap or hazard" }); continue; }
      // a real text layer can be read directly; accept it when it passes the checks, otherwise read the page image too
      const layer = layerBlockText(pages[b.page - 1], b, pages);
      const hint = { rawName: b.rawName, level: b.level, role: b.role, organization: b.organization, leader: b.leader, page: b.page };
      const mmLayout = isMonsterManualLayout(layer);
      let fromLayer = mmLayout || /\bAlign\w*\b/i.test(layer) ? parseBlockBest(layer, { vocab, hint }) : null;
      if (fromLayer) { fromLayer.source = { ...(fromLayer.source || {}), page: b.page }; fromLayer.raw = layer; }
      if (fromLayer && mmLayout && fromLayer.items.length && fromLayer.score >= 60) {
        const k = `${fromLayer.baseName || fromLayer.name}|${fromLayer.level}|${fromLayer.role}`.toLowerCase();
        if (!seen.has(k)) { seen.set(k, fromLayer); blocks.push(fromLayer); }
        continue;
      }
      if (pageNo !== b.page) {
        const page = await doc.getPage(b.page);
        const viewport = page.getViewport({ scale: DPI / 72 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d", { willReadFrequently: true }), viewport }).promise;
        pageImg = toGray(canvas);
        pageNo = b.page;
      }
      const sx = pageImg.width / b.pageWidth, sy = pageImg.height / b.pageHeight;
      const read = async (extra) => {
        let raw = crop(pageImg, b.box.x0 * sx, b.box.y0 * sy, b.box.x1 * sx, (b.box.y1 + extra) * sy);
        let bars = findBars(raw);
        const ext = bars[0] && barExtent(raw, bars[0]);
        if (ext) { raw = crop(raw, ext.x0 + 2, 0, ext.x1 - 2, raw.height); bars = findBars(raw); }
        const cv = grayToCanvas(invertBars(raw, bars));
        const { data: { text } } = await (await getWorker()).recognize(cv);
        if (onDebug) onDebug({ id: i + 1, block: b, bars: bars.length, text, image: cv.toDataURL("image/png") });
        const r = parseBlockBest(text, { vocab, hint }, fromLayer ? [fromLayer] : []);
        if (r && !r.skipped && !fromLayer) r.raw = text;
        if (!r) return { skipped: true, reason: "could not read", name: b.rawName };
        return r;
      };
      let r = await read(0);
      if (!r.skipped && r.checks.some((c) => /^ability .* missing/.test(c))) {
        const more = await read(Math.min(80, b.pageHeight - b.box.y1));
        if (!more.skipped && more.score > r.score) { r = more; r.warnings.push("block end was not found in the text layer; read further down the page"); }
      }
      if (r.skipped) { skipped.push({ name: r.name, page: b.page, reason: r.reason }); continue; }
      r.source.id = `p${b.page}-${i + 1}`;
      const k = `${r.baseName}|${r.level}|${r.role}`.toLowerCase();
      if (seen.has(k)) { const f = seen.get(k); f.source.alsoOnPages = [...(f.source.alsoOnPages || []), b.page]; continue; }
      seen.set(k, r);
      blocks.push(r);
    }
  } finally {
    if (worker) await worker.terminate();
    await doc.destroy();
  }
  return { blocks, skipped };
}
