/**
 * Terminology rewrites applied to every piece of text that is carried into the output
 * (names, triggers, descriptions): bloodied -> winded, and "-N penalty to a roll" -> bane.
 */

const PLURAL_TO_HAVE = { take: "have", get: "have", suffer: "have", have: "have" };
const SINGULAR_TO_HAS = { takes: "has", gets: "has", suffers: "has", has: "has" };

// "a -2 penalty to attack rolls" / "takes a -2 penalty to the attack roll" / "-2 to escape checks"
// Only when a roll/check/test appears before the next punctuation, so defense and speed penalties are left alone.
const ROLL_PENALTY = /\b(?:(takes?|gets?|suffers?|has|have)\s+)?an?\s+-\d+\s+(?:penalty\s+)?to\s+(?=[^.;,()]*?\b(?:rolls?|checks?|tests?)\b)/gi;

// "Attacks against the angel take a -2 penalty until ..." -> "Attacks against the angel are made with a bane until ..."
const ATTACKS_AGAINST = /(\b(?:Attacks?|Saving throws?)\s+(?:made\s+)?against\s[^.;]*?\s)(?:take|takes)\s+an?\s+-\d+\s+penalty\b(?!\s+to\b)/gi;

// "makes a melee basic attack at a -2 penalty" -> "... attack with a bane"
const ATTACK_AT_PENALTY = /\b(attacks?|made)\s+at\s+an?\s+-\d+\s+penalty\b/gi;

export function rewriteText(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(ATTACKS_AGAINST, "$1are made with a bane");
  s = s.replace(ATTACK_AT_PENALTY, "$1 with a bane");
  s = s.replace(ROLL_PENALTY, (m, verb) => {
    if (!verb) return "a bane on ";
    const v = verb.toLowerCase();
    return `${PLURAL_TO_HAVE[v] ?? SINGULAR_TO_HAS[v]} a bane on `;
  });
  s = s.replace(/\bbloodied\b/g, "winded").replace(/\bBloodied\b/g, "Winded").replace(/\bBLOODIED\b/g, "WINDED");
  return s;
}
