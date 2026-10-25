/**
 * Page image helpers: crop a stat block out of a rendered page and turn its dark header and
 * section bars (white text on black/gray) into black-on-white text so OCR can read them.
 */

export function crop(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.width, Math.ceil(x1)); y1 = Math.min(img.height, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(img.gray.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x0 + w), y * w);
  return { width: w, height: h, gray: out };
}

/** Otsu threshold of a grayscale region. */
function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/**
 * Find horizontal dark bars: runs of rows that are mostly dark across the crop width.
 * @returns [{y0, y1}] in crop pixels
 */
export function findBars(img, { meanMax = 130, darkLevel = 115, darkMin = 0.5, gapRows = 6, minRows = 14 } = {}) {
  const { width: w, height: h, gray } = img;
  const isBar = new Array(h).fill(false);
  for (let y = 0; y < h; y++) {
    let sum = 0, dark = 0, n = 0;
    for (let x = 0; x < w; x += 2) { const v = gray[y * w + x]; sum += v; if (v < darkLevel) dark++; n++; }
    isBar[y] = sum / n < meanMax && dark / n >= darkMin;
  }
  const bars = [];
  let start = -1, last = -1;
  for (let y = 0; y < h; y++) {
    if (isBar[y]) { if (start < 0) start = y; last = y; }
    else if (start >= 0 && y - last > gapRows) { if (last - start + 1 >= minRows) bars.push({ y0: start, y1: last }); start = -1; }
  }
  if (start >= 0 && last - start + 1 >= minRows) bars.push({ y0: start, y1: last });
  return bars;
}

/** Horizontal extent of the first (header) bar: where its columns are mostly dark. */
export function barExtent(img, bar, darkLevel = 115) {
  let x0 = -1, x1 = -1;
  for (let x = 0; x < img.width; x++) {
    let dark = 0, n = 0;
    for (let y = bar.y0; y <= bar.y1; y += 2) { if (img.gray[y * img.width + x] < darkLevel) dark++; n++; }
    if (dark / n > 0.25) { if (x0 < 0) x0 = x; x1 = x; }
  }
  return x0 < 0 ? null : { x0, x1 };
}

/** Return a copy with each bar converted to dark text on a white background. */
export function invertBars(img, bars, pad = 3) {
  const { width: w, height: h } = img;
  const out = new Uint8Array(img.gray);
  for (const bar of bars) {
    const y0 = Math.max(0, bar.y0 - pad), y1 = Math.min(h - 1, bar.y1 + pad);
    const vals = [];
    for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) vals.push(img.gray[y * w + x]);
    const t = otsu(vals);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) out[y * w + x] = img.gray[y * w + x] > t ? 0 : 255;
  }
  return { width: w, height: h, gray: out };
}
