/**
 * Rebuilds reading-order text lines from positioned words.
 *
 * Works on any source of words with coordinates:
 *   - `pdftotext -bbox-layout` output (parseBboxHtml)
 *   - Tesseract TSV output (parseTesseractTsv)
 *   - pdf.js text items (build the same { text, x0, y0, x1, y1 } objects)
 *
 * Why: the OCR text layer of a scanned adventure is stored in zones that are not in reading order
 * (a stat block's header band, body and ability scores can be separated by pages of prose), so
 * plain text extraction scrambles them. Positions put them back: each column is read top to bottom
 * and words sharing a row are joined, with a tab marking a wide gap (the right-aligned
 * "Level 5 Skirmisher" next to the name, "Initiative +7" next to HP, and so on).
 */

const num = (s) => Number.parseFloat(s);

export function parseBboxHtml(html) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let pm;
  while ((pm = pageRe.exec(html))) {
    const words = [];
    let wm;
    while ((wm = wordRe.exec(pm[3]))) {
      words.push({ x0: num(wm[1]), y0: num(wm[2]), x1: num(wm[3]), y1: num(wm[4]), text: decodeEntities(wm[5]) });
    }
    pages.push({ width: num(pm[1]), height: num(pm[2]), words });
  }
  return pages;
}

export function parseTesseractTsv(tsv, width, height) {
  const words = [];
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = c.slice(11).join("\t").trim();
    if (!text) continue;
    const x0 = num(c[6]), y0 = num(c[7]);
    words.push({ x0, y0, x1: x0 + num(c[8]), y1: y0 + num(c[9]), text, conf: num(c[10]) });
  }
  return { width, height, words };
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Finds the vertical gutter between two text columns; returns its centre x, or null for a single-column page. */
export function findGutter(page, minWidth = 9) {
  const W = Math.ceil(page.width);
  const cover = new Uint16Array(W + 2);
  for (const w of page.words) for (let x = Math.max(0, Math.floor(w.x0)); x <= Math.min(W, Math.ceil(w.x1)); x++) cover[x]++;
  // tolerate a few stray words (OCR noise / words that run into the gutter) in the bin count
  const noise = Math.max(2, Math.round(page.words.length * 0.004));
  let best = null, runStart = null;
  const lo = Math.floor(W * 0.3), hi = Math.ceil(W * 0.7);
  for (let x = lo; x <= hi + 1; x++) {
    const empty = x <= hi && cover[x] <= noise;
    if (empty && runStart === null) runStart = x;
    if (!empty && runStart !== null) {
      const width = x - runStart;
      if (width >= minWidth && (!best || width > best.width)) best = { width, centre: (runStart + x) / 2 };
      runStart = null;
    }
  }
  return best ? best.centre : null;
}

/**
 * @param page   { width, height, words }
 * @param opts   { columns: number (default 2), rowTolerance: fraction of word height, cellGap: fraction of word height }
 * @returns lines in reading order: [{ text, cells[], x0, x1, y0, y1, col }]
 */
export function layoutLines(page, opts = {}) {
  const gutter = opts.gutter === undefined ? findGutter(page) : opts.gutter;
  const columns = gutter == null ? 1 : 2;
  const rowTol = opts.rowTolerance ?? 0.55;
  const cellGapFactor = opts.cellGap ?? 1.9;
  const heights = page.words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 8;

  const colOf = (w) => (columns === 1 ? 0 : (w.x0 + w.x1) / 2 < gutter ? 0 : 1);
  const byCol = Array.from({ length: columns }, () => []);
  for (const w of page.words) byCol[colOf(w)].push(w);

  const lines = [];
  byCol.forEach((words, col) => {
    words.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const rows = [];
    for (const w of words) {
      const yc = (w.y0 + w.y1) / 2;
      const row = rows[rows.length - 1];
      if (row && Math.abs(yc - row.yc) <= medianH * rowTol) {
        row.words.push(w);
        row.yc = row.words.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / row.words.length;
      } else rows.push({ yc, words: [w] });
    }
    for (const row of rows) {
      row.words.sort((a, b) => a.x0 - b.x0);
      const cells = [];
      let cur = [row.words[0]];
      for (let i = 1; i < row.words.length; i++) {
        const gap = row.words[i].x0 - row.words[i - 1].x1;
        if (gap > medianH * cellGapFactor) { cells.push(cur); cur = []; }
        cur.push(row.words[i]);
      }
      cells.push(cur);
      const cellText = cells.map((c) => c.map((w) => w.text).join(" "));
      lines.push({
        text: cellText.join("\t"),
        cells: cellText,
        x0: row.words[0].x0,
        x1: row.words[row.words.length - 1].x1,
        y0: Math.min(...row.words.map((w) => w.y0)),
        y1: Math.max(...row.words.map((w) => w.y1)),
        col
      });
    }
  });
  return lines;
}
