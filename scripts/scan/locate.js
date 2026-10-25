/** Finds 4e stat blocks on pages of positioned text lines (shared by the command-line scanner and the module). */

/* ----------------------------- header detection ----------------------------- */

const ROLE_WORDS = ["artillery", "brute", "controller", "lurker", "skirmisher", "soldier", "blaster", "obstacle", "warder", "companion"];
// the OCR confuses these characters inside numbers
const DIGIT_FIX = { S: "5", s: "5", O: "0", o: "0", I: "1", l: "1", i: "1", B: "8", Z: "2" };

const fixDigits = (s) => s.replace(/[SsOoIliBZ]/g, (c) => DIGIT_FIX[c] ?? c);
const letters = (s) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Fuzzy "Level N <role>" matcher over a line of text. Returns null if the line is not a stat block header. */
export function matchHeader(text) {
  if (/encounter/i.test(text)) return null;
  const m = /^(.*?)\s*\bLev[eo][l1I]\s*([0-9SsOoIlB]{1,2})\s+(.+)$/.exec(text);
  if (!m) return null;
  const level = Number(fixDigits(m[2]));
  if (!Number.isInteger(level) || level < 1 || level > 40) return null;
  const roleText = letters(m[3]);
  const role = ROLE_WORDS.find((r) => roleText.includes(r));
  // minions in the Monster Manual print no role: "Level 1 Minion"
  if (!role && !/minion/.test(roleText)) return null;
  const organization = /minion/.test(roleText) ? "minion" : /elite/.test(roleText) ? "elite" : /solo/.test(roleText) ? "solo" : "standard";
  const leader = /leader/.test(roleText);
  return { rawName: m[1].trim(), level, role: role ?? null, organization, leader };
}

const ALIGN_RE = /^(?:align\w*|aligment)\b/i;
const LANG_RE = /\blanguages?\b/i;

/**
 * Find stat blocks on every page.
 * @returns [{ page, header, name rawName, level, role, organization, leader, box:{x0,y0,x1,y1}, endFound }]
 */
export function locateBlocks(pages) {
  const found = [];
  for (const page of pages) {
    const heads = [];
    for (const line of page.lines) {
      const h = matchHeader(line.text);
      if (h) heads.push({ ...h, line });
    }
    // a header whose name sits on a separate line to the left: take words on the same baseline
    for (const h of heads) {
      if (h.rawName) continue;
      const mid = (h.line.y0 + h.line.y1) / 2;
      const left = page.lines.filter((l) => l !== h.line && Math.abs((l.y0 + l.y1) / 2 - mid) < 6 && l.x1 <= h.line.x0 + 4).sort((a, b) => b.x1 - a.x1)[0];
      if (left) {
        h.rawName = left.text;
        h.line = { ...h.line, x0: Math.min(h.line.x0, left.x0) };
      }
    }
    for (const h of heads) {
      const x0 = h.line.x0 - 8;
      const x1 = h.line.x1 + 8;
      const y0 = h.line.y0 - 4;
      // block end: first "Alignment ... Languages" line below the header that sits in the same column
      const sameColumn = (l) => l.x0 < x1 - 40 && l.x1 > x0 + 40;
      const below = page.lines.filter((l) => l.y0 >= h.line.y1 - 1 && sameColumn(l)).sort((a, b) => a.y0 - b.y0);
      const nextHead = heads.filter((o) => o !== h && o.line.y0 > h.line.y1 + 10 && o.line.x0 < x1 - 40 && o.line.x1 > x0 + 40).sort((a, b) => a.line.y0 - b.line.y0)[0];
      const limit = nextHead ? nextHead.line.y0 - 2 : page.height;
      let endLine = null;
      for (const l of below) {
        if (l.y0 >= limit) break;
        if (ALIGN_RE.test(l.text) || (LANG_RE.test(l.text) && /align/i.test(l.text))) { endLine = l; break; }
      }
      let y1 = endLine ? endLine.y1 + 3 : Math.min(limit, y0 + 420);
      // an Equipment line sometimes follows Alignment/Languages
      if (endLine) {
        const eq = below.find((l) => l.y0 > endLine.y0 && l.y0 < endLine.y1 + 14 && /^equip/i.test(l.text));
        if (eq) y1 = eq.y1 + 3;
      }
      found.push({
        page: page.n,
        pageWidth: page.width,
        pageHeight: page.height,
        rawName: h.rawName,
        level: h.level,
        role: h.role,
        organization: h.organization,
        leader: h.leader,
        box: { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(page.width, x1), y1: Math.min(page.height, y1) },
        endFound: !!endLine
      });
    }
  }
  return found;
}
