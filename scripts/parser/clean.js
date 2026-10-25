/**
 * Text cleanup for PDF-extracted 4e stat blocks.
 * Pure functions, no Foundry or Draw Steel dependencies.
 */

const DIE_GLYPHS = { "⚀": 1, "⚁": 2, "⚂": 3, "⚃": 4, "⚄": 5, "⚅": 6 };

// Words that are known to be split by ligature loss in the MM extraction.
// Used in addition to the corpus-vocabulary check.
const KNOWN_JOINS = new Set([
  "affliction", "affect", "affects", "affected", "effect", "effects", "difficult", "reflex",
  "fly", "flies", "flying", "flight", "flyby", "petrified", "fire", "flame", "flames", "fighter",
  "fight", "fiend", "fiery", "flank", "flanking", "flanked", "flat", "fling", "first", "final",
  "find", "fill", "field", "figure", "fist", "fixed", "flow", "floor", "flurry", "flask",
  "offer", "office", "official", "offering", "different", "difficulty", "sufficient",
  "classified", "specific", "specified", "identified", "magnified", "modified",
  "justified", "notified", "ratified", "qualified", "satisfied", "terrified", "horrified",
  "fortified", "unaffected", "inflict", "inflicts", "inflicted", "conflict", "reflect",
  "reflects", "influence", "confident", "efficient", "artificial", "official"
]);

/** Build a lowercase word-frequency map from raw text (used to validate ligature joins). */
export function buildVocab(rawText) {
  const vocab = new Map();
  const words = rawText.toLowerCase().match(/[a-z]{3,}/g) || [];
  for (const w of words) vocab.set(w, (vocab.get(w) || 0) + 1);
  return vocab;
}

const LIGATURE_RE = /\b([A-Za-z]*(?:ffi|ffl|ff|fi|fl))[ \t]+([a-z]+)/g;

export function fixLigatures(line, vocab) {
  return line.replace(LIGATURE_RE, (full, a, b) => {
    // Try the whole following word, then progressively shorter prefixes ("fl y," -> "fly").
    const joined = (a + b).toLowerCase();
    if (KNOWN_JOINS.has(joined) || (vocab.get(joined) || 0) >= 1) return a + b;
    return full;
  });
}

export function normalizeLine(line, vocab) {
  let s = line
    .replace(/ /g, " ")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–−]/g, "-")
    .replace(/­/g, "")
    .replace(/[ \t]+$/g, "");
  s = fixLigatures(s, vocab);
  // Recharge dice glyphs -> digits ("recharge ⚄ ⚅" -> "recharge 5 6")
  s = s.replace(/[⚀-⚅]/g, (g) => ` ${DIE_GLYPHS[g]} `).replace(/ {2,}/g, " ");
  return s;
}

/** Split raw text into cleaned lines, repairing a few known extraction splits. */
export function cleanLines(rawText) {
  const vocab = buildVocab(rawText);
  const lines = rawText.split(/\r?\n/).map((l) => normalizeLine(l, vocab));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    // "S" / "enses Perception ..." (ghost blocks)
    if (/^\s*S\s*$/.test(cur) && next && /^\s*enses\b/.test(next)) {
      out.push("Senses" + next.trim().slice("enses".length));
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

/** True for lines that are page furniture rather than stat text. */
export function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\d{1,3}$/.test(t)) return true; // page number
  if (/^[A-Z][A-Z .,'\-]{2,40}$/.test(t) && !/^(HP|AC|XP)$/.test(t)) return true; // art credit / running head
  return false;
}
