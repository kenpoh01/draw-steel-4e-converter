/**
 * Parser for the later 4e stat block layout (Monster Vault / Dungeon / Essentials era):
 *
 *   5 Giant Archerfish                      Level 4 Artillery
 *   Small natural beast (aquatic)                XP 175 each
 *   HP 45; Bloodied 22                            Initiative +6
 *   AC 18, Fortitude 16, Reflex 18, Will 14     Perception +7
 *   Speed 1 (clumsy), swim 6                  Low-light vision
 *   STANDARD ACTIONS
 *   Bite ✦ At-Will
 *     Attack: Melee 1 (one creature); +9 vs. AC
 *     Hit: 2d8 + 2 damage.
 *   Str 10 (+2) Dex 19 (+6) Wis 11 (+2) ...
 *
 * Input is the text of one block, usually re-read from the page image by OCR, so every step
 * tolerates misread characters. Output has the same shape as parse4e.js, so the converter
 * does not care which layout a monster came from.
 */
import { parseAC, parseDefenseMods, parseSpeed, parseAbilities, parseSenses, parseBody } from "./parse4e.js";

const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));

/* ------------------------------ small helpers ------------------------------ */

const DIGIT_FIX = { S: "5", s: "5", O: "0", o: "0", I: "1", l: "1", i: "1", B: "8", Z: "2", "&": "8" };
export const fixDigits = (s) => s.replace(/[SsOoIliBZ&]/g, (c) => DIGIT_FIX[c] ?? c);
const lettersOnly = (s) => s.toLowerCase().replace(/[^a-z]/g, "");

const ROLE_WORDS = ["artillery", "brute", "controller", "lurker", "skirmisher", "soldier", "blaster", "obstacle", "warder", "companion"];
export const TRAP_ROLES = new Set(["blaster", "obstacle", "warder"]);

/** Fuzzy "Name   Level N [Elite|Solo|Minion] Role [(Leader)]" matcher. null if the line is not a header. */
export function matchHeader(text) {
  if (/encounter/i.test(text)) return null;
  const m = /^(.*?)\s*\bLev[eo][l1I]\s*([0-9SsOoIlB&]{1,2})\s+(.+)$/.exec(text);
  if (!m) return null;
  const level = Number(fixDigits(m[2]));
  if (!Number.isInteger(level) || level < 1 || level > 40) return null;
  const roleText = lettersOnly(m[3]);
  const role = ROLE_WORDS.find((r) => roleText.includes(r));
  // minions in the Monster Manual print no role: "Level 1 Minion"
  if (!role && !/minion/.test(roleText)) return null;
  const organization = /minion/.test(roleText) ? "minion" : /elite/.test(roleText) ? "elite" : /solo/.test(roleText) ? "solo" : "standard";
  return { rawName: m[1].trim(), level, role: role ?? null, organization, leader: /leader/.test(roleText) };
}

/** "5 Giant Archerfish (G)" -> { name: "Giant Archerfish", count: 5, label: "G" } */
export function cleanName(raw) {
  let s = (raw || "").replace(/^[^A-Za-z0-9]+/, "").replace(/[\s|,.:;]+$/, "").replace(/\s{2,}/g, " ");
  let count = null;
  const c = /^(\d{1,2})\s+(.*)$/.exec(s);
  if (c) { count = Number(c[1]); s = c[2]; }
  let label = null;
  const l = /\s*\(([A-Za-z0-9])\)\s*$/.exec(s);
  if (l) { label = l[1]; s = s.slice(0, l.index); }
  return { name: s.trim(), count, label };
}

const PLURAL_EXCEPT = new Set(["fish", "sheep", "deer", "series", "species", "moose"]);
/** Header names use the plural when the encounter has several (2 Hippogriffs); statted creature is singular. */
export function singularize(name) {
  const words = name.split(" ");
  let w = words[words.length - 1];
  const lw = w.toLowerCase();
  if (PLURAL_EXCEPT.has(lw) || /(ss|us|is|ous)$/i.test(w) || !/s$/i.test(w)) return name;
  if (/ves$/i.test(w)) w = /(wol|el|dwar|thie|hal|cal|lea)ves$/i.test(w) ? w.replace(/ves$/i, "f") : w.replace(/s$/i, "");
  else if (/ies$/i.test(w) && !/(zombies|goblinoids)$/i.test(w) && !/(ie)s$/i.test(w.slice(-4, -1) + "s")) w = w.replace(/ies$/i, "y");
  else if (/(x|ch|sh|zz)es$/i.test(w)) w = w.replace(/es$/i, "");
  else if (/men$/i.test(w)) return name;
  else w = w.replace(/s$/i, "");
  words[words.length - 1] = w;
  return words.join(" ");
}

/** How "real" a name looks, judged by how often its words occur in the rest of the document. */
function nameScore(name, vocab) {
  if (!vocab) return 0;
  const parts = name.toLowerCase().match(/[a-z]+/g) || [];
  let score = 0;
  for (const p of parts) {
    const f = Math.max(vocab.get(p) || 0, vocab.get(p.replace(/s$/, "")) || 0, vocab.get(p + "s") || 0);
    score += f > 0 ? Math.log(1 + f) : -3;
  }
  return score;
}

export function pickName(ocrRaw, hintRaw, vocab) {
  const a = cleanName(ocrRaw), b = cleanName(hintRaw);
  if (!a.name) return { ...b, source: "text layer" };
  if (!b.name) return { ...a, source: "ocr" };
  if (a.name.toLowerCase() === b.name.toLowerCase()) return { ...a, count: a.count ?? b.count, source: "both" };
  const sa = nameScore(singularize(a.name), vocab) + nameScore(a.name, vocab);
  const sb = nameScore(singularize(b.name), vocab) + nameScore(b.name, vocab);
  return sb > sa + 0.5 ? { ...b, count: b.count ?? a.count, source: "text layer" } : { ...a, count: a.count ?? b.count, source: "ocr" };
}

/* ------------------------------ OCR repairs ------------------------------ */

/** Fix dice that the OCR read with the "d" as a 4 or the 8 as a B. Returns [text, repairs[]]. */
export function fixDice(text) {
  const repairs = [];
  let t = text.replace(/\b(\d)d([0-9B]{1,2})\b/g, (m, n, d) => {
    const fixed = `${n}d${d.replace(/B/g, "8")}`;
    if (fixed !== m) repairs.push(`${m} -> ${fixed}`);
    return fixed;
  });
  t = t.replace(/\bl(d\d{1,2})\b/g, (m, d) => { repairs.push(`${m} -> 1${d}`); return "1" + d; });
  // "2410 + 3 damage" is 2d10 + 3 damage, "248" is 2d8
  t = t.replace(/\b([1-9])4(4|6|8|10|12|20)\b(?=\s*(?:[+-]\s*\d+\s*)?(?:[a-z]+\s+){0,3}damage)/gi, (m, n, d) => {
    repairs.push(`${m} -> ${n}d${d}`);
    return `${n}d${d}`;
  });
  return [t, repairs];
}

function cleanLine(l) {
  return l
    .replace(/\u00ad/g, "")
    .replace(/^(AC)\s*([0-9SsOoIlB]{1,2})\b/, (m, a, d) => `${a} ${fixDigits(d)}`)
    .replace(/\bW[lI1]s(?=\s*\d)/g, "Wis ")
    .replace(/(\bvs\.?\s*(?:AC|Fortitude|Reflex|Will))\s+\S{1,3}:?$/i, "$1")
    .replace(/([.!])\s+[a-z@©®]{1,2}$/, "$1")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/^[|\[\]\s]+/, "")
    .replace(/\s+[|\]]$/, "")
    .trim();
}

/* ------------------------------ section bars ------------------------------ */

/** "Stanparo ACTIONS", "TriGceren Actions", "Tra Its" ... -> section key or null */
export function sectionOf(line) {
  const words = line.replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const joined = lettersOnly(words.slice(0, 2).join(""));
  if (/actions?$/.test(joined) && words.length >= 2 && words[0].length >= 3) {
    const w = words[0].toLowerCase();
    if (w.startsWith("s")) return "standard";
    if (w.startsWith("mo")) return "move";
    if (w.startsWith("mi")) return "minor";
    if (w.startsWith("f")) return "free";
    if (w.startsWith("t")) return "triggered";
    return null;
  }
  if (words.length === 1 && /^tr[a-z]{2,5}$/i.test(words[0]) && /^tra/i.test(words[0])) return "traits";
  return null;
}

/* ------------------------------ lines inside the stat area ------------------------------ */

const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const ORIGINS = ["natural", "shadow", "fey", "elemental", "immortal", "aberrant"];

function parseSubheader(line) {
  const words = line.split(/\s+/);
  const w0 = words[0].toLowerCase().replace(/[^a-z]/g, "");
  const size = SIZES.find((s) => s.startsWith(w0.slice(0, 3)) && w0.length >= 3);
  if (!size) return null;
  let rest = line.slice(line.indexOf(words[0]) + words[0].length).trim();
  let xp = null, xpRaw = null;
  const xm = /\bXP\s*([\d,]+|n\/a|-)?(?:\s*each)?\s*$/i.exec(rest);
  if (xm) { xpRaw = xm[0].trim(); xp = /\d/.test(xm[1] || "") ? num(xm[1]) : null; rest = rest.slice(0, xm.index).trim(); }
  rest = rest.replace(/\bnatura[l!|1]\b/gi, "natural").replace(/\s{2,}/g, " ");
  let keywords = [];
  const kw = /\(([^)]*)\)/.exec(rest);
  if (kw) { keywords = kw[1].split(/,\s*/).map((s) => s.trim().toLowerCase()).filter(Boolean); rest = rest.replace(kw[0], "").trim(); }
  const comma = rest.split(/,\s*/);
  const base = comma.shift();
  keywords.push(...comma.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const bw = base.toLowerCase().split(/\s+/).filter(Boolean);
  const origin = bw.length > 1 && ORIGINS.includes(bw[0]) ? bw.shift() : null;
  return { size, origin, type: bw.join(" "), typeKeywords: keywords, xp, xpRaw };
}

const SENSE_RE = /\b(low-?light vision|darkvision|blindsight(?:\s*\d+)?|tremorsense(?:\s*\d+)?|truesight(?:\s*\d+)?)\b.*$/i;

function takeInitiative(line) {
  const m = /\bInitiative\s*([+-]?\s*\d+)/i.exec(line);
  return m ? { value: num(m[1].replace(/\s+/g, "")), rest: (line.slice(0, m.index) + " " + line.slice(m.index + m[0].length)).trim() } : { value: null, rest: line };
}
function takePerception(line) {
  const m = /\bPerception\s*([+-]?\s*\d+)/i.exec(line);
  return m ? { value: num(m[1].replace(/\s+/g, "")), rest: (line.slice(0, m.index) + " " + line.slice(m.index + m[0].length)).trim() } : { value: null, rest: line };
}

/* ------------------------------ powers and traits ------------------------------ */

const SEP = "[+#¢♦✦◆•*@©®&~«»_\\-—–\\s]";
const USAGE_TAIL_RE = new RegExp(`(?:^|${SEP}+)(A[tc][- ]?W[il1]{2,4}(?:\\s*\\(\\d+\\/round\\))?|Encounter|Daily|Recharge\\b.*?)[\\s.…]*$`, "i");
const AURA_TAIL_RE = new RegExp(`${SEP}*\\bAura\\s*(\\d+)\\s*$`, "i");
const BODY_LABEL_RE = /^(Attack|Hit|Miss|Effect|Requirement|Trigger|Special|Aftereffect|Sustain|Secondary|Primary|First Failed Save|Second Failed Save)\b[^:]{0,40}:/i;

/** Drop the action-icon junk the OCR puts in front of a name: "@® Warhammer", "36 Phantom ...", ">y Barbed Net". */
function stripIconJunk(head) {
  const tokens = head.split(/\s+/);
  while (tokens.length > 1 && (!/[A-Z]/.test(tokens[0]) || tokens[0].length <= 1 || (/^[A-Z]{2}$/.test(tokens[0]) && /^[A-Z][a-z]/.test(tokens[1])))) tokens.shift();
  if (tokens.length) tokens[0] = tokens[0].replace(/^[^A-Za-z]+/, "");
  return tokens.join(" ").trim();
}

const SMALL_WORDS = new Set(["of", "the", "and", "to", "in", "a", "an", "on", "for", "from", "with", "by", "at", "or", "as"]);
function looksLikeTitle(s) {
  const words = s.replace(/\([^)]*\)/g, " ").replace(/[+\d]+/g, " ").split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && !SMALL_WORDS.has(w.toLowerCase()));
  if (!words.length || words.length > 7) return false;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  return caps / words.length >= 0.66;
}

function parsePowerHeader(line) {
  if (BODY_LABEL_RE.test(line)) return null;
  const m = USAGE_TAIL_RE.exec(line);
  if (!m || m.index === 0 && line.length === m[0].length) return null;
  const headRaw = line.slice(0, m.index).replace(new RegExp(`${SEP}+$`), "");
  const head = stripIconJunk(headRaw);
  if (!head || head.length > 60 || /[.!?;:]$/.test(head) || !/^[A-Z]/.test(head)) return null;
  let name = head, keywords = [];
  const kw = /\s*\(([^)]*)\)\s*$/.exec(head);
  if (kw) { keywords = kw[1].split(/,\s*/).map((s) => s.trim().toLowerCase()).filter(Boolean); name = head.slice(0, kw.index).trim(); }
  return { name, keywords, usageText: m[1].trim() };
}

function parseTraitHeader(line, canStart) {
  if (!canStart || BODY_LABEL_RE.test(line)) return null;
  const aura = AURA_TAIL_RE.exec(line);
  let head = aura ? line.slice(0, aura.index) : line;
  head = stripIconJunk(head.replace(new RegExp(`${SEP}+$`), ""));
  if (!head || head.length > 55 || /[.!?;:,]$/.test(head) || !/^[A-Z]/.test(head)) return null;
  if (!aura && !looksLikeTitle(head)) return null;
  let name = head, keywords = [];
  const kw = /\s*\(([^)]*)\)\s*$/.exec(head);
  if (kw) { keywords = kw[1].split(/,\s*/).map((s) => s.trim().toLowerCase()).filter(Boolean); name = head.slice(0, kw.index).trim(); }
  return { name, keywords, auraSize: aura ? num(aura[1]) : null };
}

function parseUsageText(usageText, section, bodyText, warnings, name) {
  const usage = { raw: usageText, action: null, trigger: null, frequency: null, recharge: null, sustain: null, perRound: null, notes: [] };
  let m;
  if (/^a[tc][- ]?w[il1]{2,4}/i.test(usageText)) {
    usage.frequency = "at-will";
    if ((m = /\((\d+)\/round\)/.exec(usageText))) usage.perRound = num(m[1]);
  } else if (/^encounter/i.test(usageText)) usage.frequency = "encounter";
  else if (/^daily/i.test(usageText)) usage.frequency = "daily";
  else if (/^recharge/i.test(usageText)) {
    usage.frequency = "recharge";
    const rest = usageText.replace(/^recharge\s*/i, "");
    const whenIdx = rest.search(/\bwhen\b/i);
    const dice = (whenIdx >= 0 ? rest.slice(0, whenIdx) : rest).replace(/[,;]?\s*(and)?\s*$/i, "").trim();
    const digits = (dice.match(/[1-6]/g) || []).map(Number);
    let faces = null;
    if (digits.length && /^[\d\s,\-–]+$/.test(dice)) faces = [...new Set(digits)];
    else if (dice) {
      const tokens = dice.split(/\s+/).filter(Boolean);
      const n = Math.min(4, tokens.length);
      faces = Array.from({ length: n }, (_, i) => 6 - n + 1 + i);
      warnings.push(`${name}: recharge dice not readable; ${n} icon${n === 1 ? "" : "s"} counted, guessed ${faces.join("-")}`);
    }
    usage.recharge = faces ? { faces } : null;
    if (whenIdx >= 0) { usage.recharge = { ...(usage.recharge || {}), when: rest.slice(whenIdx).trim() }; if (!faces) delete usage.recharge.faces; }
  }
  // action type: section, overridden by "Attack (Immediate Reaction):"-style labels
  const typed = /\b(?:Attack|Effect|Hit)\s*\((Immediate Reaction|Immediate Interrupt|Opportunity Action|Free Action|Minor Action|Move Action|Standard Action)\)\s*:/i.exec(bodyText);
  const typeMap = { "immediate reaction": "immediate reaction", "immediate interrupt": "immediate interrupt", "opportunity action": "opportunity", "free action": "free", "minor action": "minor", "move action": "move", "standard action": "standard" };
  if (typed) usage.action = typeMap[typed[1].toLowerCase()];
  else if (section === "standard") usage.action = "standard";
  else if (section === "move") usage.action = "move";
  else if (section === "minor") usage.action = "minor";
  else if (section === "free") usage.action = "free";
  else if (section === "triggered") { usage.action = "immediate reaction"; warnings.push(`${name}: triggered action type not stated; immediate reaction assumed`); }
  const trig = /\bTrigger:\s*(.*?)(?=\s(?:Attack|Effect|Hit|Miss|Requirement|Special)\b[^:]{0,40}:|$)/i.exec(bodyText);
  if (trig) usage.trigger = trig[1].trim().replace(/\.$/, "");
  const sus = /\bSustain\s+(Minor|Standard|Move|Free)\b/i.exec(bodyText);
  if (sus) usage.sustain = sus[1].toLowerCase();
  return usage;
}

function rangeIcon(body) {
  const k = body.range?.kind;
  if (!k) return null;
  if (k === "melee" || k === "reach" || k === "melee touch") return "M";
  if (k === "ranged") return "R";
  if (k.startsWith("close")) return "C";
  if (k.startsWith("area")) return "A";
  return null;
}

/* ------------------------------ the block parser ------------------------------ */

/**
 * @param text  OCR (or pasted) text of one block, starting at the header bar
 * @param ctx   { hint: {rawName, level, role, organization, leader, page}, vocab, altText }
 * @returns block | { skipped: true, reason, name }
 */
export function parseMVBlock(text, ctx = {}) {
  const warnings = [];
  let [fixedText, repairs] = fixDice(text);
  if (repairs.length) warnings.push(`repaired dice: ${repairs.join(", ")}`);
  let lines = fixedText.split(/\r?\n/).map(cleanLine).filter((l) => l.length && !/^[A-Za-z]{1,3}$/.test(l));

  /* header */
  let headIdx = lines.findIndex((l) => matchHeader(l));
  const hint = ctx.hint || {};
  let header = headIdx >= 0 ? matchHeader(lines[headIdx]) : null;
  if (!header && hint.level) header = { rawName: "", level: hint.level, role: hint.role, organization: hint.organization, leader: !!hint.leader };
  if (!header) return { skipped: true, reason: "no header line found", name: hint.rawName || "(unknown)" };
  if (headIdx >= 0) lines = lines.slice(headIdx + 1);
  if (hint.level && header.level !== hint.level) warnings.push(`level read as ${header.level} from the page but ${hint.level} from the text layer`);
  const nm = pickName(header.rawName, hint.rawName, ctx.vocab);
  let name = nm.name;
  if (nm.count != null) { const s = singularize(name); if (s !== name) { warnings.push(`name singularized from "${name}"`); name = s; } }
  if (nm.source !== "both" && header.rawName && hint.rawName) warnings.push(`name differs between page read ("${cleanName(header.rawName).name}") and text layer ("${cleanName(hint.rawName).name}"); used the ${nm.source} version`);

  /* traps and hazards are not monsters */
  const early = lines.slice(0, 6).join(" ");
  if (TRAP_ROLES.has(header.role) || /^(h[a-z]{3,5}d|trap)\s+XP\b/i.test(lines[0] || "") || /^(hazard|trap)\b/i.test(lines[0] || "") || /\b(Hazard|Trap)\s+XP\b/i.test(early) || /\b(hazard|trap)\s*:|\b(hazard|trap) cannot be (detected|noticed)/i.test(lines.slice(0, 12).join(" "))) return { skipped: true, reason: "trap or hazard", name };

  const block = {
    name,
    baseName: name,
    nameQualifier: null,
    level: header.level,
    organization: header.organization,
    role: header.role === "companion" ? "companion" : header.role,
    leader: header.leader,
    encounterCount: nm.count,
    mapLabel: nm.label,
    source: { layout: "later-4e", page: hint.page ?? null }
  };

  const stat = {};
  let i = 0;
  if (lines[0]) {
    const sub = parseSubheader(lines[0]);
    if (sub) { Object.assign(block, sub); i = 1; } else warnings.push("size/type line not recognised: " + lines[0].slice(0, 50));
  }

  /* stat lines until the first section bar or power */
  const items = [];
  let section = "none";
  let current = null;
  let canStartTrait = true;
  let bareSections = false;
  let footer = false;
  const abilityRows = [];
  const fieldLines = {};

  for (; i < lines.length; i++) {
    const line = lines[i];

    if (!footer) {
      /* footer begins at Skills / ability rows / Alignment */
      if (/^Skills\b/i.test(line) || /^(Str|Dex|Con|Int|Wis|Cha|Wls)\s*\d/i.test(line) || /^Align\w*\b/i.test(line)) footer = true;
    }
    if (footer) {
      if (/^Skills\b/i.test(line)) fieldLines.skills = line.replace(/^Skills\s*/i, "");
      else if (/^(Str|Dex|Con|Int|Wis|Cha|Wls)\s*\d/i.test(line)) abilityRows.push(line.replace(/\bWls\b/g, "Wis").replace(/\bWl5\b/g, "Wis").replace(/\(4(\d)\)/g, "(+$1)"));
      else if (/^Align\w*\b/i.test(line)) fieldLines.alignment = line;
      else if (/^Equip\w*\b/i.test(line)) fieldLines.equipment = line.replace(/^Equip\w*\s*/i, "");
      else if (fieldLines.equipment && !/^[A-Z][a-z]+\s+\d/.test(line) && lines.indexOf(line) === i && /^[a-z]/.test(line)) fieldLines.equipment += " " + line;
      else if (fieldLines.alignment && /^[A-Z][a-z]+$/.test(line) === false && /Languages/i.test(fieldLines.alignment) === false) fieldLines.alignment += " " + line;
      continue;
    }

    /* the stat lines */
    if (/^HP\b/i.test(line)) { const ini = takeInitiative(line); fieldLines.hp = ini.rest; if (ini.value != null) stat.initiative = ini.value; current = null; continue; }
    if (/^AC\b|^A[C(]\s*\d/i.test(line)) { const per = takePerception(line); fieldLines.ac = per.rest.replace(/^A\(/, "AC "); if (per.value != null) stat.perception = per.value; current = null; continue; }
    if (/^Speed\b/i.test(line)) {
      const s = SENSE_RE.exec(line);
      fieldLines.speed = (s ? line.slice(0, s.index) : line).trim();
      if (s) fieldLines.sensesText = s[0];
      current = null;
      continue;
    }
    if (/^(Immune|Resist|Vulnerable)\b/i.test(line)) { fieldLines.defense = (fieldLines.defense ? fieldLines.defense + "; " : "") + line; current = null; continue; }
    if (/^Saving Throws?\b|^Action Points?\b/i.test(line)) { fieldLines.misc = (fieldLines.misc ? fieldLines.misc + "; " : "") + line; current = null; continue; }
    if (/^Initiative\b/i.test(line)) { const ini = takeInitiative(line); if (ini.value != null) stat.initiative = ini.value; continue; }

    /* section bars */
    const sec = sectionOf(line);
    if (sec) { section = sec; current = null; canStartTrait = true; continue; }

    if (section === "none") {
      // stray line between the stat lines and the first section (e.g. a wrapped stat line)
      if (fieldLines.speed && /^[a-z(]/.test(line)) { fieldLines.speed += " " + line; continue; }
      // the section bars are white-on-black and often missing from a text layer: recognise the first power or trait by its header
      if (parsePowerHeader(line)) { section = "standard"; if (!bareSections) { bareSections = true; warnings.push("no section headings found; action types were not read"); } }
      else if (items.length === 0 && parseTraitHeader(line, true)) { section = "traits"; if (!bareSections) { bareSections = true; warnings.push("no section headings found; action types were not read"); } }
      else { warnings.push(`unclassified line before the first section: ${line.slice(0, 60)}`); continue; }
    }

    if (section === "traits" && bareSections && parsePowerHeader(line)) { section = "standard"; current = null; }

    if (section === "traits") {
      const t = parseTraitHeader(line, canStartTrait);
      if (t) {
        current = { kind: t.auraSize != null ? "aura" : "trait", name: t.name, keywords: t.keywords, auraSize: t.auraSize, bodyLines: [], section };
        items.push(current);
        canStartTrait = false;
        continue;
      }
      if (current) { current.bodyLines.push(line); canStartTrait = /[.!?)"]$/.test(line); continue; }
      warnings.push(`text before the first trait header: ${line.slice(0, 60)}`);
      continue;
    }

    /* action sections */
    const ph = parsePowerHeader(line);
    if (ph) {
      current = { kind: "power", name: ph.name, keywords: ph.keywords, usageText: ph.usageText, bodyLines: [], section };
      items.push(current);
      continue;
    }
    if (current) { current.bodyLines.push(line); continue; }
    warnings.push(`line before the first power: ${line.slice(0, 60)}`);
  }

  /* ------- assemble stats ------- */
  if (fieldLines.hp) {
    const hp = /HP\s*(\d[\d,]*)/i.exec(fieldLines.hp);
    if (hp) stat.hp = num(hp[1]);
    stat.minion = /missed attack never damages a minion/i.test(fieldLines.hp);
    const bl = /Bloodied\s*(\d+)/i.exec(fieldLines.hp);
    if (bl) stat.bloodied = num(bl[1]);
    const hs = /Healing Surges?\s*(\d+)/i.exec(fieldLines.hp);
    if (hs) stat.healingSurges = num(hs[1]);
  } else warnings.push("no HP line");
  if (fieldLines.ac) Object.assign(stat, parseAC(fieldLines.ac)); else warnings.push("no AC line");
  if (fieldLines.speed) {
    const sp = parseSpeed(fieldLines.speed);
    stat.speed = { raw: fieldLines.speed, ...sp };
  } else warnings.push("no Speed line");
  const sensesRaw = [stat.perception != null ? `Perception +${stat.perception}` : null, fieldLines.sensesText].filter(Boolean).join("; ");
  if (sensesRaw) Object.assign(stat, parseSenses(sensesRaw), { sensesRaw });
  if (fieldLines.defense) {
    const dm = parseDefenseMods(fieldLines.defense.replace(/\s*;?\s*(Saving Throws?|Action Points?).*$/i, ""));
    Object.assign(stat, dm);
  }
  const miscText = [fieldLines.misc, fieldLines.defense].filter(Boolean).join("; ");
  const st = /Saving Throws?\s*\+?(\d+)/i.exec(miscText);
  if (st) stat.savingThrows = num(st[1]);
  const ap = /Action Points?\s*(\d+)/i.exec(miscText);
  if (ap) stat.actionPoints = num(ap[1]);
  if (fieldLines.alignment) {
    const m = /^Align\w*\s+(.+?)\s+Languages?\s*(.*)$/i.exec(fieldLines.alignment);
    if (m) { stat.alignment = m[1].trim(); stat.languages = /^[-—–]*$/.test(m[2].trim()) ? [] : m[2].split(/,\s*/).map((s) => s.trim()).filter(Boolean); }
    else { stat.alignmentRaw = fieldLines.alignment; warnings.push("alignment line not split"); }
  } else warnings.push("no Alignment line");
  if (fieldLines.skills) stat.skills = fieldLines.skills.split(/,\s*/).map((s) => { const m = /^(.+?)\s+([+-]\d+)$/.exec(s.trim()); return m ? { skill: m[1], bonus: num(m[2]) } : { skill: s.trim(), bonus: null }; });
  if (fieldLines.equipment) stat.equipment = fieldLines.equipment;
  stat.abilities = parseAbilities(abilityRows);
  if (stat.initiative == null) warnings.push("no Initiative");
  block.stats = stat;

  /* ------- items ------- */
  block.items = items.map((it) => {
    let text = it.bodyLines.join(" ").replace(/\s+/g, " ").trim();
    const out = { kind: it.kind, name: it.name, icon: null, keywords: it.keywords };
    if (it.kind === "power") {
      out.usage = parseUsageText(it.usageText, it.section, text, warnings, it.name);
      // the "(Immediate Reaction)" in a label is kept in usage; drop it so section labels parse
      text = text.replace(/\b(Attack|Effect|Hit)\s*\((?:Immediate Reaction|Immediate Interrupt|Opportunity Action|Free Action|Minor Action|Move Action|Standard Action)\)\s*:/gi, "$1:");
    }
    if (it.auraSize != null) out.auraSize = it.auraSize;
    out.text = text;
    out.body = parseBody(text);
    if (it.kind === "power") { out.icon = rangeIcon(out.body); out.iconMeaning = out.icon ? { M: "melee", R: "ranged", C: "close", A: "area" }[out.icon] : null; out.basicAttack = false; }
    return out;
  });

  if (!items.length) warnings.push("no powers or traits found");
  block.warnings = warnings;
  block.raw = text;
  return block;
}

/* ------------------------------ validation ------------------------------ */

const abMod = (score, level) => Math.floor((score - 10) / 2) + Math.floor(level / 2);

/**
 * Cross-checks that catch OCR mistakes. Returns problems; each is something a person should look at.
 * Attack bonuses, defenses and HP are not edited, only flagged.
 */
export function validateMV(block) {
  const problems = [];
  const s = block.stats;
  const L = block.level;
  if (s.hp == null) problems.push("HP missing");
  if (!block.stats.minion && s.hp != null && s.bloodied != null && s.bloodied !== Math.floor(s.hp / 2)) problems.push(`Bloodied ${s.bloodied} does not match HP ${s.hp} (expected ${Math.floor(s.hp / 2)})`);
  if (!block.stats.minion && s.hp != null && s.bloodied == null) problems.push("Bloodied value missing");
  for (const k of ["ac", "fortitude", "reflex", "will"]) {
    if (s[k] == null) problems.push(`${k} missing`);
    else if (s[k] < L + 6 || s[k] > L + 22) problems.push(`${k} ${s[k]} is unusual for level ${L}`);
  }
  const ab = s.abilities || {};
  const names = ["str", "con", "dex", "int", "wis", "cha"];
  for (const k of names) {
    if (!ab[k]) { problems.push(`ability ${k} missing`); continue; }
    if (ab[k].mod !== abMod(ab[k].score, L)) problems.push(`${k} ${ab[k].score} (${ab[k].mod >= 0 ? "+" : ""}${ab[k].mod}) does not match level ${L} (expected ${abMod(ab[k].score, L)})`);
  }
  for (const it of block.items) {
    for (const a of it.body?.attacks || []) if (a.bonus < L + 1 || a.bonus > L + 10) problems.push(`${it.name}: attack +${a.bonus} is unusual for level ${L}`);
  }
  return problems;
}

/* ------------------------------ pasted text with several blocks ------------------------------ */

/** Split pasted text of the later layout into blocks and parse each. Works when the text layer is clean. */
export function parseMVCorpus(rawText, ctx = {}) {
  const lines = rawText.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const h = matchHeader(cleanLine(lines[i]));
    if (!h || !h.rawName) continue;
    const next = cleanLine(lines[i + 1] || "") || cleanLine(lines[i + 2] || "");
    if (parseSubheader(next) || /^(hazard|trap)\b/i.test(next)) starts.push(i);
  }
  const out = [];
  starts.forEach((s, n) => {
    const chunk = lines.slice(s, starts[n + 1] ?? lines.length);
    // stop after the Alignment/Equipment line so the next paragraph of prose is not swallowed
    let end = chunk.findIndex((l) => /^\s*Align\w*\b/i.test(l));
    if (end >= 0) { end++; if (/^\s*Equip/i.test(chunk[end] || "")) end++; }
    const text = chunk.slice(0, end >= 0 ? end : chunk.length).join("\n");
    const block = parseMVBlock(text, ctx);
    if (!block.skipped) { block.checks = validateMV(block); out.push(block); }
  });
  return out;
}
