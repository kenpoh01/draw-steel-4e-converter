/**
 * Mapping tables and Draw Steel monster-math formulas.
 * Formulas come from the Draw Steel "Monster Basics" rules; every value here is data you can tune.
 * Pure functions, no Foundry dependency.
 */

export const DEFAULT_OPTIONS = {
  levelDivisor: 3, // DS level = ceil(4e level / 3)
  minLevel: 1,
  maxLevel: 10,
  standardAs: "platoon", // 4e standard -> "platoon" | "horde"
  rangeScale: 0.5, // 4e squares -> DS squares for ranged/area/burst sizes
  reachScale: 1,
  maliceCost: { recharge: 3, encounter: 5, daily: 7 },
  maxVillainActions: 3,
  areaDamageMultiplier: 1,
  immunityFromImmune: "level", // 4e "Immune X" -> immunity value = DS level
  speedScale: 5 / 6, // 4e speed 6 -> DS speed 5
  sourceBook: "Monster Manual", // the 4e book the stat blocks came from; the UI will set this later
};

/* ---------------------------- level ---------------------------- */

export function dsLevel(level4e, opts = DEFAULT_OPTIONS) {
  const l = Math.ceil(level4e / opts.levelDivisor);
  return Math.min(opts.maxLevel, Math.max(opts.minLevel, l));
}

export const echelon = (level) => (level >= 10 ? 4 : Math.ceil(level / 3));

/* ------------------- organization / role tables ------------------- */

// ev: Encounter Value modifier; stamina: Stamina modifier; damageDiv: horde/minion halve ability damage
export const ORGANIZATION = {
  minion: { ev: 0.5, stamina: 0.125, damageDiv: 2, targets: 1 },
  horde: { ev: 0.5, stamina: 0.5, damageDiv: 2, targets: 1 },
  platoon: { ev: 1, stamina: 1, damageDiv: 1, targets: 1 },
  leader: { ev: 2, stamina: 2, damageDiv: 1, targets: 2 },
  elite: { ev: 2, stamina: 2, damageDiv: 1, targets: 2 },
  solo: { ev: 6, stamina: 5, damageDiv: 1, targets: 2 }
};

// stamina: role modifier; damage: damage modifier. "solo"/"leader" are role/organization rows in the book.
export const ROLE = {
  ambusher: { stamina: 20, damage: 1 },
  artillery: { stamina: 10, damage: 1 },
  brute: { stamina: 30, damage: 1 },
  controller: { stamina: 10, damage: 0 },
  defender: { stamina: 30, damage: 0 },
  harrier: { stamina: 20, damage: 0 },
  hexer: { stamina: 10, damage: 0 },
  mount: { stamina: 20, damage: 0 },
  support: { stamina: 20, damage: 0 },
  solo: { stamina: 30, damage: 2 },
  leader: { stamina: 30, damage: 1 }
};
const ELITE_DAMAGE_BONUS = 1;

export const ROLE_FROM_4E = {
  artillery: "artillery",
  brute: "brute",
  controller: "controller",
  lurker: "ambusher",
  skirmisher: "harrier",
  soldier: "defender",
  companion: "support"
};

export const TIER_MOD = [0.6, 1.1, 1.4];

/* ----------------------------- formulas ----------------------------- */

export function dsOrganization(block, opts = DEFAULT_OPTIONS) {
  if (block.organization === "minion") return "minion";
  if (block.organization === "elite") return "elite";
  if (block.organization === "solo") return "solo";
  return opts.standardAs === "horde" ? "horde" : "platoon";
}

/** Role key that carries the stat modifiers (solo/leader organizations use their own row). */
export function statRole(org, role) {
  if (org === "solo") return "solo";
  if (org === "leader") return "leader";
  return role;
}

export function damageModifier(org, role) {
  let mod = ROLE[statRole(org, role)]?.damage ?? 0;
  if (org === "elite") mod += ELITE_DAMAGE_BONUS;
  return mod;
}

export const encounterValue = (level, org) => Math.ceil((2 * level + 4) * ORGANIZATION[org].ev);

export function stamina(level, org, role) {
  const roleMod = ROLE[statRole(org, role)]?.stamina ?? 0;
  return Math.ceil((10 * level + roleMod) * ORGANIZATION[org].stamina);
}

export function baseDamage(level, org, role, tier /* 1..3 */) {
  const raw = (4 + level + damageModifier(org, role)) * TIER_MOD[tier - 1];
  return Math.ceil(raw / ORGANIZATION[org].damageDiv);
}

export const freeStrike = (level, org, role) => baseDamage(level, org, role, 1);

const solo = (org) => org === "solo" || org === "leader";

/** Highest characteristic (and power roll bonus) for the monster. */
export function highestCharacteristic(level, org) {
  return Math.min(5, 1 + echelon(level) + (solo(org) ? 1 : 0));
}

/** Potency values for tiers 1..3: base highest characteristic minus 1 per tier below 3, +1 for leader/solo (max 6). */
export function potency(level, org) {
  const base = 1 + echelon(level);
  const bonus = solo(org) ? 1 : 0;
  return [base - 2 + bonus, base - 1 + bonus, base + bonus].map((v) => Math.min(6, Math.max(0, v)));
}

/* ----------------------------- sizes, speed ----------------------------- */

export const SIZE = {
  tiny: { value: 1, letter: "T" },
  small: { value: 1, letter: "S" },
  medium: { value: 1, letter: "M" },
  large: { value: 2, letter: "" },
  huge: { value: 3, letter: "" },
  gargantuan: { value: 4, letter: "" }
};

export const stabilityFromSize = (size) => Math.max(0, (SIZE[size]?.value ?? 1) - 1);

export function dsSpeed(speed4e, opts = DEFAULT_OPTIONS) {
  return Math.max(1, Math.round(speed4e * opts.speedScale));
}

export const MOVEMENT_MODES = { fly: "fly", climb: "climb", swim: "swim", burrow: "burrow", teleport: "teleport", "spider climb": "climb", "overland flight": null };

/* ------------------------- damage types, conditions ------------------------- */

export const DAMAGE_TYPE = {
  acid: "acid", cold: "cold", fire: "fire", lightning: "lightning", poison: "poison", psychic: "psychic",
  thunder: "sonic", necrotic: "corruption", radiant: "holy", force: null
};

// 4e condition -> Draw Steel condition key (null = no direct equivalent, flagged for review)
export const CONDITION = {
  dazed: "dazed", stunned: "dazed", slowed: "slowed", weakened: "weakened", prone: "prone",
  grabbed: "grabbed", immobilized: "restrained", restrained: "restrained", marked: "taunted",
  blinded: null, deafened: null, dominated: null, petrified: null, unconscious: null, helpless: null, invisible: null
};

export const DEFENSE_TO_CHARACTERISTIC = { ac: "might", fortitude: "might", reflex: "agility", will: "intuition" };

export const KEYWORD_MAP = {
  humanoid: "humanoid", beast: "animal", undead: "undead", dragon: "dragon", fey: "fey", elemental: "elemental",
  giant: "giant", plant: "plant", construct: "construct", "magical beast": "beast", aberrant: "horror",
  demon: "abyssal", devil: "infernal", animate: "construct"
};

export const ICONS = {
  main: "icons/skills/melee/strike-polearm-glowing-white.webp",
  maneuver: "icons/magic/air/air-pressure-shield-blue.webp",
  triggered: "icons/skills/movement/arrow-upward-yellow.webp",
  freeTriggered: "icons/skills/movement/arrow-upward-blue.webp",
  villain: "icons/magic/death/skull-horned-worn-fire-blue.webp",
  none: "icons/magic/unholy/silhouette-robe-evil-power.webp",
  feature: "icons/svg/aura.svg",
  actor: "icons/svg/mystery-man.svg"
};
