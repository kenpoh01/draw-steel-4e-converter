/**
 * One entry point for every input the converter accepts:
 *  - JSON written by the adventure scanner (tools/scan-adventure.mjs)
 *  - pasted text in any supported layout (Monster Manual, later Monster Vault / adventure layouts)
 *
 * Every parser is tried on every block and the result that passes the most sanity checks wins,
 * so a new layout variation is flagged for review instead of silently coming out empty.
 */
import { parseCorpus } from "./parse4e.js";
import { parseMVBlock, parseMVCorpus, validateMV } from "./parseMV.js";

const key = (b) => `${(b.baseName || b.name).replace(/^\d+\s+/, "").replace(/s$/i, "")}|${b.level}`.toLowerCase();

/** How trustworthy a parsed block looks (0-100) and the problems found. Also sets block.checks. */
export function scoreBlock(b) {
  let checks = [];
  try { checks = validateMV(b); } catch { checks = ["block could not be checked"]; }
  if (!b.items?.length) checks = [...checks, "no powers or traits were found"];
  if (!b.stats?.speed || (b.stats.speed.walk == null && !(b.stats.speed.modes || []).length)) checks = [...checks, "speed missing"];
  b.checks = checks;
  // six missing ability scores are one problem, not six
  const counted = checks.filter((c) => !/^ability \w+ missing/.test(c)).length + (checks.some((c) => /^ability \w+ missing/.test(c)) ? 1 : 0);
  let s = 100 - 8 * counted - Math.min(10, (b.warnings || []).length);
  if (!b.items?.length) s -= 40;
  if (b.stats?.hp == null || b.stats?.ac == null) s -= 30;
  return Math.max(0, s);
}

const layoutOf = (b, fallback) => (b.source = { ...(b.source || {}), layout: b.source?.layout || fallback }, b);

/** Run every parser over the text of ONE block. Returns the best block, or null. */
export function parseBlockBest(text, ctx = {}, extra = []) {
  const cands = [];
  const tryIt = (fn, layout) => {
    try { for (const b of [].concat(fn() || [])) if (b && !b.skipped && b.name) cands.push(layoutOf(b, layout)); } catch { /* parser does not fit this text */ }
  };
  let trap = null;
  try { const r = parseMVBlock(text, ctx); if (r?.skipped && /trap|hazard/.test(r.reason)) trap = r; } catch { /* handled below */ }
  if (trap) return trap;
  tryIt(() => parseMVBlock(text, ctx), "later-4e");
  tryIt(() => parseCorpus(text).slice(0, 1), "monster-manual");
  const extras = new Set(extra);
  cands.push(...extra);
  let best = null, bestScore = -1;
  for (const b of cands) {
    b.raw = b.raw || text;
    // a candidate handed in from the PDF text layer must beat the page-image reading clearly: that layer can be OCR output itself
    const s = scoreBlock(b) - (extras.has(b) ? 6 : 0);
    if (s > bestScore) { best = b; bestScore = s; }
  }
  if (best) best.score = scoreBlock(best);
  return best;
}

export function parseAny(input, ctx = {}) {
  const text = String(input ?? "").trim();
  if (!text) return [];
  if (/^[\[{]/.test(text)) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.blocks ?? [data];
      list.forEach((b) => { if (b?.stats) scoreBlock(b); });
      return list;
    } catch { /* not JSON, fall through to text */ }
  }
  const best = new Map();
  const add = (b, layout) => {
    layoutOf(b, layout);
    b.score = scoreBlock(b);
    const k = key(b);
    if (!best.has(k) || best.get(k).score < b.score) best.set(k, b);
  };
  for (const b of parseMVCorpus(text, ctx)) add(b, "later-4e");
  let old = [];
  try { old = parseCorpus(text); } catch { /* layout not present */ }
  for (const b of old) add(b, "monster-manual");
  return [...best.values()];
}
