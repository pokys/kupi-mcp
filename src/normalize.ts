/** Czech text, numbers, prices, dates and package sizes as Kupi.cz prints them. */

const PRAGUE = 'Europe/Prague';
const SPACES = /[\s\u00a0\u202f]+/gu;

export type BaseUnit = 'g' | 'ml' | 'ks';
export type InputUnit = 'g' | 'kg' | 'ml' | 'l' | 'ks';
/** What a normalised unit price is expressed per. */
export type PerUnit = 'kg' | 'l' | 'ks';

export function text(value: string | null | undefined): string {
  return (value ?? '').replace(SPACES, ' ').trim();
}

/** Lowercased and stripped of diacritics, for comparing user input with page text. */
export function comparable(value: string): string {
  return text(value).normalize('NFD').replace(/[̀-ͯ]/gu, '').toLocaleLowerCase('cs-CZ');
}

/** Reads "1 234,50" and "1,234.50" alike; returns null when there is no number. */
export function number(value: string | null | undefined): number | null {
  // `*` rather than `?` on the separator group: "1,234.50" carries two, and stopping
  // at the first silently truncated it to 1.234 instead of reading 1234.50.
  const match = text(value).match(/[−–-]?\d[\d\s\u00a0\u202f]*(?:[.,]\d+)*/u);
  if (!match) return null;
  let numeric = match[0].replace(/[−–]/gu, '-').replace(SPACES, '');
  if (numeric.includes(',') && numeric.includes('.')) {
    numeric =
      numeric.lastIndexOf(',') > numeric.lastIndexOf('.')
        ? numeric.replaceAll('.', '').replace(',', '.')
        : numeric.replaceAll(',', '');
  } else {
    numeric = numeric.replace(',', '.');
  }
  const result = Number(numeric);
  return Number.isFinite(result) ? result : null;
}

export function price(value: string | null | undefined): number | null {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// --- packages and units ------------------------------------------------------

const UNIT_FACTOR: Record<InputUnit, { base: BaseUnit; factor: number }> = {
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  ks: { base: 'ks', factor: 1 },
};

const UNIT_WORDS = '(kg|g|ml|l|ks|kus[uůy]?|litr[uůy]?|gram[uůy]?)';

function unitOf(raw: string | null | undefined): InputUnit | null {
  const value = text(raw).toLocaleLowerCase('cs-CZ');
  if (value === 'kg') return 'kg';
  if (value === 'g' || value.startsWith('gram')) return 'g';
  if (value === 'ml') return 'ml';
  if (value === 'l' || value.startsWith('litr')) return 'l';
  if (value === 'ks' || value.startsWith('kus')) return 'ks';
  return null;
}

export interface Measure {
  amount: number;
  unit: BaseUnit;
}

export function toBase(amount: number, unit: InputUnit): Measure {
  const { base, factor } = UNIT_FACTOR[unit];
  return { amount: amount * factor, unit: base };
}

/** `g`/`ml`/`ks` are what sizes are measured in; prices are quoted per `kg`/`l`/`ks`. */
export function perUnitOf(base: BaseUnit): PerUnit {
  return base === 'g' ? 'kg' : base === 'ml' ? 'l' : 'ks';
}

export interface Package extends Measure {
  /** Items in one package: 6 for "6 x 0,5 l", 1 otherwise. */
  count: number;
  /** Size of a single item in base units: 500 for "6 x 0,5 l". */
  each: number;
}

/** Reads "500 g", "0,5 l" or "6 x 0,5 l" into base units, keeping the multipack shape. */
export function parsePackage(value: string | null | undefined): Package | null {
  const raw = text(value).toLocaleLowerCase('cs-CZ').replaceAll('×', 'x');
  if (!raw) return null;

  const multi = raw.match(
    new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*x\\s*(\\d+(?:[.,]\\d+)?)\\s*${UNIT_WORDS}\\b`, 'u'),
  );
  if (multi) {
    const count = number(multi[1]);
    const each = number(multi[2]);
    const unit = unitOf(multi[3]);
    if (count !== null && each !== null && unit !== null && count > 0 && each > 0) {
      const item = toBase(each, unit);
      return { amount: item.amount * count, unit: item.unit, count, each: item.amount };
    }
  }

  const single = raw.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${UNIT_WORDS}\\b`, 'u'));
  if (!single) return null;
  const amount = number(single[1]);
  const unit = unitOf(single[2]);
  if (amount === null || unit === null || amount <= 0) return null;
  const base = toBase(amount, unit);
  return { amount: base.amount, unit: base.unit, count: 1, each: base.amount };
}

/** True for sizes that differ only in how they are written: "0,5 l" and "500 ml". */
export function sameSize(left: string | null, right: string | null): boolean {
  const a = parsePackage(left);
  const b = parsePackage(right);
  if (!a || !b || a.unit !== b.unit) return false;
  return Math.abs(a.amount - b.amount) <= Math.max(a.amount, b.amount) * 0.02;
}

/** True when a package holds items of the wanted size: "6 x 0,5 l" holds 0,5 l bottles. */
export function holdsItemSize(label: string | null, wanted: string | null): boolean {
  const pack = parsePackage(label);
  const size = parsePackage(wanted);
  if (!pack || !size || pack.unit !== size.unit) return false;
  return Math.abs(pack.each - size.each) <= Math.max(pack.each, size.each) * 0.02;
}

export interface QuantityPlan {
  packages: number;
  purchased: number;
  required: number;
  unit: BaseUnit;
  overshoot: boolean;
}

/**
 * How many packages cover the request.
 *
 * Counted two ways: by weight or volume, 2 kg from 600 g packs is ceil(2000/600) = 4; by
 * pieces, 16 bottles from a "6 x 0,5 l" pack is ceil(16/6) = 3, because the pack supplies
 * six items whatever each one holds.
 */
export function planPackages(required: Measure, pack: Package): QuantityPlan | null {
  if (required.amount <= 0) return null;

  if (required.unit === 'ks' && pack.unit !== 'ks') {
    if (pack.count <= 0) return null;
    const packages = Math.ceil(required.amount / pack.count - 1e-9);
    const purchased = packages * pack.count;
    return {
      packages,
      purchased,
      required: required.amount,
      unit: 'ks',
      overshoot: purchased > required.amount + 1e-9,
    };
  }

  if (required.unit !== pack.unit || pack.amount <= 0) return null;
  const packages = Math.ceil(required.amount / pack.amount - 1e-9);
  const purchased = packages * pack.amount;
  return {
    packages,
    purchased,
    required: required.amount,
    unit: required.unit,
    overshoot: purchased > required.amount + 1e-9,
  };
}

export function formatMeasure(amount: number, unit: BaseUnit): string {
  if (unit === 'ks') return `${amount} ks`;
  if (unit === 'g' && amount >= 1000) return `${human(amount / 1000)} kg`;
  if (unit === 'ml' && amount >= 1000) return `${human(amount / 1000)} l`;
  return `${human(amount)} ${unit}`;
}

function human(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}

// --- dates -------------------------------------------------------------------

interface Day {
  year: number;
  month: number;
  day: number;
}

function pragueDay(now: Date): Day {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PRAGUE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

function iso(day: Day): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}`;
}

export function today(now: Date = new Date()): string {
  return iso(pragueDay(now));
}

function shift(day: Day, days: number): Day {
  const moved = new Date(Date.UTC(day.year, day.month - 1, day.day + days, 12));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** A date without a year is this year unless that would put it well in the past. */
function inferYear(day: number, month: number, now: Day): number {
  const candidate = Date.UTC(now.year, month - 1, day);
  const reference = Date.UTC(now.year, now.month - 1, now.day);
  return candidate < reference - 31 * 86_400_000 ? now.year + 1 : now.year;
}

export function parseValidity(
  value: string | null | undefined,
  now: Date,
): { validFrom: string | null; validTo: string | null } {
  const raw = text(value).toLocaleLowerCase('cs-CZ');
  const day = pragueDay(now);
  if (!raw) return { validFrom: null, validTo: null };

  const dates = [...raw.matchAll(/(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{4}))?/gu)].map((match) => {
    const d = Number(match[1]);
    const m = Number(match[2]);
    return iso({ year: match[3] ? Number(match[3]) : inferYear(d, m, day), month: m, day: d });
  });
  if (dates.length >= 2) return { validFrom: dates[0] ?? null, validTo: dates[1] ?? null };
  if (dates.length === 1) {
    return {
      validFrom: /\bod\b/u.test(raw) && !/\bdo\b/u.test(raw) ? (dates[0] ?? null) : null,
      validTo: /\bdo\b|končí|plati do/u.test(raw) ? (dates[0] ?? null) : null,
    };
  }
  if (/zítra\s+končí/u.test(raw)) return { validFrom: null, validTo: iso(shift(day, 1)) };
  if (/dnes\s+končí/u.test(raw)) return { validFrom: null, validTo: iso(day) };
  return { validFrom: null, validTo: null };
}

/**
 * Whether an offer applies on a day.
 *
 * A known start after the target date is decisive: a promotion that has not begun must
 * never be shown as valid. Missing bounds stay permissive, because Kupi.cz often prints
 * only "platí do" and requiring a start would discard most offers.
 */
export function validOn(
  offer: { validFrom: string | null; validTo: string | null },
  date: string,
): boolean {
  if (offer.validFrom !== null && offer.validFrom > date) return false;
  if (offer.validTo !== null && offer.validTo < date) return false;
  return true;
}

export function parseQuantityLimit(value: string | null | undefined): number | null {
  const match = text(value).match(/(?:max(?:imálně)?\.?|limit)\s*(\d+(?:[.,]\d+)?)\s*(?:ks|kus)/iu);
  return number(match?.[1]);
}

/** Discount is printed as a negative percentage; the sign carries no information. */
export function discountPercent(value: string | null | undefined): number | null {
  const parsed = number(value);
  return parsed === null ? null : Math.abs(parsed);
}

/**
 * Reads "7,16 Kč / 100 g" into the price and the basis it is quoted per.
 * The basis matters: the same figure means different things per 100 g and per kg.
 */
export function unitPrice(value: string | null | undefined): {
  price: number | null;
  unit: string | null;
} {
  const match = text(value).match(/(.+?)(?:Kč)?\s*\/\s*(\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|ks))\b/iu);
  return {
    price: price(match?.[1]),
    unit: match?.[2] ? text(match[2]).toLocaleLowerCase('cs-CZ') : null,
  };
}
