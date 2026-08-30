import { holdsItemSize, parsePackage, perUnitOf, sameSize, toBase } from './normalize.js';
import type { InputUnit } from './normalize.js';
import type { Offer, PackageMode, PriceSanity, Product, UnitPrice } from './types.js';

/**
 * Judging whether a price and a package size are sensible.
 *
 * The optimizer picks the cheapest usable offer, which can land on something absurd per
 * unit — bio chicken at 500 Kč/kg among ordinary ones at 130. Nothing here filters that
 * out; it only labels it, because sometimes the expensive one is the only one there is.
 */

export const THRESHOLDS = {
  /** Below this many comparable candidates there is no meaningful median. */
  minSample: 3,
  /** Under this many, only the blatant case is called; "high" needs more evidence. */
  confidentSample: 5,
  normal: 1.75,
  high: 2.5,
} as const;

/** Normalises a printed unit price to one basis: "7,96 Kč / 100 g" becomes 79,60 per kg. */
export function normalizeUnitPrice(value: number | null, basis: string | null): UnitPrice | null {
  if (value === null || value <= 0 || !basis) return null;
  const measure = parsePackage(basis);
  if (!measure || measure.amount <= 0) return null;
  const per = measure.unit === 'ks' ? measure.amount : measure.amount / 1000;
  if (per <= 0) return null;
  return { value: round(value / per), currency: 'CZK', per: perUnitOf(measure.unit) };
}

/** Falls back to deriving one from the package size when none was printed. */
export function deriveUnitPrice(
  price: number | null,
  packageText: string | null,
): UnitPrice | null {
  if (price === null || price <= 0) return null;
  const measure = parsePackage(packageText);
  if (!measure || measure.amount <= 0) return null;
  const per = measure.unit === 'ks' ? measure.amount : measure.amount / 1000;
  return { value: round(price / per), currency: 'CZK', per: perUnitOf(measure.unit) };
}

export function unitPriceOf(offer: Offer, product: Product): UnitPrice | null {
  return (
    normalizeUnitPrice(offer.unitPrice, offer.unitPriceUnit) ??
    deriveUnitPrice(offer.price, offer.packageText ?? product.packageText)
  );
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

/**
 * Compares one candidate with the median of the others measured on the same basis.
 *
 * Only like for like enters the median: Kč/kg against Kč/ks means nothing. With too few
 * comparable candidates the answer is `unknown` — calling something extreme on the
 * strength of one other data point would be inventing a judgement.
 */
export function priceSanity(
  candidate: UnitPrice | null,
  population: Array<UnitPrice | null>,
): PriceSanity {
  if (!candidate) {
    return {
      status: 'unknown',
      unitPrice: null,
      medianUnitPrice: null,
      ratioToMedian: null,
      sample: 0,
    };
  }

  const comparable = population
    .filter((entry): entry is UnitPrice => entry !== null && entry.per === candidate.per)
    .map((entry) => entry.value);
  const base = { unitPrice: candidate, sample: comparable.length };

  if (comparable.length < THRESHOLDS.minSample) {
    return { ...base, status: 'unknown', medianUnitPrice: null, ratioToMedian: null };
  }
  const middle = median(comparable);
  if (middle === null || middle <= 0) {
    return { ...base, status: 'unknown', medianUnitPrice: null, ratioToMedian: null };
  }

  const ratio = candidate.value / middle;
  const status =
    ratio > THRESHOLDS.high
      ? 'extreme'
      : comparable.length < THRESHOLDS.confidentSample
        ? 'normal'
        : ratio > THRESHOLDS.normal
          ? 'high'
          : 'normal';
  return {
    ...base,
    status,
    medianUnitPrice: round(middle),
    ratioToMedian: Math.round(ratio * 100) / 100,
  };
}

// --- package preference ------------------------------------------------------

export interface PackageWish {
  amount: number;
  unit: InputUnit;
  mode: PackageMode;
}

export interface PackageFit {
  /** 0 when the size matches, rising with how far it strays. */
  penalty: number;
  /** False only when the size is required and out of tolerance. */
  usable: boolean;
  deviation: number | null;
}

/** Sizes this close count as the same, allowing for how labels are rounded. */
const EXACT = 0.02;
/** Beyond this a required size is refused outright. */
const REQUIRED_TOLERANCE = 0.1;

/**
 * Scores a package against what was wanted.
 *
 * `preferred` uses a continuous deviation rather than a yes/no test, so asking for 2 l
 * ranks 1,75 l well above 0,33 l instead of lumping every mismatch together — while a
 * genuinely large saving on a near size can still win.
 */
export function packageFit(wish: PackageWish | null, label: string | null): PackageFit {
  if (!wish) return { penalty: 0, usable: true, deviation: null };

  const wanted = toBase(wish.amount, wish.unit);
  const printed = `${wish.amount} ${wish.unit}`;
  // A multipack of the wanted item size satisfies the wish: "6 x 0,5 l" holds 0,5 l bottles.
  if (sameSize(label, printed) || holdsItemSize(label, printed)) {
    return { penalty: 0, usable: true, deviation: 0 };
  }

  const actual = parsePackage(label);
  if (!actual || actual.unit !== wanted.unit) {
    // An unreadable label cannot be shown to satisfy a hard requirement.
    return {
      penalty: wish.mode === 'required' ? 1 : 0.5,
      usable: wish.mode !== 'required',
      deviation: null,
    };
  }

  const deviation = Math.abs(actual.each - wanted.amount) / wanted.amount;
  return {
    penalty: deviation <= EXACT ? 0 : Math.min(1, deviation),
    usable: wish.mode !== 'required' || deviation <= REQUIRED_TOLERANCE,
    deviation: Math.round(deviation * 1000) / 1000,
  };
}

/**
 * How much a condition we cannot evaluate counts against an offer.
 *
 * Deliberately small. A coupon or a "selected branches only" note is a nuisance, not a
 * disqualification, so it has to settle a tie between equal prices without ever letting a
 * dearer offer win: at 5%, only a price within 5% can be overtaken.
 */
const UNCLEAR_CONDITION_FACTOR = 1.05;

/**
 * The single ranking model.
 *
 *     ranking = purchasePrice × packageFactor × conditionFactor
 *
 * `purchasePrice` is the only real money. The factors are preferences of at least 1 that
 * make a candidate less attractive without ever changing the price reported.
 */
export function rankingCost(purchasePrice: number, fit: PackageFit, unclear = false): number {
  return purchasePrice * (1 + fit.penalty * 1.5) * (unclear ? UNCLEAR_CONDITION_FACTOR : 1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
