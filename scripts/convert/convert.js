/**
 * Parsed 4e block -> Draw Steel NPC actor data (the shape Actor.create / actor.json expects).
 * Pure function; pass `rid` (e.g. foundry.utils.randomID) to get Foundry-style ids.
 */
import * as T from "./tables.js";
import { buildAbility, buildFeature, planPowers } from "./abilities.js";

const FLAG = "4e-converter";
const CHARACTERISTICS = ["might", "agility", "reason", "intuition", "presence"];
const FROM_4E = { might: "str", agility: "dex", reason: "int", intuition: "wis", presence: "cha" };
const DS_DAMAGE_KEYS = ["acid", "cold", "corruption", "fire", "holy", "lightning", "poison", "psychic", "sonic"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function defaultRid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Infer a Draw Steel role for 4e minions, which print no role in the Monster Manual. */
function inferMinionRole(block) {
  const powers = block.items.filter((i) => i.kind === "power");
  const ranged = powers.filter((p) => p.icon === "r" || p.icon === "R").length;
  if (ranged > powers.length / 2) return "artillery";
  if (powers.some((p) => /\bshift/i.test(p.text))) return "harrier";
  return "brute";
}

function deriveCharacteristics(block, highest) {
  const ab = block.stats.abilities;
  const scores = {};
  for (const k of CHARACTERISTICS) scores[k] = ab[FROM_4E[k]]?.score ?? 10;
  const top = Math.max(...Object.values(scores));
  const out = {};
  for (const k of CHARACTERISTICS) out[k] = Math.max(-1, highest - Math.min(2, Math.floor((top - scores[k]) / 5)));
  return out;
}

function buildMovement(block, opts) {
  const sp = block.stats.speed || { walk: 6, modes: [] };
  const notes = [];
  if (!block.stats.speed) notes.push("speed was not found in the source; 6 assumed");
  const types = [];
  let value = null;
  if (sp.walk != null) { types.push("walk"); value = T.dsSpeed(sp.walk, opts); }
  let hover = false;
  for (const m of sp.modes) {
    const mode = m.mode.toLowerCase();
    const mapped = Object.prototype.hasOwnProperty.call(T.MOVEMENT_MODES, mode) ? T.MOVEMENT_MODES[mode] : undefined;
    if (mapped === undefined || mapped === null) { notes.push(`movement "${m.mode}${m.speed ? " " + m.speed : ""}" not mapped`); continue; }
    if (!types.includes(mapped)) types.push(mapped);
    if (value == null && m.speed != null) value = T.dsSpeed(m.speed, opts);
    if (mapped === "fly" && /hover/.test(m.notes || "")) hover = true;
  }
  if (sp.note) notes.push(`speed note: ${sp.note}`);
  if (value == null) { value = T.dsSpeed(6, opts); notes.push("no speed parsed; default used"); }
  if (!types.length) types.push("walk");
  return { movement: { value, types, hover, disengage: 1 }, notes };
}

function buildDamageMods(block, dsLvl) {
  const immunities = Object.fromEntries(["all", ...DS_DAMAGE_KEYS].map((k) => [k, 0]));
  const weaknesses = { ...immunities };
  const notes = [];
  const scale = (amount) => Math.max(1, Math.ceil((amount * dsLvl) / block.level));
  const key = (type) => {
    const t = String(type).toLowerCase().trim();
    const mapped = T.DAMAGE_TYPE[t];
    if (mapped) return mapped;
    if (t === "all") return "all";
    return null;
  };
  for (const imm of block.stats.immune || []) {
    const t = typeof imm === "string" ? imm : imm.type;
    const k = key(t);
    if (k) immunities[k] = Math.max(immunities[k], dsLvl);
    else notes.push(`immunity "${t}" has no damage-type equivalent`);
  }
  for (const r of block.stats.resist || []) {
    const k = key(r.type);
    if (k && r.amount) immunities[k] = Math.max(immunities[k], scale(r.amount));
    else notes.push(`resist ${r.amount ?? ""} ${r.type} not mapped`);
  }
  for (const v of block.stats.vulnerable || []) {
    const k = key(v.type);
    if (k && v.amount) weaknesses[k] = Math.max(weaknesses[k], scale(v.amount));
    else notes.push(`vulnerable ${v.amount ?? ""} ${v.type} not mapped`);
  }
  return { immunities, weaknesses, notes };
}

function buildKeywords(block) {
  const out = new Set();
  const add = (w) => { if (w) out.add(T.KEYWORD_MAP[w.toLowerCase()] ?? w.toLowerCase()); };
  const mappedOnly = (w) => { if (w && T.KEYWORD_MAP[w.toLowerCase()]) out.add(T.KEYWORD_MAP[w.toLowerCase()]); };
  if (T.KEYWORD_MAP[(block.type || "").toLowerCase()]) mappedOnly(block.type);
  else for (const w of (block.type || "").split(/\s+/)) mappedOnly(w);
  for (const k of block.typeKeywords || []) add(k);
  if (block.origin === "fey" || block.origin === "elemental") add(block.origin);
  return [...out];
}

/** Returns { actor, report }. The actor carries no 4e references; the report holds review notes. */
export function convertBlockDetailed(block, options = {}) {
  const opts = { ...T.DEFAULT_OPTIONS, ...options, maliceCost: { ...T.DEFAULT_OPTIONS.maliceCost, ...(options.maliceCost || {}) } };
  opts.source = { book: opts.sourceBook, page: "", license: "" };
  const rid = opts.rid || defaultRid;
  const review = [];

  const level = options.levelOverride ?? T.dsLevel(block.level, opts);
  const org = T.dsOrganization(block, opts);
  let role = org === "solo" ? "solo" : T.ROLE_FROM_4E[block.role];
  if (!role) { role = inferMinionRole(block); review.push(`4e minion prints no role; inferred ${role}`); }
  if (org === "solo" && block.role) review.push(`4e solo ${block.role} becomes a Draw Steel solo; original role kept in flags`);
  if (block.leader) {
    // a 4e leader buffs and directs its allies, which a Draw Steel controller does best
    if (org !== "solo" && role !== "controller") { review.push(`4e leader (${block.role || "no role"}) becomes a controller`); role = "controller"; }
  }
  if (block.organization === "standard" && opts.standardAs === "platoon") review.push("4e standard monster mapped to platoon; horde is also reasonable for weak monsters");

  const statRole = T.statRole(org, role);
  const highest = T.highestCharacteristic(level, org);
  const characteristics = deriveCharacteristics(block, highest);
  const highestKey = CHARACTERISTICS.reduce((a, b) => (characteristics[b] > characteristics[a] ? b : a));
  const potency = T.potency(level, org);
  const ds = { level, org, role, statRole, targets: T.ORGANIZATION[org].targets };
  const ctx = { ds, opts, characteristics, highestKey, potency, rid };

  const size = T.SIZE[block.size] ?? T.SIZE.medium;
  const { movement, notes: moveNotes } = buildMovement(block, opts);
  review.push(...moveNotes);
  const { immunities, weaknesses, notes: dmgNotes } = buildDamageMods(block, level);
  review.push(...dmgNotes);

  const items = [];
  const plans = planPowers(block, ctx);
  for (const it of block.items) {
    if (it.kind === "power") items.push(buildAbility(it, ctx, plans.get(it)));
    else items.push(buildFeature(it, ctx));
  }
  const itemNotes = items.map((it) => ({ name: it.name, notes: it.flags[FLAG].notes || [] }));
  for (const { name, notes } of itemNotes) for (const n of notes) if (/no mechanics|no Draw Steel equivalent|not mapped/.test(n)) review.push(`${name}: ${n}`);
  for (const it of items) { it.flags = {}; if (it.system && "story" in it.system) it.system.story = ""; }

  const actor = {
    name: block.name,
    type: "npc",
    img: T.ICONS.actor,
    system: {
      stamina: { value: T.stamina(level, org, role), max: T.stamina(level, org, role), temporary: 0 },
      characteristics: Object.fromEntries(CHARACTERISTICS.map((k) => [k, { value: characteristics[k] }])),
      combat: { save: { threshold: 6, bonus: "" }, size: { ...size }, stability: T.stabilityFromSize(block.size), turns: 1 },
      movement,
      damage: { immunities, weaknesses },
      biography: { value: "", director: "", languages: [] },
      source: { ...opts.source },
      negotiation: { interest: 5, patience: 5, motivations: [], pitfalls: [], impression: 1 },
      monster: { freeStrike: T.freeStrike(level, org, role), keywords: buildKeywords(block), level, role, organization: org, withCaptainEffect: null },
      ev: T.encounterValue(level, org),
      statuses: { immunities: [] }
    },
    items,
    effects: [],
    flags: {}
  };
  return { actor, report: { name: block.name, level4e: block.level, review, itemNotes } };
}

export function convertBlock(block, options = {}) {
  return convertBlockDetailed(block, options).actor;
}

export function convertAll(blocks, options = {}) {
  return blocks.map((b) => convertBlock(b, options));
}

export function convertAllDetailed(blocks, options = {}) {
  return blocks.map((b) => convertBlockDetailed(b, options));
}
