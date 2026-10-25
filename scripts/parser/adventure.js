/**
 * Parser for 4e stat blocks in the newer adventure layout (Dungeon magazine / Essentials-era):
 *
 *   3 Orc Reavers                          Level 5 Skirmisher
 *   Medium natural humanoid                XP 200 each
 *   HP 63; Bloodied 31                     Initiative +7
 *   AC 19, Fortitude 18, Reflex 18, Will 16    Perception +3
 *   Speed 6                                Low-light vision
 *   TRAITS
 *   Charging Mobility
 *   The orc reaver gains a +4 bonus to all defenses while charging.
 *   STANDARD ACTIONS
 *   (M) Battleaxe (weapon) + At-Will
 *   Attack: Melee 1 (one creature); +10 vs. AC
 *   Hit: 1d10 + 4 damage.
 *   TRIGGERED ACTIONS
 *   Savage Demise + Encounter
 *   Trigger: The orc drops to 0 hit points.
 *   Effect (No Action): The orc takes a standard action.
 *   Str 18 (+6)  Dex 17 (+5)  Wis 13 (+3)
 *   Con 15 (+4)  Int 8 (+1)   Cha 8 (+1)
 *   Alignment chaotic evil   Languages Common, Giant
 *
 * Input is a list of layout lines ({ text, cells[] }, see pdfLayout.js), so the parser tolerates the
 * OCR damage typical of scanned adventures: icons read as junk, "2dB" for 2d8, "Wls" for Wis, and so on.
 * Output has the same shape as parse4e.js, so the converter reads it unchanged.
 */
import { parseUsage, parseBody, parseHP, parseAC, parseDefenseMods, parseSpeed, parseSenses } from "./parse4e.js";

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

export function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
const titleCase = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
const VALID_DICE = new Set(["4", "6", "8", "10", "12", "20", "100"]);
const digitsOf = (t) => t.replace(/[lI|]/g, "1").replace(/[Oo]/g, "0").replace(/B/g, "8").replace(/\s+/g, "");

/** Repair dice damaged by OCR: "ldl0" -> 1d10, "2dB" -> 2d8, "3d1 0" -> 3d10. */
export function fixDice(s) {
  return s
    .replace(/(\d|[lI|])d1\s([0-2])(?!\d)/g, "$1d1$2")
    .replace(/(?<![A-Za-z0-9])([0-9lI|]{1,2})d([0-9lIOoB]{1,3})(?![A-Za-z0-9])/g, (m, n, d) => {
      const dd = digitsOf(d), nn = digitsOf(n);
      return VALID_DICE.has(dd) && /^\d{1,2}$/.test(nn) ? `${nn}d${dd}` : m;
    });
}

/** Digit look-alikes next to real digits (7S -> 75, 1O -> 10). Only used on numeric stat fields. */
export function digitize(s) {
  return s
    .replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0")
    .replace(/[lI](?=\d)|(?<=\d)[lI](?!\w)/g, "1")
    .replace(/(?<=\d)S\b|\bS(?=\d)/g, "5")
    .replace(/(?<=\d)B\b|\bB(?=\d)/g, "8");
}

function fixText(t) {
  let s = t
    .replace(/­/g, "")
    .replace(/[–−—]/g, "-")
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(?<=[a-z])[·•](?=[a-z])/g, "-")
    .replace(/&apos;/g, "'");
  s = fixDice(s);
  s = s.replace(/\bl\/round\b/g, "1/round");
  return s;
}

/* ------------------------------------------------------------------ */
/* header + role                                                      */
/* ------------------------------------------------------------------ */

const MONSTER_ROLES = ["artillery", "brute", "controller", "lurker", "skirmisher", "soldier"];
const OTHER_ROLES = ["blaster", "obstacle", "warder", "companion"];
const ALL_ROLES = [...MONSTER_ROLES, ...OTHER_ROLES];
const ORGS = ["elite", "solo", "minion"];

function nearest(word, list, maxDist = 2) {
  let best = null, bd = Infinity;
  for (const w of list) {
    const d = lev(word.toLowerCase(), w);
    if (d < bd) { bd = d; best = w; }
  }
  return bd <= maxDist && bd < word.length / 2 ? best : null;
}

export function parseRoleTail(tail) {
  let t = tail.trim();
  const leader = /\(\s*(?:leader|l)\s*\)\s*$/i.test(t);
  t = t.replace(/\(\s*(?:leader|l)\s*\)\s*$/i, "").trim();
  const words = t.split(/\s+/).filter(Boolean);
  // role first: "Sold ier" must read as Soldier, not as Solo + "ier"
  const whole = nearest(words.join(""), ALL_ROLES, 2);
  if (whole) return { organization: "standard", role: whole, leader };
  let org = "standard";
  while (words.length > 1) {
    const o = nearest(words[0], ORGS, 1);
    if (o) { org = o; words.shift(); } else break;
  }
  const role = nearest(words.join(""), ALL_ROLES, 2);
  return role ? { organization: org, role, leader } : null;
}

const levelDigits = (s) => Number(s.replace(/[Oo]/g, "0").replace(/[lI]/g, "1").replace(/S/g, "5"));

/** Header line: "3 Orc Reavers <tab> Level 5 Skirmisher". */
export function parseAdventureHeader(text) {
  const m = /^(.*?)\s*Level\s+([0-9OIlS]{1,2})\s+(.+)$/.exec(text.replace(/\t/g, "  "));
  if (!m) return null;
  let name = m[1].trim();
  if (!name || /Encounter\s*$/i.test(name)) return null;
  const rt = parseRoleTail(m[3]);
  if (!rt) return null;
  let count = null;
  const cm = /^(\d{1,2})\s+(?=\S)/.exec(name);
  if (cm) { count = Number(cm[1]); name = name.slice(cm[0].length); }
  name = name.replace(/\s*\(\s*[A-Za-z0-9]\s*\)\s*$/, "").replace(/^\W+/, "").trim();
  name = name.replace(/,?\s+/g, (s) => s).replace(/\.\s+(?=[A-Z])/g, ", ");
  return { name, count, level: levelDigits(m[2]), ...rt };
}

/* ------------------------------------------------------------------ */
/* block discovery                                                    */
/* ------------------------------------------------------------------ */

const isAlignmentLine = (t) => /^Alignment\b/i.test(t.trim());

/** Find blocks in layout lines: [{ start, end }]. A block runs from its header to Alignment/Equipment. */
export function findAdventureBlocks(lines) {
  const heads = [];
  lines.forEach((l, i) => {
    if (parseAdventureHeader(l.text)) heads.push(i);
  });
  const blocks = [];
  heads.forEach((start, k) => {
    const limit = Math.min(start + 90, heads[k + 1] ?? lines.length);
    let end = limit - 1;
    let aligned = false;
    for (let j = start + 1; j < limit; j++) {
      if (lines[j].col !== lines[start].col) { end = j - 1; break; }
      if (isAlignmentLine(lines[j].text)) {
        aligned = true;
        end = j;
        if (/^Equipment\b/i.test(lines[j + 1]?.text || "")) {
          end = j + 1;
          while (end + 1 < limit && /^[a-z]/.test(lines[end + 1].text) && lines[end + 1].cells.length === 1) end++;
        }
        break;
      }
    }
    blocks.push({ start, end, aligned });
  });
  return blocks;
}

/* ------------------------------------------------------------------ */
/* block contents                                                     */
/* ------------------------------------------------------------------ */

const SIZE_PREFIX = { tin: "tiny", sma: "small", med: "medium", lar: "large", hug: "huge", gar: "gargantuan" };
const ORIGINS = ["natural", "shadow", "fey", "elemental", "immortal", "aberrant"];

const SIZE_WORDS = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const TYPE_WORDS = ["humanoid", "beast", "animate", "magicalbeast"];

/** "Medium natural humanoid (mount)" -> { size, origin, type, typeKeywords }; tolerant of OCR splits like "Smal l" and "na tural". */
export function parseAdventureType(cell) {
  const words = cell.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let size = null, used = 0;
  const two = (words[0] + (words[1] || "")).toLowerCase();
  for (const s of SIZE_WORDS) {
    if (words[1] && lev(two, s) <= 1) { size = s; used = 2; break; }
    if (lev(words[0].toLowerCase(), s) <= 1 || (words[0].length >= 3 && SIZE_PREFIX[words[0].slice(0, 3).toLowerCase()] === s && words[0].length >= s.length - 2)) { size = s; used = 1; break; }
  }
  if (!size) return null;
  let rest = words.slice(used).join(" ");
  const kw = /\(([^)]*)\)/.exec(rest);
  const typeKeywords = kw ? kw[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];
  rest = rest.replace(/\([^)]*\)?/g, "").trim();
  // OCR sometimes turns the closing parenthesis into a period or quote: "humanoid. dwarf"
  const dm = /^([^.']+)[.'"]\s*(.+)$/.exec(rest);
  if (!kw && dm) { typeKeywords.push(...dm[2].split(/,\s*/).map((s) => s.trim()).filter(Boolean)); rest = dm[1]; }
  const flat = rest.replace(/[^A-Za-z]/g, "").toLowerCase();
  let origin = null, typeFlat = flat;
  for (const o of ORIGINS) if (lev(flat.slice(0, o.length), o) <= 1) { origin = o; typeFlat = flat.slice(o.length); break; }
  const tw = nearest(typeFlat, TYPE_WORDS, 2);
  const type = tw === "magicalbeast" ? "magical beast" : tw || typeFlat;
  return { size, origin, type, typeKeywords };
}

const SECTIONS = {
  traits: "TRAITS",
  standard: "STANDARD ACTIONS",
  move: "MOVE ACTIONS",
  minor: "MINOR ACTIONS",
  triggered: "TRIGGERED ACTIONS",
  free: "FREE ACTIONS"
};

function sectionOf(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 5 || letters.length > 24) return null;
  if ((letters.match(/[A-Z]/g) || []).length / letters.length < 0.6) return null;
  let best = null, bd = Infinity;
  for (const [key, label] of Object.entries(SECTIONS)) {
    const d = lev(letters.toUpperCase(), label.replace(/ /g, ""));
    if (d < bd) { bd = d; best = key; }
  }
  return bd <= 3 ? best : null;
}

const ABILITY_ORDER = ["str", "dex", "wis", "con", "int", "cha"];
const ABILITY_CELL = /^[^A-Za-z0-9]*([A-Za-z]{0,4}?)\s*([0-9A-Za-z]{0,3})\s*\(\s*([+-]?\d+)\s*\)\s*$/;
const ABILITY_RE = /([A-Za-z]{2,4}?)\s*([0-9A-Za-z]{0,3})\s*\(\s*([+-]?\d+)\s*\)/g;

/** Ability row -> [{ label, score, mod }]; each cell is "Str 19 (+6)" or a damaged version of it. */
function abilityMatches(line) {
  const cells = line.cells || [line.text ?? line];
  const fromCells = cells.map((c) => ABILITY_CELL.exec(c.trim())).filter(Boolean);
  if (fromCells.length >= 2 && fromCells.length === cells.length) return fromCells.map((m) => ({ label: m[1].toLowerCase().slice(0, 3), score: m[2], mod: Number(m[3]) }));
  const out = [];
  let m;
  ABILITY_RE.lastIndex = 0;
  const text = cells.join(" ");
  while ((m = ABILITY_RE.exec(text))) out.push({ label: m[1].toLowerCase().slice(0, 3), score: m[2], mod: Number(m[3]) });
  return out;
}

const isAbilityRow = (line) => abilityMatches(line).length >= 2 && /\(\s*[+-]?\d+\s*\)/.test(line.text);

/** Fix digit look-alikes after known labels: "AC lB" -> "AC 18", "HP41" -> "HP 41", "A( 21" -> "AC 21". */
const LABELLED_NUM = /\b(AC|HP|Bloodied|Fortitude|Reflex|Will|Speed|Initiative|Perception|fly|swim|climb|burrow|teleport)\s*([+-]?)\s*([0-9lIOoSBZ|]{1,3})(?![A-Za-z])/g;
export function fixLabelledNumbers(cell) {
  return cell
    .replace(/^A[(\[{]\s*/, "AC ")
    .replace(LABELLED_NUM, (m, label, sign, n) => {
      if (!/\d/.test(n) && n.length < 2) return m;
      const d = n.replace(/[lI|]/g, "1").replace(/[Oo]/g, "0").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
      return /^\d+$/.test(d) ? `${label} ${sign}${d}` : m;
    });
}

const LABEL_RE = /^(Requirement|Trigger|Attack|Hit|Miss|Effect|Special|Aftereffect|First Failed Save|Second Failed Save|Secondary Attack|Secondary Target|Primary Target|Primary Attack|Sustain)\b/i;
const LABEL_WORDS = ["requirement", "trigger", "attack", "hit", "miss", "effect", "special", "aftereffect", "sustain"];

/** "Tri88er (...)" etc: a short word before a colon that is close to a known label. */
function readLabel(text) {
  const m = /^([A-Za-z0-9]{3,12}(?:\s+(?:Failed Save|Attack|Target))?)\s*(?:\(([^)]*)\))?\s*[:;]\s*(.*)$/.exec(text);
  if (!m) return null;
  const first = m[1].toLowerCase();
  let label = LABEL_RE.test(m[1]) ? m[1].toLowerCase().match(LABEL_RE)[1].toLowerCase() : null;
  if (!label) {
    const d = nearest(first.split(/\s+/)[0], LABEL_WORDS, 2);
    if (d && first.length >= 4) label = d;
  }
  if (!label) return null;
  return { label, paren: m[2] || null, text: m[3] };
}

const POWER_RE = /^(?<pre>.*?)(?<kw>\s*\([^)]*\))?\s*[+✦♦◆•*¢·]\s*(?<usage>At-?W\w*|Encounter|Daily|Recharge|Aura\s*\d+)(?<tail>.*)$/i;

function wordlike(t) {
  return /^[A-Z][a-z'-]{2,}/.test(t) || (/^[A-Z0-9][A-Za-z0-9'-]{3,}$/.test(t) && /[a-z]{2}/.test(t));
}

function cleanPowerName(pre) {
  const tokens = pre.replace(/^[^A-Za-z0-9]+/, "").split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && !wordlike(tokens[0])) tokens.shift();
  return tokens.join(" ").replace(/\b5(?=[a-z]{3,})/g, "S").replace(/\b0(?=[a-z]{3,})/g, "O").trim();
}

function readPowerHeader(text) {
  const m = POWER_RE.exec(text.replace(/\t/g, " "));
  if (!m) return null;
  const name = cleanPowerName(m.groups.pre);
  if (!name || name.length > 60 || /[.:]$/.test(name)) return null;
  const keywords = m.groups.kw ? m.groups.kw.replace(/[()]/g, "").split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];
  const u = m.groups.usage;
  const tail = (m.groups.tail || "").trim();
  const aura = /^Aura\s*(\d+)/i.exec(u);
  let frequency = "at-will";
  if (/^enc/i.test(u)) frequency = "encounter";
  else if (/^dai/i.test(u)) frequency = "daily";
  else if (/^rech/i.test(u)) frequency = "recharge";
  return { name, keywords, frequency, auraSize: aura ? Number(aura[1]) : null, tail };
}

const ACTION_WORDS = [
  [/immediate\s+interrupt/i, "immediate interrupt"],
  [/immediate\s+reaction/i, "immediate reaction"],
  [/opportunity/i, "opportunity"],
  [/free/i, "free"],
  [/no\s+action/i, "no action"],
  [/minor/i, "minor"],
  [/move/i, "move"],
  [/standard/i, "standard"]
];
const actionFromParen = (p) => (p ? ACTION_WORDS.find(([re]) => re.test(p))?.[1] ?? null : null);

const SECTION_ACTION = { standard: "standard", move: "move", minor: "minor", triggered: "immediate reaction", free: "free", traits: null };

/** Turn a collected power into the parse4e item shape. */
function buildPowerItem(p) {
  const segs = [];
  for (const raw of p.lines) {
    const lab = readLabel(raw);
    if (lab) segs.push({ ...lab });
    else if (segs.length) segs[segs.length - 1].text += " " + raw;
    else segs.push({ label: "plain", paren: null, text: raw });
  }
  const find = (l) => segs.find((s) => s.label === l);
  const attack = find("attack"), hit = find("hit"), trig = find("trigger");
  let action = actionFromParen(attack?.paren) || actionFromParen(segs.find((s) => s.label === "effect")?.paren) || SECTION_ACTION[p.section] || "standard";
  if (p.section === "standard" && !actionFromParen(attack?.paren)) action = "standard";

  let attackText = attack ? attack.text.replace(/[.\s]+$/, "") : "";
  attackText = attackText.replace(/\bMelee\s+([2-9])\b/i, "Reach $1");
  const lead = [attackText, hit?.text].filter(Boolean).join("; ");
  const label = (s) => s.label.replace(/^./, (c) => c.toUpperCase());
  const rest = segs.filter((s) => !["attack", "hit", "trigger", "plain"].includes(s.label)).map((s) => `${label(s)}: ${s.text}`);
  const plain = segs.filter((s) => s.label === "plain").map((s) => s.text);
  const text = [...plain, lead, ...rest].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  const triggerText = trig ? trig.text.replace(/[.\s]+$/, "").replace(/;/g, ",") : "";
  const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  let usageRaw = action + (triggerText ? `, ${lcFirst(triggerText)}` : "");
  const perRound = /\(\s*1\/round\s*\)/i.test(p.tail);
  if (perRound && !triggerText) usageRaw += " 1/round";
  usageRaw += `; ${p.frequency === "recharge" ? "recharge" : p.frequency}`;
  const usage = parseUsage(usageRaw);
  if (p.frequency === "recharge") usage.recharge = { when: p.tail.replace(/^[\s~\[\]!,gJl]+/, "").trim() || "dice unreadable" };

  const rangeKind = /^(?:Reach|Melee)\b/i.test(attackText) ? "melee" : /^Ranged\b/i.test(attackText) ? "ranged" : /^Close\b/i.test(attackText) ? "close" : /^Area\b/i.test(attackText) ? "area" : null;
  const icon = rangeKind === "melee" ? (p.frequency === "at-will" ? "m" : "M")
    : rangeKind === "ranged" ? (p.frequency === "at-will" ? "r" : "R")
    : rangeKind === "close" ? "C" : rangeKind === "area" ? "A" : null;

  const item = { kind: "power", name: p.name, icon, keywords: p.keywords, text, usage, body: parseBody(text), originalSection: p.section };
  item.iconMeaning = { m: "melee basic", M: "melee", r: "ranged basic", R: "ranged", C: "close", A: "area" }[icon] || null;
  item.basicAttack = icon === "m" || icon === "r";
  return item;
}

/** Parse a block (array of layout lines, header first). */
export function parseAdventureBlock(lines, meta = {}) {
  const warnings = [];
  const head = parseAdventureHeader(lines[0].text);
  const block = { name: head.name, baseName: head.name, nameQualifier: null, count: head.count, level: head.level, organization: head.organization, role: head.role, leader: head.leader, source: { ...meta } };

  const body = lines.slice(1).map((l) => ({ ...l, text: fixText(l.text), cells: l.cells.map(fixText) }));

  // type line: first row, cells = [type, XP]
  const typeRow = body[0];
  const type = typeRow ? parseAdventureType(typeRow.cells[0]) : null;
  const isCreature = !!type;
  if (type) Object.assign(block, type);
  const xpCell = typeRow?.cells.find((c) => /XP/i.test(c)) || "";
  const xm = /XP\s+([0-9OIlS,]+)/i.exec(xpCell);
  block.xp = xm ? num(digitize(xm[1])) : null;
  block.kind = isCreature ? "monster" : "other";
  block.otherType = isCreature ? null : (typeRow?.cells[0] || "").trim();

  const stat = {};
  const fields = {};
  const items = [];
  let section = null;
  let current = null; // open power/trait
  let phase = "head"; // head -> body -> tail
  const abilityRows = [];
  const tail = {};

  const closeCurrent = () => {
    if (!current) return;
    if (current.type === "power") {
      const it = buildPowerItem(current);
      if (current.auraSize != null) { it.kind = "aura"; it.auraSize = current.auraSize; }
      items.push(it);
    } else {
      const text = current.lines.join(" ").replace(/\s+/g, " ").trim();
      const am = /\baura\s+(\d+)/i.exec(current.name + " " + text.slice(0, 40));
      const it = { kind: am ? "aura" : "trait", name: current.name, icon: null, keywords: [], text, body: parseBody(text) };
      if (am) it.auraSize = Number(am[1]);
      items.push(it);
    }
    current = null;
  };

  const SENSE_RE = /(vision|tremorsense|blindsight|truesight|echolocation|scent|darkvision)\b/i;
  let lastField = null;

  for (let i = isCreature ? 1 : 0; i < body.length; i++) {
    const line = body[i];
    if (!line.text.trim()) continue;

    // ----- tail fields -----
    if (isAbilityRow(line.text)) { closeCurrent(); abilityRows.push(...abilityMatches(line.text)); phase = "tail"; continue; }
    if (/^Alignment\b/i.test(line.text)) {
      closeCurrent();
      const m = /^Alignment\s+(.*?)\s+L[A-Za-z]{4,8}s?\s*(.*)$/i.exec(line.text.replace(/\t/g, " "));
      if (m) { tail.alignment = m[1].trim(); tail.languages = /^[-–—\s]*$/.test(m[2]) ? [] : m[2].split(/,\s*/).map((s) => s.trim()).filter(Boolean); }
      else tail.alignment = line.text.replace(/^Alignment\s+/i, "").trim();
      phase = "tail";
      continue;
    }
    if (/^Skills\b/i.test(line.text)) { closeCurrent(); tail.skills = line.text.replace(/^Skills\s*/i, "").split(/,\s*/).map((s) => { const m = /^(.+?)\s+([+-]\d+)$/.exec(s.trim()); return m ? { skill: m[1], bonus: Number(m[2]) } : { skill: s.trim(), bonus: null }; }); phase = "tail"; continue; }
    if (/^Equipment\b/i.test(line.text)) { closeCurrent(); tail.equipment = line.text.replace(/^Equipment\s*/i, "").replace(/\t/g, " "); lastField = "equipment"; continue; }
    if (lastField === "equipment" && /^[a-z]/.test(line.text) && line.cells.length === 1) { tail.equipment += " " + line.text; continue; }

    // ----- section header -----
    const sec = sectionOf(line.text);
    if (sec && line.cells.length === 1) { closeCurrent(); section = sec; phase = "body"; continue; }

    // ----- header-region stat cells -----
    if (phase === "head") {
      let consumed = true;
      for (const cell of line.cells) {
        const c = cell.trim();
        if (/^HP\b/i.test(c)) { fields.hp = digitize(c); lastField = "hp"; }
        else if (/^AC\b/i.test(c)) { fields.ac = digitize(c); lastField = "ac"; }
        else if (/^(Fortitude|Reflex|Will)\b/i.test(c) && lastField === "ac") fields.ac += ", " + digitize(c);
        else if (/^Speed\b/i.test(c)) { fields.speed = digitize(c); lastField = "speed"; }
        else if (/^Initiative\b/i.test(c)) { fields.initiative = digitize(c); lastField = "initiative"; }
        else if (/^Perception\b/i.test(c)) { fields.perception = digitize(c); lastField = "perception"; }
        else if (/^(Immune|Resist|Vulnerable)\b/i.test(c)) { fields.defense = (fields.defense ? fields.defense + "; " : "") + c; lastField = "defense"; }
        else if (/^Saving Throws?\b/i.test(c) || /^Action Points?\b/i.test(c)) {
          for (const part of c.split(/;\s*/)) {
            const st = /Saving Throws?\s*\+?(\d+)/i.exec(part), ap = /Action Points?\s*(\d+)/i.exec(part);
            if (st) stat.savingThrows = Number(digitize(st[1]));
            if (ap) stat.actionPoints = Number(digitize(ap[1]));
          }
          lastField = "saves";
        } else if (SENSE_RE.test(c) && c.length < 40) { (fields.senses ||= []).push(c); lastField = "senses"; }
        else consumed = false;
      }
      if (consumed) continue;
      phase = "body";
    }

    // ----- power header -----
    const ph = readPowerHeader(line.text);
    if (ph) {
      closeCurrent();
      current = { type: "power", name: ph.name, keywords: ph.keywords, frequency: ph.frequency, auraSize: ph.auraSize, tail: ph.tail, section: section || "standard", lines: [] };
      continue;
    }

    // ----- labelled body line / continuation -----
    const lab = readLabel(line.text);
    if (current && (lab || current.type === "power" || line.cells.length >= 1)) {
      if (current.type === "trait" && !lab && isTraitName(line.text, current)) { closeCurrent(); } else { current.lines.push(line.text.replace(/\t/g, " ").trim()); continue; }
    }

    // ----- new trait -----
    if (isTraitName(line.text, current)) {
      closeCurrent();
      current = { type: "trait", name: line.text.replace(/\t/g, " ").trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line.text.replace(/\t/g, " ").trim());
    else warnings.push(`unclassified line: ${line.text.slice(0, 60)}`);
  }
  closeCurrent();

  /* ---- stats ---- */
  if (isCreature) {
    if (fields.initiative) stat.initiative = num(/([+-]?\d+)/.exec(fields.initiative)?.[1]);
    if (fields.perception) { const m = /([+-]?\d+)/.exec(fields.perception); stat.perception = m ? num(m[1]) : null; }
    stat.senses = (fields.senses || []).map((s) => s.toLowerCase());
    if (fields.hp) Object.assign(stat, parseHP(fields.hp)); else warnings.push("no HP");
    if (fields.ac) Object.assign(stat, parseAC(fields.ac)); else warnings.push("no AC");
    if (fields.defense) Object.assign(stat, parseDefenseMods(fields.defense)); else Object.assign(stat, { immune: [], resist: [], vulnerable: [] });
    if (fields.speed) stat.speed = { raw: fields.speed, ...parseSpeed(fields.speed) }; else warnings.push("no Speed");
    Object.assign(stat, tail);
    if (/Healing Surges\s*(\d+)/i.test(stat.hpNote || "")) stat.healingSurges = num(/Healing Surges\s*(\d+)/i.exec(stat.hpNote)[1]);
    stat.abilities = {};
    abilityRows.slice(0, 6).forEach((m, k) => {
      const key = ABILITY_ORDER.includes(m.label) ? m.label : m.label === "wls" ? "wis" : ABILITY_ORDER[k];
      const half = Math.floor(block.level / 2);
      const fromMod = 2 * (m.mod - half) + 10;
      let score = m.score !== "" && /^\d{1,2}$/.test(digitize(m.score)) ? Number(digitize(m.score)) : null;
      if (score == null || Math.abs(score - fromMod) > 1) {
        if (score != null) warnings.push(`${key} score ${score} disagrees with modifier ${m.mod}; used ${fromMod}`);
        score = fromMod;
      }
      stat.abilities[key] = { score, mod: m.mod };
    });
    if (Object.keys(stat.abilities).length !== 6) warnings.push(`ability scores: found ${Object.keys(stat.abilities).length}/6`);
  }
  block.stats = stat;
  block.items = items;
  block.warnings = warnings;
  block.raw = lines.map((l) => l.text.replace(/\t/g, "  ")).join("\n");
  return block;
}

function isTraitName(text, current) {
  const t = text.replace(/\t/g, " ").trim();
  if (!t || t.length > 40 || /[.,:;]$/.test(t) || !/^[A-Z0-9]/.test(t)) return false;
  if (t.split(/\s+/).length > 6) return false;
  if (current) {
    const last = current.lines[current.lines.length - 1];
    if (last && !/[.)"]$/.test(last)) return false; // previous sentence still running
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* whole document                                                     */
/* ------------------------------------------------------------------ */

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Check one block's numbers against each other; returns warnings. */
export function validateBlock(b) {
  const w = [];
  const s = b.stats || {};
  if (b.kind !== "monster") return w;
  if (s.hp != null && s.bloodied != null && !s.minion && Math.floor(s.hp / 2) !== s.bloodied) w.push(`HP ${s.hp} and Bloodied ${s.bloodied} disagree`);
  if (s.hp == null && s.bloodied != null) { w.push(`HP unreadable; inferred ${s.bloodied * 2} from Bloodied (may be 1 higher)`); s.hp = s.bloodied * 2; }
  if (s.bloodied == null && s.hp != null && !s.minion) { s.bloodied = Math.floor(s.hp / 2); w.push("Bloodied unreadable; computed from HP"); }
  for (const k of ["ac", "fortitude", "reflex", "will"]) if (s[k] == null) w.push(`${k} missing`);
  return w;
}

/**
 * Merge repeated appearances of the same creature (the adventure prints a stat block in each encounter).
 * Keeps the occurrence with the fewest warnings and records disagreements between copies.
 */
export function mergeDuplicates(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const key = `${b.level}|${b.role}|${b.organization}|${b.stats?.hp ?? "?"}|${norm(b.name).slice(0, 5)}`;
    const keyLoose = `${b.level}|${b.role}|${b.organization}|${norm(b.name).slice(0, 5)}`;
    const gk = groups.has(key) ? key : [...groups.keys()].find((k) => k.endsWith(`|${norm(b.name).slice(0, 5)}`) && k.startsWith(`${b.level}|${b.role}|${b.organization}|`) && lev(k, key) <= 2) || key;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(b);
    void keyLoose;
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.warnings.length - b.warnings.length || b.items.length - a.items.length);
    const best = list[0];
    best.occurrences = list.map((b) => ({ ...b.source, name: b.name, count: b.count }));
    if (list.length > 1) {
      const diffs = [];
      for (const other of list.slice(1)) {
        for (const k of ["hp", "ac", "fortitude", "reflex", "will", "initiative"]) if (other.stats[k] != null && best.stats[k] != null && other.stats[k] !== best.stats[k]) diffs.push(`${k}: ${best.stats[k]} vs ${other.stats[k]} (p${other.source.page})`);
        if (other.items.length !== best.items.length) diffs.push(`power count ${best.items.length} vs ${other.items.length} (p${other.source.page})`);
      }
      if (diffs.length) best.warnings.push(`copies disagree: ${[...new Set(diffs)].join("; ")}`);
    }
    out.push(best);
  }
  return out;
}

const PLURAL_RULES = [[/ies$/i, "y"], [/ves$/i, "f"], [/(s|x|ch|sh)es$/i, "$1"], [/men$/i, "man"], [/s$/i, ""]];
function singularGuess(name) {
  const words = name.split(" ");
  const last = words[words.length - 1];
  if (/(fish|sheep|deer|cobras?)$/i.test(last) && !/cobras$/i.test(last)) return name;
  for (const [re, rep] of PLURAL_RULES) if (re.test(last)) { words[words.length - 1] = last.replace(re, rep); return words.join(" "); }
  return name;
}

/**
 * Header names are plural ("3 Orc Reavers") and OCR-damaged ("Ore" for "Orc"). The block's own rules text
 * refers to the creature in the singular ("The orc reaver gains..."), usually read correctly, so use it.
 */
export function refineName(b) {
  const guess = b.count && b.count > 1 || /s$/i.test(b.name) ? singularGuess(b.name) : b.name;
  const text = b.items.map((i) => i.text).join(" ");
  const n = guess.split(" ").length;
  const freq = new Map();
  for (const m of text.matchAll(/\b[Tt]he ((?:[a-z][a-z'-]+ ){0,4}[a-z][a-z'-]+)/g)) {
    const words = m[1].split(" ");
    for (let len = Math.max(1, n - 1); len <= n + 1; len++) {
      if (words.length >= len) { const ph = words.slice(0, len).join(" "); freq.set(ph, (freq.get(ph) || 0) + 1); }
    }
  }
  let best = null, bd = 99, bc = 0;
  for (const [ph, c] of freq) {
    const d = lev(ph, guess.toLowerCase());
    if (d <= 2 && (d < bd || (d === bd && c > bc))) { best = ph; bd = d; bc = c; }
  }
  if (best && bd > 0 && best.split(" ").length === n) {
    b.warnings.push(`name "${b.name}" corrected to "${titleCase(best)}" using the block's own text`);
    return titleCase(best);
  }
  if (best && bd === 0) return guess;
  return guess;
}

/** Parse every stat block found in the pages. pages: [{ lines }] from layoutLines. */
export function parseAdventurePages(pages, opts = {}) {
  const all = [];
  const skipped = [];
  pages.forEach((page, pi) => {
    for (const range of findAdventureBlocks(page.lines)) {
      const slice = page.lines.slice(range.start, range.end + 1);
      const meta = { page: pi + 1, col: slice[0].col, y: Math.round(slice[0].y0 ?? 0) };
      const b = parseAdventureBlock(slice, meta);
      if (b.kind !== "monster") { skipped.push({ name: b.name, level: b.level, role: b.role, page: meta.page, reason: `not a creature (${b.otherType || "no type line"})` }); continue; }
      if (!range.aligned) b.warnings.push("block end not found (no Alignment line)");
      b.warnings.push(...validateBlock(b));
      all.push(b);
    }
  });
  for (const b of all) { b.headerName = b.name; b.name = refineName(b); b.baseName = b.name; }
  const blocks = opts.mergeDuplicates === false ? all : mergeDuplicates(all);
  return { blocks, skipped, found: all.length };
}
