/**
 * 4e power/trait/aura -> Draw Steel ability and feature item data.
 * Output follows the item shape of Draw Steel 1.1.2 exports. Powers are *drafts*:
 * every converted ability carries flags["4e-converter"] with the original 4e text and review notes.
 */
import * as T from "./tables.js";
import { rewriteText } from "./text.js";

const FLAG = "4e-converter";
const esc = (s) => rewriteText(String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const slug = (s) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const scaled = (n, scale, min = 1) => Math.max(min, Math.ceil(n * scale));

const MAGIC_KEYWORDS = new Set(["acid", "charm", "cold", "fear", "fire", "gaze", "healing", "illusion", "lightning", "necrotic", "poison", "psychic", "radiant", "teleportation", "thunder", "zone", "rattling", "sleep", "polymorph", "stance"]);

function baseSystem(ctx, name) {
  return {
    source: { ...ctx.opts.source },
    _dsid: "",
    story: "",
    advancements: {},
    prerequisites: { value: "", dsid: [], level: null }
  };
}

/* ------------------------------ features ------------------------------ */

export function buildFeature(item, ctx) {
  const notes = [];
  let html = "";
  if (item.kind === "aura") {
    const size = T.DEFAULT_OPTIONS && item.auraSize != null ? scaled(item.auraSize, ctx.opts.rangeScale) : null;
    html += `<p><strong>${esc(item.name)} (Aura ${size ?? "?"}): </strong>${esc(item.text)}</p>`;
    notes.push(`4e aura ${item.auraSize} squares scaled to ${size}`);
  } else {
    html += `<p><strong>${esc(item.name)}: </strong>${esc(item.text)}</p>`;
  }
  notes.push("4e rules text carried over verbatim; rewrite in Draw Steel terms");
  return {
    name: rewriteText(item.name),
    type: "feature",
    img: T.ICONS.feature,
    system: {
      description: { value: html, director: "" },
      source: { ...ctx.opts.source },
      _dsid: "",
      advancements: {},
      prerequisites: { value: "", dsid: [], level: null }
    },
    effects: [],
    flags: { [FLAG]: { kind: item.kind, original: item.text, keywords: item.keywords, notes } }
  };
}

/* ------------------------------- abilities ------------------------------- */

function mapDamageTypes(types, notes) {
  const out = [];
  for (const t of types || []) {
    const key = t.toLowerCase();
    if (!(key in T.DAMAGE_TYPE)) continue;
    const mapped = T.DAMAGE_TYPE[key];
    if (mapped) out.push(mapped);
    else notes.push(`damage type "${key}" has no Draw Steel equivalent (left untyped)`);
  }
  return [...new Set(out)];
}

function distanceAndTarget(power, ctx, notes) {
  const r = power.body.range;
  const scale = ctx.opts.rangeScale;
  const targets = ctx.ds.targets;
  const one = { type: "creatureObject", value: targets, custom: "" };
  const area = { type: "enemy", value: null, custom: "Each enemy in the area" };
  const self = { type: "self", value: null, custom: "" };
  const dist = (type, primary, secondary = 1, tertiary = 1) => ({ type, primary: String(primary), secondary: String(secondary), tertiary: String(tertiary) });

  if (r) {
    switch (r.kind) {
      case "reach":
        return { distance: dist("melee", scaled(r.size ?? 1, ctx.opts.reachScale)), target: one, strike: true, kind: "melee" };
      case "melee":
      case "melee touch":
        return { distance: dist("melee", 1), target: one, strike: true, kind: "melee" };
      case "ranged":
        return { distance: dist("ranged", scaled(r.size ?? 5, scale)), target: one, strike: true, kind: "ranged" };
      case "close burst":
        return { distance: dist("burst", scaled(r.size ?? 1, scale)), target: area, strike: false, kind: "area" };
      case "close blast":
        return { distance: dist("cube", scaled(r.size ?? 3, scale, 2), 1), target: area, strike: false, kind: "area" };
      case "area burst": {
        const side = 2 * scaled(r.size ?? 1, scale) + 1;
        return { distance: dist("cube", side, scaled(r.within ?? 10, scale)), target: area, strike: false, kind: "area" };
      }
      case "area wall":
        return { distance: dist("cube", scaled(r.size ?? 3, scale, 2), scaled(r.within ?? 10, scale)), target: area, strike: false, kind: "area" };
      case "personal":
        return { distance: dist("self", 1), target: self, strike: false, kind: "self" };
    }
  }
  // fall back to the icon
  switch (power.icon) {
    case "m": case "M": return { distance: dist("melee", 1), target: one, strike: true, kind: "melee" };
    case "r": case "R": case "RM": return { distance: dist("ranged", scaled(10, scale)), target: one, strike: true, kind: "ranged" };
    case "C": notes.push("close power with no parsed size; burst 1 assumed"); return { distance: dist("burst", 1), target: area, strike: false, kind: "area" };
    case "A": notes.push("area power with no parsed size; cube assumed"); return { distance: dist("cube", 3, scaled(10, scale)), target: area, strike: false, kind: "area" };
  }
  return { distance: dist("self", 1), target: self, strike: false, kind: "self" };
}

function dsActionType(power, notes) {
  const u = power.usage || {};
  switch (u.action) {
    case "standard": return "main";
    case "move": case "minor": return "maneuver";
    case "free": return u.trigger ? "freeTriggered" : "maneuver";
    case "immediate reaction": case "immediate interrupt": case "opportunity": return "triggered";
    case "no action": return "none";
  }
  notes.push("no action type recognised; defaulted to main");
  return "main";
}

function pickRollCharacteristic(power, ctx, kind) {
  const c = ctx.characteristics;
  const best = (keys) => keys.reduce((a, b) => (c[b] > c[a] ? b : a), keys[0]);
  const keywords = (power.keywords || []).map((k) => k.toLowerCase());
  const magical = keywords.some((k) => MAGIC_KEYWORDS.has(k)) && !keywords.includes("weapon");
  if (magical) return best(["intuition", "presence", "reason"]);
  if (kind === "ranged") return best(["agility", "might"]);
  return best(["might", "agility"]);
}

function abilityKeywords(power, built) {
  const kws = new Set();
  const lc = (power.keywords || []).map((k) => k.toLowerCase());
  if (built.kind === "melee") kws.add("melee");
  if (built.kind === "ranged") kws.add("ranged");
  if (built.kind === "area") kws.add("area");
  if (built.strike) kws.add("strike");
  if (lc.includes("weapon") || ((power.icon === "m" || power.icon === "M") && !lc.length)) kws.add("weapon");
  if (lc.some((k) => MAGIC_KEYWORDS.has(k)) && !lc.includes("weapon")) kws.add("magic");
  if (lc.includes("charge")) kws.add("charge");
  return [...kws].sort();
}

function tierDamage(ctx, built, types) {
  const out = {};
  for (let t = 1; t <= 3; t++) {
    let v = T.baseDamage(ctx.ds.level, ctx.ds.org, ctx.ds.statRole, t);
    if (built.kind === "area") v = Math.ceil(v * ctx.opts.areaDamageMultiplier);
    if (built.strike) v += ctx.characteristics[ctx.highestKey];
    out[`tier${t}`] = {
      value: String(v),
      types,
      potency: { value: t === 1 ? "@potency.weak" : t === 2 ? "@potency.average" : "@potency.strong", characteristic: t === 1 ? "none" : "" },
      ignoredImmunities: []
    };
  }
  return out;
}

function appliedEffect(condKey, power, ctx, potencyKey) {
  const endsOnSave = power.body.saveEnds;
  const untilTurn = /until the end of (?:the|its|his|her|their)[^.;]*?next turn/i.test(power.text);
  const end = endsOnSave ? "save" : untilTurn ? "turn" : "";
  const pot = ctx.potency;
  const tier = (v) => ({
    display: "",
    effects: { [condKey]: end ? { condition: "failure", end, properties: [] } : { condition: "always", end: "", properties: [] } },
    potency: { value: String(v), characteristic: potencyKey }
  });
  return { type: "applied", name: cap(condKey), img: null, sort: 0, applied: { tier1: tier(pot[0]), tier2: tier(pot[1]), tier3: tier(pot[2]) } };
}

function forcedEffect(fm, ctx, potencyKey) {
  const d = scaled(fm.squares, ctx.opts.rangeScale);
  const dists = [Math.max(1, d - 1), d, d + 1];
  const tier = (i) => ({
    movement: [fm.kind],
    distance: String(dists[i]),
    display: "{{forced}}",
    properties: [],
    potency: { value: String(ctx.potency[i]), characteristic: potencyKey }
  });
  return { type: "forced", name: fm.kind, img: null, sort: 0, forced: { tier1: tier(0), tier2: tier(1), tier3: tier(2) } };
}

function textEffects(power, hasMechanics) {
  const s = power.body.sections;
  const parts = [];
  if (s) {
    for (const key of ["requirement", "special", "trigger", "effect", "miss", "aftereffect", "firstFailedSave", "secondFailedSave", "secondaryAttack", "secondaryTarget", "primaryTarget"]) {
      if (s[key]) parts.push(`<p><strong>${esc(key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()))}: </strong>${esc(s[key])}</p>`);
    }
    if (!hasMechanics && s.lead) parts.unshift(`<p>${esc(s.lead)}</p>`);
  } else if (!hasMechanics && power.text) {
    parts.push(`<p>${esc(power.text)}</p>`);
  }
  return parts.join("");
}


/* ------------------- staged effects -> target-rolled, tiered ------------------- */

/**
 * Powers with "First Failed Save / Second Failed Save / Aftereffect" become reactive abilities:
 * each target makes a test, and lower results (tier 1) carry progressively heavier consequences.
 * This follows the shape of the Draw Steel reactive abilities (roll.reactive = true, tier 1 = worst).
 */
export function isStaged(power, built) {
  const s = power.body.sections;
  if (!s) return false;
  if (s.firstFailedSave || s.secondFailedSave) return true;
  // Aftereffect alone only becomes a tiered test for non-strike powers (bursts, blasts, gazes);
  // a plain weapon strike with an aftereffect keeps its power roll.
  return !!s.aftereffect && !built?.strike;
}

const RANGE_SEG = /^(Reach|Ranged|Close (?:burst|blast)|Area (?:burst|wall)|Melee)\b/i;
const ATTACK_SEG = /^\+\d+\s+vs\.?\s+(?:AC|Fortitude|Reflex|Will)\b/i;
const TARGETS_SEG = /^targets?\b/i;

/** Remove range/attack-roll/targeting clauses from the lead text; keep requirement and effect separate. */
function splitLead(lead) {
  const segs = (lead || "").split(/;\s*/).map((x) => x.trim()).filter(Boolean);
  const requirement = [];
  const effect = [];
  for (const seg of segs) {
    if (RANGE_SEG.test(seg) || ATTACK_SEG.test(seg) || TARGETS_SEG.test(seg)) continue;
    if (/^only (?:affects|works)/i.test(seg)) requirement.push(seg);
    else effect.push(seg);
  }
  return { requirement: requirement.join("; "), effect: effect.join("; ") };
}

/** Make a 4e effect sentence read in Draw Steel terms: drop the damage clause, ongoing damage -> bleeding. */
function simplifyEffect(text) {
  let t = (text || "").trim();
  t = t.replace(/^(?:\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s+(?:[a-z]+(?:,\s*|\s+and\s+|\s+or\s+))*[a-z]*\s*damage\s*(?:,\s*(?:and\s+)?|\s+and\s+|\s*$)/i, "");
  t = t.replace(/\b(takes|take)\s+ongoing\s+\d+\s+(?:[a-z]+\s+)?damage\b/gi, "is bleeding").replace(/\bongoing\s+\d+\s+(?:[a-z]+\s+)?damage\b/gi, "bleeding");
  t = t.replace(/\(save ends (?:both|all)\)/gi, "(save ends)");
  t = t.replace(/\s+/g, " ").trim();
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t;
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Three tier texts, tier 3 = mildest ... tier 1 = harshest (lower rolls hurt more). */
function stageTexts(power) {
  const s = power.body.sections;
  const { requirement, effect } = splitLead(s.lead);
  const lead = simplifyEffect(effect);
  const first = s.firstFailedSave ? simplifyEffect(s.firstFailedSave) : "";
  const second = s.secondFailedSave ? simplifyEffect(s.secondFailedSave) : "";
  const after = s.aftereffect ? simplifyEffect(s.aftereffect) : "";
  const join = (...parts) => parts.filter(Boolean).join(" ");
  let t3, t2, t1;
  if (first || second) {
    t3 = lead;
    t2 = join(lead, first);
    t1 = join(lead, first, second, after && `Aftereffect: ${after}`);
  } else {
    t3 = after;
    t2 = lead;
    t1 = join(lead, `Afterward, ${lowerFirst(after)}`);
  }
  return { requirement, texts: [t1, t2, t3].map(rewriteText) };
}

function endFromText(t) {
  if (/\(save ends/i.test(t)) return "save";
  if (/until the end of (?:the|its|his|her|their)[^.;]*?next turn/i.test(t)) return "turn";
  return "";
}

function conditionsInText(t) {
  const found = new Set();
  for (const c of [...Object.keys(T.CONDITION), "bleeding"]) {
    if (!new RegExp(`\\b${c}\\b`, "i").test(t)) continue;
    const mapped = c === "bleeding" ? "bleeding" : T.CONDITION[c];
    if (mapped) found.add(mapped);
  }
  return [...found];
}

const TOKENS = [
  { value: "@potency.weak", characteristic: "none" },
  { value: "@potency.average", characteristic: "" },
  { value: "@potency.strong", characteristic: "" }
];

const TEST_CHARACTERISTICS = {
  will: ["reason", "intuition", "presence"],
  fortitude: ["might"],
  reflex: ["agility"],
  ac: ["might", "agility"]
};

function buildStagedAbility(power, ctx, plan, built, type, notes) {
  const defense = power.body.attacks[0]?.defense ?? "will";
  const keys = TEST_CHARACTERISTICS[defense] ?? TEST_CHARACTERISTICS.will;
  const effects = {};
  const addEffect = (e) => { const id = ctx.rid(); effects[id] = { _id: id, ...e }; };
  const { requirement, texts } = stageTexts(power);

  // damage: tier 1 (lowest test result) deals the most; no characteristic bonus because it is not a strike
  if (power.body.damage.length) {
    const types = mapDamageTypes(power.body.damage.flatMap((d) => d.types), notes);
    const base = [3, 2, 1].map((t) => {
      let v = T.baseDamage(ctx.ds.level, ctx.ds.org, ctx.ds.statRole, t);
      if (built.kind === "area") v = Math.ceil(v * ctx.opts.areaDamageMultiplier);
      return v;
    });
    const damage = {};
    base.forEach((v, i) => { damage[`tier${i + 1}`] = { value: String(v), types, potency: { ...TOKENS[i] }, ignoredImmunities: [] }; });
    addEffect({ type: "damage", name: "", img: null, sort: 100000, damage });
  }

  // forced movement: tier 1 moves the target the furthest
  const forced = power.body.forcedMovement.filter((f) => ["push", "pull", "slide"].includes(f.kind));
  forced.forEach((fm, n) => {
    const d = scaled(fm.squares, ctx.opts.rangeScale);
    const dists = [d + 1, d, Math.max(1, d - 1)];
    const f = {};
    dists.forEach((dist, i) => { f[`tier${i + 1}`] = { movement: [fm.kind], distance: String(dist), display: "{{forced}}", properties: [], potency: { ...TOKENS[i] } }; });
    addEffect({ type: "forced", name: fm.kind, img: null, sort: 150000 + n, forced: f });
  });

  // consequences: tier 1 = everything, tier 3 = mildest
  const applied = {};
  texts.forEach((text, i) => {
    const conds = {};
    for (const key of conditionsInText(text)) conds[key] = { condition: "always", end: endFromText(text), properties: [] };
    applied[`tier${i + 1}`] = { display: text, effects: conds, potency: { ...TOKENS[i] } };
  });
  addEffect({ type: "applied", name: "", img: null, sort: 200000, applied });

  const before = [`<p>Each target makes a ${keys.length === 1 ? keys[0] : keys.join(", ")} test${keys.length > 1 ? " using their highest of those characteristics" : ""}.</p>`];
  if (requirement) before.push(`<p>${esc(cap(requirement.replace(/\.$/, "")))}.</p>`);
  const s = power.body.sections;
  const after = [];
  for (const key of ["special", "requirement", "effect", "miss", "secondaryAttack", "secondaryTarget", "primaryTarget"]) {
    if (s[key]) after.push(`<p><strong>${esc(cap(key.replace(/([A-Z])/g, " $1")))}: </strong>${esc(s[key])}</p>`);
  }
  const itemEffects = { before0000000000: { _id: "before0000000000", type: "base", description: before.join(""), before: true, name: "", img: null, sort: 0 } };
  if (after.length) itemEffects.after00000000000 = { _id: "after00000000000", type: "base", description: after.join(""), name: "", img: null, sort: 0, before: false };

  const usage = power.usage || {};
  notes.push("failed-save stages converted to a target-rolled test with tiered consequences (tier 1 harshest)");
  if (plan.note) notes.push(plan.note);
  if (usage.recharge?.faces) notes.push(`4e recharge ${usage.recharge.faces.join("-")}; now ${plan.resource ? plan.resource + " malice" : type === "villain" ? "a villain action" : "a free ability"}`);
  if (usage.recharge?.when) notes.push(`4e recharge condition: ${usage.recharge.when}`);

  const system = {
    ...baseSystem(ctx, power.name),
    type,
    category: plan.category,
    keywords: abilityKeywords(power, { ...built, strike: false }),
    distance: built.distance,
    target: built.target,
    damageDisplay: "melee",
    power: { roll: { formula: "", characteristics: keys, reactive: true }, effects },
    resource: plan.resource ?? null,
    trigger: usage.trigger ? cap(rewriteText(usage.trigger).replace(/\.$/, "")) + "." : "",
    effects: itemEffects
  };
  return {
    name: rewriteText(power.name),
    type: "ability",
    img: T.ICONS[type] ?? T.ICONS.main,
    system,
    effects: [],
    flags: { [FLAG]: { kind: "power", icon: power.icon, usage: power.usage?.raw, keywords: power.keywords, original: power.text, review: true, notes } }
  };
}

/**
 * @param power parsed 4e power item
 * @param ctx   { ds:{level,org,role,statRole,targets}, opts, characteristics, highestKey, potency, rid }
 * @param plan  { category, resource, type } decisions made across the whole stat block
 */
export function buildAbility(power, ctx, plan) {
  const notes = [];
  const type = plan.type ?? dsActionType(power, notes);
  const built = distanceAndTarget(power, ctx, notes);
  // self-targeted powers ("deals an extra 1d6 damage on the next attack") have no power roll of their own
  const targeted = built.kind !== "self";
  if (targeted && isStaged(power, built)) return buildStagedAbility(power, ctx, plan, built, type, notes);
  const hasAttack = targeted && power.body.attacks.length > 0;
  const hasDamage = targeted && power.body.damage.length > 0;
  const rollKey = pickRollCharacteristic(power, ctx, built.kind);

  const defense = power.body.attacks[0]?.defense ?? "will";
  const potencyKey = T.DEFENSE_TO_CHARACTERISTIC[defense];
  const effects = {};
  const addEffect = (e) => { const id = ctx.rid(); effects[id] = { _id: id, ...e }; };

  if (hasDamage) {
    const types = mapDamageTypes(power.body.damage.flatMap((d) => d.types), notes);
    addEffect({ type: "damage", name: "", img: null, sort: 0, damage: tierDamage(ctx, built, types) });
  }
  for (const fm of power.body.forcedMovement.filter((f) => targeted && ["push", "pull", "slide"].includes(f.kind))) addEffect(forcedEffect(fm, ctx, potencyKey));
  const condKeys = new Set();
  for (const c of power.body.conditions) {
    const mapped = T.CONDITION[c];
    if (mapped === null) notes.push(`condition "${c}" has no Draw Steel equivalent (see 4e text)`);
    else if (mapped && !condKeys.has(mapped)) { condKeys.add(mapped); if (targeted && (hasAttack || power.body.saveEnds || hasDamage)) addEffect(appliedEffect(mapped, power, ctx, potencyKey)); }
    if (c === "stunned") notes.push('"stunned" mapped to dazed; check intent');
  }
  if (targeted && power.body.ongoing.length) {
    if (!condKeys.has("bleeding")) { condKeys.add("bleeding"); addEffect(appliedEffect("bleeding", power, ctx, potencyKey)); }
    notes.push("4e ongoing damage approximated as bleeding");
  }

  const hasMechanics = hasAttack || hasDamage || Object.keys(effects).length > 0;
  const html = textEffects(power, hasMechanics);
  const itemEffects = {};
  if (html) itemEffects.after00000000000 = { _id: "after00000000000", type: "base", description: html, name: "", img: null, sort: 0, before: false };
  if (!hasMechanics) notes.push("no mechanics recognised; 4e text carried over as description");

  const usage = power.usage || {};
  const roll = hasAttack || hasDamage
    ? { formula: "@chr", characteristics: [rollKey], reactive: false }
    : { formula: "", characteristics: [], reactive: false };

  const system = {
    ...baseSystem(ctx, power.name),
    type,
    category: plan.category,
    keywords: abilityKeywords(power, built),
    distance: built.distance,
    target: built.target,
    damageDisplay: "melee",
    power: { roll, effects },
    resource: plan.resource ?? null,
    trigger: usage.trigger ? cap(rewriteText(usage.trigger).replace(/\.$/, "")) + "." : "",
    effects: itemEffects
  };

  if (plan.note) notes.push(plan.note);
  if (usage.recharge?.faces) notes.push(`4e recharge ${usage.recharge.faces.join("-")}; now ${plan.resource ? plan.resource + " malice" : type === "villain" ? "a villain action" : "a free ability"}`);
  if (usage.recharge?.when) notes.push(`4e recharge condition: ${usage.recharge.when}`);

  return {
    name: rewriteText(power.name),
    type: "ability",
    img: T.ICONS[type] ?? T.ICONS.main,
    system,
    effects: [],
    flags: { [FLAG]: { kind: "power", icon: power.icon, usage: power.usage?.raw, keywords: power.keywords, original: power.text, review: true, notes } }
  };
}

/* --------------------- planning across the whole block --------------------- */

/** Decide signature / villain / malice assignment for every power in the block. */
export function planPowers(block, ctx) {
  const powers = block.items.filter((i) => i.kind === "power");
  const plans = new Map();
  let signatureTaken = false;
  let villainCount = 0;
  const cost = ctx.opts.maliceCost;
  // Solo villain actions: prefer area powers, then damaging powers, in book order.
  const score = (p) => (/^(C|A)$/.test(p.icon || "") ? 2 : 0) + (p.body.damage.length ? 1 : 0) + (p.body.conditions.length ? 0.5 : 0);
  const villains = new Set(
    powers
      .filter((p) => ["encounter", "daily", "recharge"].includes(p.usage?.frequency) && dsActionType(p, []) === "main" && ctx.ds.org === "solo")
      .map((p, i) => ({ p, i, s: score(p) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, ctx.opts.maxVillainActions)
      .map((x) => x.p)
  );

  for (const p of powers) {
    const u = p.usage || {};
    const notes = [];
    const actionType = dsActionType(p, []);
    const atWill = u.frequency === "at-will" || !u.frequency;
    const limited = ["encounter", "daily", "recharge"].includes(u.frequency);
    const isAttackMain = actionType === "main" && (p.body.attacks.length > 0 || p.body.damage.length > 0);
    const plan = { type: actionType, category: "", resource: null };

    if (atWill && isAttackMain && !signatureTaken) {
      plan.category = "signature";
      signatureTaken = true;
    } else if (atWill && actionType === "main") {
      notes.push("extra at-will main action; consider making it a malice ability");
    } else if (limited) {
      if (villains.has(p)) {
        plan.type = "villain";
        plan.category = "villain";
        villainCount++;
        notes.push("solo encounter/recharge power converted to a villain action");
      } else {
        plan.resource = cost[u.frequency] ?? cost.encounter;
        notes.push(`${u.frequency} power converted to a ${plan.resource}-malice ability`);
      }
    }
    if (notes.length) plan.note = notes.join("; ");
    plans.set(p, plan);
  }
  return plans;
}
