import { comparable, number, text, type InputUnit } from './normalize.js';

/**
 * Deciding whether a product Kupi.cz returned is the one that was asked for.
 *
 * Kupi's search is fulltext, so "máslo" also returns "Tuk cukrářský máslová příchuť". The
 * score below is deterministic, not a probability: it weighs how much of the query the
 * name covers against how much unrequested meaning the name adds.
 */

export type MatchQuality = 'high' | 'medium' | 'low';

export interface Match {
  score: number;
  quality: MatchQuality;
  /** Words that make this a different product, e.g. "uzená", "pomazánka". */
  differs: string[];
  /** Query words with no counterpart in the name. */
  missing: string[];
}

export const HIGH = 0.85;
/** Below this a product is never chosen for a basket: a wrong item is worse than none. */
export const MEDIUM = 0.65;

/**
 * Words that turn an ingredient into a materially different product. Their presence in a
 * name the query did not ask for is what separates "Hermelín" from "Hermelínová pomazánka".
 *
 * Preservation is deliberately absent: sterilised corn is still the vegetable someone
 * asking for "kukuřice" wants.
 */
const CHANGES_PRODUCT = new Set([
  // Preparation.
  'uzeny',
  'uzena',
  'uzene',
  'suseny',
  'susena',
  'susene',
  'marinovany',
  'marinovana',
  'marinovane',
  'grilovany',
  'grilovana',
  'grilovane',
  'peceny',
  'pecena',
  'pecene',
  'predpeceny',
  'predpecene',
  'vareny',
  'varena',
  'varene',
  'smazeny',
  'smazena',
  'smazene',
  'prazeny',
  'prazena',
  'prazene',
  'nakladany',
  'nakladana',
  'nakladane',
  'soleny',
  'solene',
  'slazeny',
  'slazene',
  'trhany',
  'trhana',
  'trhane',
  'sousvide',
  'vide',
  'hotovy',
  'hotova',
  'hotove',
  'oblozeny',
  'oblozena',
  'oblozene',
  'plneny',
  'plnena',
  'plnene',
  'strouhany',
  'strouhana',
  'strouhane',
  'mlety',
  'mleta',
  'mlete',
  // A different category altogether.
  'pomazanka',
  'pomazankove',
  'snack',
  'chips',
  'chipsy',
  'pastika',
  'polevka',
  'omacka',
  'koreni',
  'sirup',
  'koncentrat',
  'napoj',
  'pyre',
  'protlak',
  'tycinka',
  'susenka',
  'susenky',
  'krem',
  'dip',
  'zavin',
  'knedlik',
  'salam',
  'klobasa',
  'parek',
  'parky',
  'prichut',
  'prichuti',
  'nahrazka',
  'instantni',
  'kompot',
  'margarin',
]);

/** Words that describe without changing: absent or present, the product is the same. */
const DESCRIPTIVE = new Set([
  'bez',
  'kosti',
  'cerstvy',
  'cerstva',
  'cerstve',
  'chlazeny',
  'chlazena',
  'chlazene',
  'obycejny',
  'obycejna',
  'obycejne',
  'klasicky',
  'klasicka',
  'klasicke',
  'kus',
  'porce',
  'vyber',
  'vyberovy',
]);

const STOP_WORDS = new Set([
  'a',
  'i',
  'na',
  'do',
  'od',
  'po',
  've',
  'se',
  'ze',
  'za',
  'ks',
  'bal',
  'balen',
  'baleni',
  'kus',
  'kusu',
  'cca',
  'nebo',
  'the',
]);

export function tokens(value: string): string[] {
  return comparable(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Czech inflection makes exact equality too strict, so stems are compared instead. */
function alike(left: string, right: string): boolean {
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  let common = 0;
  while (common < shorter && left[common] === right[common]) common += 1;
  return common >= 4 && common >= shorter * 0.75;
}

const inAny = (token: string, pool: string[]): boolean =>
  pool.some((candidate) => alike(token, candidate));

export function score(query: string, name: string, exclude: string[] = []): Match {
  const wanted = tokens(query);
  const found = tokens(name);
  if (wanted.length === 0 || found.length === 0) {
    return { score: 0, quality: 'low', differs: [], missing: wanted };
  }

  const required = wanted.filter((token) => !DESCRIPTIVE.has(token));
  const missing = required.filter((token) => !inAny(token, found));
  const coverage = required.length === 0 ? 1 : (required.length - missing.length) / required.length;

  const extra = found.filter((token) => !DESCRIPTIVE.has(token) && !inAny(token, wanted));
  const differs = extra.filter((token) => CHANGES_PRODUCT.has(token));

  // An explicit exclusion is decisive: the caller said they do not want this.
  const excluded = exclude.flatMap(tokens).filter((token) => inAny(token, found));
  if (excluded.length > 0) {
    return { score: 0, quality: 'low', differs: [...new Set([...differs, ...excluded])], missing };
  }

  const value =
    coverage -
    0.42 * Math.min(differs.length, 2) -
    0.05 * Math.min(extra.length - differs.length, 4);
  const clamped = Math.max(0, Math.min(1, value));
  return {
    score: Math.round(clamped * 1000) / 1000,
    quality: clamped >= HIGH ? 'high' : clamped >= MEDIUM ? 'medium' : 'low',
    differs,
    missing,
  };
}

// --- query preprocessing -----------------------------------------------------

export interface ParsedQuery {
  /** Just the product terms; what actually goes to Kupi.cz. */
  terms: string;
  /** A package size stated in the query, if any. */
  size?: { amount: number; unit: InputUnit };
}

const MEASURE = /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|ks|kus[uůy]?|litr[uůy]?|gram[uůy]?)(?![\p{L}])/giu;
const MULTIPACK = /(\d+)\s*[x×]\s*(?=\d)/giu;
const LEADING_COUNT = /^\s*(\d+)\s*[x×]\s*(?=\p{L})/u;
const DEGREE = /(\d+(?:[.,]\d+)?)\s*(?:°|st\.|stup[eň]\w*|%)/giu;
const APPROX = /\b(?:cca|ca|asi|zhruba|p[řr]ibli[žz]n[ěe])\b/giu;

/**
 * Splits a shopping line into the product terms and the size around them.
 *
 * Kupi matches product names, so leaving "0,5 l" in the query makes an otherwise findable
 * product unresolvable. The size is kept, because it is still a package preference.
 */
export function parseQuery(input: string): ParsedQuery {
  const original = text(input);
  let size: ParsedQuery['size'];
  let working = ` ${original} `;

  working = working.replace(APPROX, ' ').replace(DEGREE, ' ');
  working = working.replace(MEASURE, (_match, amount: string, unit: string) => {
    const value = number(amount);
    const parsed = unitFrom(unit);
    if (value !== null && parsed !== null && !size) size = { amount: value, unit: parsed };
    return ' ';
  });
  working = working.replace(MULTIPACK, ' ');
  working = text(working).replace(LEADING_COUNT, '');

  const terms = text(working).replace(/[\s,;]+$/u, '') || original;
  return size ? { terms, size } : { terms };
}

function unitFrom(raw: string): InputUnit | null {
  const value = raw.toLocaleLowerCase('cs-CZ');
  if (value === 'kg') return 'kg';
  if (value === 'g' || value.startsWith('gram')) return 'g';
  if (value === 'ml') return 'ml';
  if (value === 'l' || value.startsWith('litr')) return 'l';
  if (value === 'ks' || value.startsWith('kus')) return 'ks';
  return null;
}
