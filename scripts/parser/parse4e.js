/**
 * 4e stat block parser: cleaned text lines -> lossless intermediate JSON.
 * No Draw Steel decisions are made here.
 */
import { cleanLines, isNoiseLine } from "./clean.js";

const ROLES = "Artillery|Brute|Controller|Lurker|Skirmisher|Soldier";
const HEADER_RE = /^\s*(\S.*?)\s+Level\s+(\d+)\s+(.+?)\s*$/;
const TAIL_RE = new RegExp(
  `^(Elite |Solo )?(Minion)?\\s*(${ROLES})?\\s*(\\((?:Leader|L)\\))?$`
);
const SIZES = "Tiny|Small|Medium|Large|Huge|Gargantuan";
const ORIGINS = ["natural", "shadow", "fey", "elemental", "immortal", "aberrant"];
const ACTIONS = /^(standard|move|minor|free|immediate reaction|immediate interrupt|opportunity|no action)\b/i;

const FIELD_START = {
  initiative: /^Initiative\s/,
  senses: /^Senses\s/,
  hp: /^HP\s/,
  ac: /^AC\s+\d/,
  defenseMods: /^(Immune|Resist|Vulnerable)\b/,
  saves: /^Saving Throws?\b/,
  speed: /^Speed\s+(?:\d|fly|swim|climb|burrow|teleport)/,
  ap: /^Action Points?\b/,
  alignment: /^Alignment\b/,
  skills: /^Skills\b/,
  abilityRow: /^(Str|Con|Dex|Int|Wis|Cha)\s+\d/,
  equipment: /^Equipment\b/
};

const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, "")));

/* ------------------------------------------------------------------ */
/* Block discovery                                                    */
/* ------------------------------------------------------------------ */

export function parseHeader(line) {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  const t = TAIL_RE.exec(m[3].trim());
  if (!t) return null;
  const [, tier, minion, role, leader] = t;
  if (!tier && !minion && !role) return null;
  // art/running-head labels glued in front of the name: "BEHOLDER Beholder Eye Tyrant"
  const nameFull = m[1].trim().replace(/^(?:[A-Z]{3,}\s+)+(?=[A-Z][a-z])/, "");
  const sub = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(nameFull);
  return {
    name: nameFull,
    baseName: sub ? sub[1] : nameFull,
    nameQualifier: sub ? sub[2] : null,
    level: Number(m[2]),
    organization: minion ? "minion" : tier ? tier.trim().toLowerCase() : "standard",
    role: role ? role.toLowerCase() : null,
    leader: !!leader
  };
}

/** Find real stat blocks (header followed by HP/AC lines) and return [{start,end}] line ranges. */
export function findBlocks(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!parseHeader(lines[i])) continue;
    let ok = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 16); j++) {
      if (parseHeader(lines[j])) break;
      if (/^(HP|AC)\s+\d/.test(lines[j])) {
        ok = true;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  return starts.map((start, idx) => {
    const limit = Math.min(start + 140, starts[idx + 1] ?? lines.length);
    let end = limit - 1;
    let conAt = -1;
    for (let j = start + 1; j < limit; j++) {
      if (/^Con\s+\d+/.test(lines[j])) {
        conAt = j;
        break;
      }
    }
    if (conAt >= 0) {
      end = conAt;
      if (/^Equipment\b/.test(lines[end + 1] || "")) {
        end++;
        // equipment can wrap onto a lowercase-leading line
        while (end + 1 < limit && /^[a-z]/.test(lines[end + 1] || "") && !/Tactics$/.test(lines[end + 1])) end++;
      }
    }
    return { start, end };
  });
}

/* ------------------------------------------------------------------ */
/* Field parsers                                                      */
/* ------------------------------------------------------------------ */

export function parseTypeLine(line) {
  const m = new RegExp(`^(${SIZES})\\s+(.+?)\\s+XP\\s+([\\d,]+|-)\\s*(.*)$`).exec(line);
  if (!m) return null;
  let rest = m[2].trim();
  const kwMatch = /\(([^)]*)\)/.exec(rest);
  const typeKeywords = kwMatch ? kwMatch[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];
  rest = rest.replace(/\([^)]*\)/g, "").trim();
  const words = rest.split(/\s+/);
  const origin = ORIGINS.includes(words[0].toLowerCase()) ? words.shift().toLowerCase() : null;
  return {
    size: m[1].toLowerCase(),
    origin,
    type: words.join(" ").toLowerCase(),
    typeKeywords,
    xp: m[3] === "-" ? null : num(m[3]),
    typeExtra: m[4] || null
  };
}

export function parseInitiative(text) {
  const m = /^Initiative\s+([+-]?\d+)\s*(.*)$/.exec(text);
  if (!m) return {};
  let note = m[2] || "";
  let senses = null;
  const s = /\bSenses\s+(.*)$/.exec(note);
  if (s) {
    senses = s[1];
    note = note.slice(0, s.index).replace(/[;,\s]+$/, "");
  }
  return { initiative: num(m[1]), initiativeNote: note || null, sensesRaw: senses };
}

const SENTENCE_STARTERS = new Set(["Attacks","Any","Each","All","The","When","If","A","An","Enemies","Creatures","Allies","Whenever","While","Ranged","Melee","Opportunity","Targets","Once","Until","At","On","As","Before","After","Creature"]);
/** "Perception +11 Angelic Presence Attacks against ..." -> senses + a trailing trait the PDF glued onto the line. */
export function splitSensesTrait(raw) {
  const m = /^(Perception\s+[+-]?\d+(?:;\s*[^A-Z]*?)?)\s+([A-Z][a-z'\-]+(?:\s+[A-Za-z'\-]+)*\s+\S.*)$/.exec(raw || "");
  if (!m || /;/.test(m[2].split(/\s/)[0])) return { senses: raw, trait: null };
  const words = m[2].split(/\s+/);
  // name = leading Title Case words up to a sentence starter
  let n = 1;
  while (n < words.length && /^[A-Z]/.test(words[n]) && !SENTENCE_STARTERS.has(words[n]) && n < 4) n++;
  return { senses: m[1], trait: { name: words.slice(0, n).join(" "), text: words.slice(n).join(" ") } };
}

export function parseSenses(raw) {
  if (!raw) return {};
  const parts = raw.split(/;\s*/).map((s) => s.trim()).filter(Boolean);
  let perception = null;
  const senses = [];
  for (const p of parts) {
    const m = /^Perception\s+([+-]?\d+)$/.exec(p);
    if (m) perception = num(m[1]);
    else senses.push(...p.split(/,\s*/).map((s) => s.trim()).filter(Boolean));
  }
  return { perception, senses };
}

export function parseHP(text) {
  const m = /^HP\s+([\d,]+)\s*(.*)$/.exec(text);
  if (!m) return {};
  const out = { hp: num(m[1]), minion: /missed attack never damages a minion/i.test(text) };
  const b = /Bloodied\s+([\d,]+)/.exec(m[2]);
  if (b) out.bloodied = num(b[1]);
  const extra = m[2].replace(/Bloodied\s+[\d,]+;?\s*/, "").replace(/^;\s*/, "").trim();
  out.hpNote = extra || null;
  return out;
}

export function parseAC(text) {
  const out = {};
  const ac = /\bAC\s+(\d+)/.exec(text);
  if (ac) out.ac = num(ac[1]);
  for (const [key, label] of [["fortitude", "Fortitude"], ["reflex", "Reflex"], ["will", "Will"]]) {
    const m = new RegExp(`${label}\\s+(\\d+)`).exec(text);
    if (m) out[key] = num(m[1]);
  }
  return out;
}

export function parseDefenseMods(text) {
  const immune = [];
  const resist = [];
  const vulnerable = [];
  for (const part of text.split(/;\s*(?=(?:Immune|Resist|Vulnerable)\b)/)) {
    let m;
    if ((m = /^Immune\s+(.*)$/.exec(part))) immune.push(...m[1].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean));
    else if ((m = /^Resist\s+(.*)$/.exec(part))) resist.push(...splitAmounts(m[1]));
    else if ((m = /^Vulnerable\s+(.*)$/.exec(part))) vulnerable.push(...splitAmounts(m[1]));
  }
  return { immune, resist, vulnerable };
}

function splitAmounts(text) {
  // "10 fire, 5 cold" | "30 poison" | "insubstantial" | "10 variable (2/encounter; see glossary)"
  const items = [];
  const cleaned = text.replace(/\(([^)]*)\)/g, (m) => m.replace(/,/g, "\u0001"));
  for (const piece of cleaned.split(/,\s*/)) {
    const p = piece.replace(/\u0001/g, ",").trim();
    if (!p) continue;
    const m = /^(\d+)\s+(.*)$/.exec(p);
    items.push(m ? { amount: num(m[1]), type: m[2] } : { amount: null, type: p });
  }
  return items;
}

export function parseSpeed(text) {
  const body = text.replace(/^Speed\s*/, "");
  const [main, ...noteParts] = body.split(/;\s*/);
  const note = noteParts.join("; ") || null;
  const modes = [];
  let walk = null;
  // split on commas outside parentheses
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of main) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) parts.push(cur);
  for (const raw of parts) {
    const p = raw.trim();
    let m;
    if ((m = /^(\d+)(?:\s*\(([^)]*)\))?$/.exec(p))) walk = { speed: num(m[1]), notes: m[2] || null };
    else if ((m = /^([a-z ]+?)\s+(\d+)(?:\s*\(([^)]*)\))?$/i.exec(p))) modes.push({ mode: m[1].toLowerCase(), speed: num(m[2]), notes: m[3] || null });
    else modes.push({ mode: p, speed: null, notes: null, unparsed: true });
  }
  return { walk: walk?.speed ?? null, walkNotes: walk?.notes ?? null, modes, note };
}

export function parseAbilities(rows) {
  const out = {};
  const re = /(Str|Con|Dex|Int|Wis|Cha)\s+(\d+)\s*\(([+-]?\d+)\)/g;
  const names = { Str: "str", Con: "con", Dex: "dex", Int: "int", Wis: "wis", Cha: "cha" };
  for (const row of rows) {
    let m;
    while ((m = re.exec(row))) out[names[m[1]]] = { score: num(m[2]), mod: num(m[3]) };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Power / trait grammar                                              */
/* ------------------------------------------------------------------ */

// the action icon; some PDFs turn it into a stray glyph ("©", "<*", "'ir"), which still marks a power
const ICON_RE = /^(RM|M R|m|M|r|R|C|A|[^A-Za-z0-9\s]\S{0,3}|'?[a-z]{1,2})\s+(?=\S)/;
const USAGE_HINT = /(at-will|encounter|daily|recharge|sustain|aura)/i;

/** Gather a power header that may wrap across lines inside its usage parentheses. */
function readPowerHeader(lines, i) {
  let line = lines[i];
  let icon = null;
  const im = ICON_RE.exec(line);
  if (im) { icon = im[1].replace(" ", ""); line = line.slice(im[0].length); }
  const open = line.indexOf("(");
  if (open < 0) return null;
  const name = line.slice(0, open).trim();
  if (!name || name.length > 60 || /[.;:]$/.test(name) || !/^[A-Z0-9"'(]/.test(name)) return null;
  let depth = 0, text = line.slice(open), consumed = 1;
  const countDepth = (s) => { for (const ch of s) { if (ch === "(") depth++; else if (ch === ")") depth--; } };
  countDepth(text);
  while (depth > 0 && consumed < 4 && lines[i + consumed] !== undefined) {
    text += " " + lines[i + consumed].trim();
    countDepth(lines[i + consumed]);
    consumed++;
  }
  if (depth !== 0) return null;
  const close = text.indexOf(")", 0);
  // find matching close
  let d = 0, endIdx = -1;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "(") d++;
    if (text[k] === ")") { d--; if (d === 0) { endIdx = k; break; } }
  }
  if (endIdx < 0) return null;
  const usageRaw = text.slice(1, endIdx).trim();
  if (!icon && !/(at-will|encounter|daily|recharge)/i.test(usageRaw)) return null;
  if (icon && !USAGE_HINT.test(usageRaw) && !ACTIONS.test(usageRaw)) return null;
  const after = text.slice(endIdx + 1).trim();
  let keywords = [];
  let tail = after;
  const kw = /^✦\s*(.*)$/.exec(after);
  if (kw) { keywords = kw[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean); tail = ""; }
  return { icon, name, usageRaw, keywords, tail, consumed };
}

export function parseUsage(raw) {
  const segs = raw.split(/;\s*/).map((s) => s.trim()).filter(Boolean);
  const usage = { raw, action: null, trigger: null, frequency: null, recharge: null, sustain: null, perRound: null, notes: [] };
  segs.forEach((seg, idx) => {
    let m;
    if (idx === 0 && ACTIONS.test(seg)) {
      const a = ACTIONS.exec(seg)[1].toLowerCase();
      usage.action = a;
      const rest = seg.slice(a.length).replace(/^[,\s]+/, "");
      const pr = /^(\d+)\/round\b/.exec(rest);
      if (pr) usage.perRound = num(pr[1]);
      else if (rest) usage.trigger = rest;
    } else if (/^(at-will|encounter|daily)$/i.test(seg)) usage.frequency = seg.toLowerCase();
    else if ((m = /^recharges?\s+(.*)$/i.exec(seg))) {
      const faces = (m[1].match(/[1-6]/g) || []).map(Number);
      if (/^[\d\s]+$/.test(m[1]) && faces.length) usage.recharge = { faces };
      else usage.recharge = { when: m[1] };
      usage.frequency = "recharge";
    } else if ((m = /^sustain\s+(\w+)/i.exec(seg))) usage.sustain = m[1].toLowerCase();
    else if (idx === 0 && !usage.action) usage.trigger = seg; // reaction without leading keyword
    else usage.notes.push(seg);
  });
  return usage;
}

const RANGE_RE = /\b(Reach|Ranged|Close burst|Close blast|Area burst|Area wall|Melee touch|Melee|Personal)\s*(\d+)?(?:\s+within\s+(\d+))?/;
const CONDITIONS = [
  "blinded", "dazed", "deafened", "dominated", "grabbed", "immobilized", "marked", "petrified",
  "prone", "restrained", "slowed", "stunned", "unconscious", "weakened", "helpless", "invisible"
];
const SECTION_RE = /\b(Hit|Miss|Effect|Aftereffect|First Failed Save|Second Failed Save|Secondary Attack|Secondary Target|Primary Target|Primary Attack|Special|Requirement|Trigger|Attack)\s*:/g;

/** Light-touch structured extraction. Raw text always stays attached; this only labels the obvious. */
export function parseBody(text) {
  const t = text.replace(/\s+/g, " ").trim();
  const body = { text: t };
  let m = RANGE_RE.exec(t);
  if (m) body.range = { kind: m[1].toLowerCase(), size: m[2] ? num(m[2]) : null, within: m[3] ? num(m[3]) : null };
  const targets = /\btargets?\s+(enemies|creatures|allies|each [^;.,]+|one [^;.,]+)/i.exec(t);
  if (targets) body.targeting = targets[0];
  body.attacks = [...t.matchAll(/\+(\d+)\s+vs\.?\s+(AC|Fortitude|Reflex|Will)/g)].map((a) => ({ bonus: num(a[1]), defense: a[2].toLowerCase() }));
  const tNoOngoing = t.replace(/ongoing\s+\d+\s*(?:[a-z]+\s+)?damage/g, "ongoing X");
  body.damage = [...tNoOngoing.matchAll(/(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s+((?:[a-z]+(?:,\s*|\s+and\s+|\s+or\s+))*[a-z]+\s+)?damage/g)].map((d) => ({
    amount: d[1].replace(/\s+/g, ""),
    types: d[2] ? d[2].trim().split(/,\s*|\s+and\s+|\s+or\s+/).filter(Boolean) : []
  }));
  body.ongoing = [...t.matchAll(/ongoing\s+(\d+)\s*([a-z]+)?\s*damage/g)].map((o) => ({ amount: num(o[1]), type: o[2] || null }));
  body.saveEnds = /\(save ends/i.test(t);
  body.conditions = CONDITIONS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(t));
  body.forcedMovement = [...t.matchAll(/\b(push|pull|slide|shift|teleport)e?s?\s+(?:the target\s+|each target\s+)?(?:up to\s+)?(\d+)\s+squares?/gi)].map((f) => ({ kind: f[1].toLowerCase(), squares: num(f[2]) }));
  // sections
  const sections = {};
  const marks = [...t.matchAll(SECTION_RE)];
  if (marks.length) {
    const lead = t.slice(0, marks[0].index).trim();
    if (lead) sections.lead = lead;
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : t.length;
      const key = mk[1].toLowerCase().replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
      sections[key] = t.slice(mk.index + mk[0].length, end).trim();
    });
    body.sections = sections;
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Block parser                                                       */
/* ------------------------------------------------------------------ */

function classify(line) {
  for (const [k, re] of Object.entries(FIELD_START)) if (re.test(line)) return k;
  return null;
}

const AURA_RE = /^(.+?)(?:\s+\(([^)]*)\))?\s+aura\s+(\d+)\b\s*(?:\(([^)]*)\))?\s*[;:]?\s*(.*)$/;

const ACTION_WORDS = "standard|move|minor|free|immediate|opportunity|no action";
// Two-column extraction glues a power onto the previous line: "Speed 6 mClaw (standard; ..." / "... damage. M Ghostly Possession (standard; ..."
const MIDLINE_POWER = new RegExp(`(?<=\\S)(?:\\s+|(?<=[\\d)]\\s))([mMrRCA])(?:\\s+|(?=[A-Z][a-z]))(?=[A-Z][^()✦]{1,50}\\((?:${ACTION_WORDS}))`, "g");
export function presplit(lines) {
  const out = [];
  for (const line of lines) {
    if (!/\((?:standard|move|minor|free|immediate|opportunity|no action)/.test(line) || ICON_RE.test(line) && !MIDLINE_POWER.test(line)) { MIDLINE_POWER.lastIndex = 0; out.push(line); continue; }
    MIDLINE_POWER.lastIndex = 0;
    const parts = [];
    let last = 0, m;
    while ((m = MIDLINE_POWER.exec(line))) {
      parts.push(line.slice(last, m.index));
      last = m.index + m[0].length - 0;
      parts.push("\u0000" + m[1] + " ");
      MIDLINE_POWER.lastIndex = last;
    }
    parts.push(line.slice(last));
    // rebuild: segments marked with \u0000 start new lines
    let buf = "";
    for (const p of parts) {
      if (p.startsWith("\u0000")) { if (buf.trim()) out.push(buf.trimEnd()); buf = p.slice(1); } else buf += p;
    }
    if (buf.trim()) out.push(buf.trimEnd());
  }
  return out;
}

export function parseBlock(allLines, range) {
  const warnings = [];
  const lines = presplit(allLines.slice(range.start, range.end + 1)).map((l) =>
    // icon glued to the name at line start: "mClaw (standard; at-will)"
    l.replace(new RegExp(`^([mMrRCA])(?=[A-Z][a-z][^()✦]{0,50}\\((?:${ACTION_WORDS}))`), "$1 ")
  );
  const header = parseHeader(lines[0]);
  const block = { ...header, source: { startLine: range.start + 1, endLine: range.end + 1 } };
  const stat = {};
  const items = [];
  let current = null; // current open item (power/trait/aura)
  let currentField = null; // current open stat field for continuation
  const fieldText = {};
  const abilityRows = [];
  let phase = "head"; // head -> body (after HP/AC/etc.) -> tail (after Alignment)

  let i = 1;
  // type line
  const typeInfo = parseTypeLine(lines[i] || "");
  if (typeInfo) { Object.assign(block, typeInfo); i++; } else warnings.push("type line not recognised: " + (lines[i] || "").slice(0, 60));

  const openField = (key, text) => { fieldText[key] = text; currentField = key; current = null; };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isNoiseLine(line)) continue;
    const field = classify(line);

    if (field === "abilityRow") { abilityRows.push(line); currentField = null; current = null; phase = "tail"; continue; }
    if (field === "equipment") { openField("equipment", line.replace(/^Equipment\s*/, "")); phase = "tail"; continue; }
    if (field === "alignment") { openField("alignment", line); phase = "tail"; continue; }
    if (field === "skills") { openField("skills", line.replace(/^Skills\s*/, "")); phase = "tail"; continue; }
    if (field) {
      if (field !== "initiative" && field !== "senses" && field !== "defenseMods") phase = "body";
      openField(field, field === "senses" ? line.replace(/^Senses\s*/, "") : line);
      if (field === "initiative") {
        // some blocks carry Senses on the same line; "Initiative +N Senses ..." handled in parseInitiative
      }
      continue;
    }

    // power header?
    const ph = readPowerHeader(lines, i);
    if (ph) {
      current = { kind: ph.icon ? "power" : "power", icon: ph.icon, name: ph.name, usageRaw: ph.usageRaw, keywords: ph.keywords, bodyLines: [] };
      if (ph.tail) current.bodyLines.push(ph.tail);
      items.push(current);
      currentField = null;
      i += ph.consumed - 1;
      continue;
    }

    // aura / trait line (iconless)
    const am = AURA_RE.exec(line);
    if (am && /^[A-Z]/.test(am[1]) && am[1].length <= 50) {
      const kw = am[2] || am[4];
      current = { kind: "aura", icon: null, name: am[1].trim(), auraSize: num(am[3]), keywords: kw ? kw.split(/,\s*/) : [], bodyLines: am[5] ? [am[5]] : [] };
      items.push(current);
      currentField = null;
      continue;
    }

    // continuation of an open item or field
    if (current) { current.bodyLines.push(line.trim()); continue; }
    if (currentField) { fieldText[currentField] += " " + line.trim(); continue; }

    // iconless trait name (head or body phase): short Title Case line; text follows
    if (phase !== "tail" && /^[A-Z][A-Za-z'\- ]{1,40}(?:\s+\d+)?$/.test(line.trim()) && !/[.!?]$/.test(line.trim())) {
      current = { kind: "trait", icon: null, name: line.trim(), keywords: [], bodyLines: [] };
      items.push(current);
      continue;
    }
    if (phase === "head" && /;|\./.test(line)) {
      // "Name keywords; text" style trait
      const tm = /^([A-Z][A-Za-z'\- ]{1,40}?)(?:\s+\(([^)]*)\))?\s*[:;]\s*(.*)$/.exec(line.trim());
      if (tm) {
        current = { kind: "trait", icon: null, name: tm[1].trim(), keywords: tm[2] ? tm[2].split(/,\s*/) : [], bodyLines: [tm[3]] };
        items.push(current);
        continue;
      }
    }
    warnings.push(`unclassified line ${range.start + i + 1}: ${line.slice(0, 70)}`);
  }

  /* -------- assemble fields -------- */
  if (fieldText.initiative) {
    const ini = parseInitiative(fieldText.initiative);
    stat.initiative = ini.initiative;
    if (ini.initiativeNote) stat.initiativeNote = ini.initiativeNote;
    if (ini.sensesRaw && !fieldText.senses) fieldText.senses = ini.sensesRaw;
  } else warnings.push("no Initiative");
  if (fieldText.senses) {
    const split = splitSensesTrait(fieldText.senses);
    if (split.trait) {
      items.unshift({ kind: "trait", icon: null, name: split.trait.name, keywords: [], bodyLines: [split.trait.text] });
      warnings.push(`trait glued onto Senses line; name split guessed: "${split.trait.name}"`);
      fieldText.senses = split.senses;
    }
    Object.assign(stat, parseSenses(fieldText.senses), { sensesRaw: fieldText.senses });
  }
  if (fieldText.hp) Object.assign(stat, parseHP(fieldText.hp)); else warnings.push("no HP");
  if (fieldText.ac) Object.assign(stat, parseAC(fieldText.ac)); else warnings.push("no AC");
  if (fieldText.defenseMods) Object.assign(stat, parseDefenseMods(fieldText.defenseMods));
  if (fieldText.saves) { const m = /\+?(\d+)/.exec(fieldText.saves); stat.savingThrows = m ? num(m[1]) : null; }
  if (fieldText.speed) stat.speed = { raw: fieldText.speed, ...parseSpeed(fieldText.speed) }; else warnings.push("no Speed");
  if (fieldText.ap) { const m = /(\d+)/.exec(fieldText.ap); stat.actionPoints = m ? num(m[1]) : null; }
  if (fieldText.alignment) {
    const m = /^Alignment\s+(.+?)\s+Languages\s*(.*)$/.exec(fieldText.alignment);
    if (m) { stat.alignment = m[1].trim(); stat.languages = /^[-—–]$/.test(m[2].trim()) || !m[2].trim() ? [] : m[2].split(/,\s*/).map((s) => s.trim()); }
    else { stat.alignmentRaw = fieldText.alignment; warnings.push("alignment line not split"); }
  }
  if (fieldText.skills) stat.skills = fieldText.skills.split(/,\s*/).map((s) => { const m = /^(.+?)\s+([+-]\d+)$/.exec(s.trim()); return m ? { skill: m[1], bonus: num(m[2]) } : { skill: s.trim(), bonus: null }; });
  stat.abilities = parseAbilities(abilityRows);
  if (Object.keys(stat.abilities).length !== 6) warnings.push(`ability scores: found ${Object.keys(stat.abilities).length}/6`);
  if (fieldText.equipment) stat.equipment = fieldText.equipment;

  /* -------- items -------- */
  block.stats = stat;
  block.items = items.map((it) => {
    const text = it.bodyLines.join(" ").replace(/\s+/g, " ").trim();
    const out = { kind: it.kind, name: it.name, icon: it.icon, keywords: it.keywords, text };
    if (it.auraSize != null) out.auraSize = it.auraSize;
    if (it.usageRaw) { out.usage = parseUsage(it.usageRaw); }
    if (it.icon) {
      out.iconMeaning = { m: "melee basic", M: "melee", r: "ranged basic", R: "ranged", C: "close", A: "area", RM: "ranged/melee" }[it.icon] || null;
      out.basicAttack = it.icon === "m" || it.icon === "r";
    }
    out.body = parseBody(text);
    return out;
  });
  block.warnings = warnings;
  block.raw = lines.join("\n");
  return block;
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

export function parseCorpus(rawText) {
  const lines = cleanLines(rawText);
  const ranges = findBlocks(lines);
  return ranges.map((r) => parseBlock(lines, r));
}
