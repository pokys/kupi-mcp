import type { InputUnit, PerUnit } from './normalize.js';
import type { Match } from './matching.js';

export type ProductUnit = InputUnit | null;

export interface Offer {
  id: string | null;
  store: string | null;
  price: number | null;
  regularPrice: number | null;
  discountPercent: number | null;
  packageText: string | null;
  unitPrice: number | null;
  unitPriceUnit: string | null;
  validFrom: string | null;
  validTo: string | null;
  validityText: string | null;
  membershipRequired: boolean;
  membershipText: string | null;
  mobileAppRequired: boolean;
  quantityLimit: number | null;
  /**
   * True for coupons, multibuys and branch-limited wording: conditions whose effect on
   * the price cannot be worked out from the text, so the figure shown may not be paid.
   */
  needsManualCheck: boolean;
  unclearConditions: string[];
  conditions: string[];
  leafletUrl: string | null;
  /** Which listing the row came from; deduplication prefers the recommended one. */
  sourceSection: 'recommended' | 'price' | 'unknown';
  sourceUrl: string;
  location: string;
  retrievedAt: string;
}

export interface Product {
  id: string | null;
  name: string;
  slug: string;
  packageText: string | null;
  quantity: number | null;
  unit: ProductUnit;
  regularPrice: number | null;
  productUrl: string;
  imageUrl: string | null;
  offers: Offer[];
  retrievedAt: string;
  /** How well this answers the query that found it; always present on search results. */
  match?: Match;
}

export interface ParsedPage {
  products: Product[];
  location: string;
  /** Nearest-branch link per chain, as the search page prints them. */
  branchLinks: Array<{ chain: string; path: string }>;
  /** Tells a genuinely empty result apart from the page structure having changed. */
  parseStatus: 'ok' | 'empty' | 'unexpected';
  warnings: string[];
}

/** A price normalised to one basis, with the basis stated so it cannot be misread. */
export interface UnitPrice {
  value: number;
  currency: 'CZK';
  per: PerUnit;
}

export type SanityStatus = 'normal' | 'high' | 'extreme' | 'unknown';

export interface PriceSanity {
  status: SanityStatus;
  unitPrice: UnitPrice | null;
  medianUnitPrice: number | null;
  ratioToMedian: number | null;
  /** How many comparable candidates the median came from. */
  sample: number;
}

/** Whether a promotion is known to apply at a specific shop. */
export type BranchApplicability = 'assumed' | 'unknown';

export interface OpeningStatus {
  /** Null when the branch published no hours: unknown is not the same as closed. */
  open: boolean | null;
  closesAt: string | null;
  opensAt: string | null;
  minutesUntilClose: number | null;
}

export interface Branch {
  id: string | null;
  chain: string;
  name: string;
  url: string;
  address: { street: string | null; city: string; country: string };
  coordinates: { latitude: number; longitude: number } | null;
  openingHours: string[];
}

export interface NearbyBranch extends Branch {
  /** Straight-line kilometres. Not a driving distance. */
  distanceKm: number;
  opening: OpeningStatus;
  branchApplicability: BranchApplicability;
}

export interface Origin {
  name: string;
  coordinates: { latitude: number; longitude: number };
  /** Derived from a branch in that town, so accurate to roughly the size of the town. */
  source: string;
}

export interface UpcomingOffer {
  product: string;
  productUrl: string;
  store: string | null;
  price: number | null;
  packageText: string | null;
  validFrom: string;
  startsInDays: number;
  /** Best price on sale today for the same product, when there is one. */
  priceToday: number | null;
  /** Positive when waiting is cheaper; null when there is nothing to compare with. */
  savingIfWaiting: number | null;
}

export interface SearchInput {
  query: string;
  location?: string | undefined;
  stores?: string[] | undefined;
  exclude?: string[] | undefined;
  excludeMembershipOnly?: boolean | undefined;
  sortBy?: 'relevance' | 'price' | 'unit_price' | 'discount' | undefined;
  limit?: number | undefined;
  /** `YYYY-MM-DD` the offer must be valid on. Defaults to today in Prague. */
  validOn?: string | undefined;
  /** Only chains with a verified branch this close. Costs extra requests. */
  radiusKm?: number | undefined;
  origin?: { latitude: number; longitude: number } | undefined;
}

export interface SearchResult {
  products: Product[];
  /** What was actually searched for, after packaging was stripped from the query. */
  searchQuery: string;
  requestedLocation: string | null;
  location: string;
  validOn: string;
  sourceUrl: string;
  retrievedAt: string;
  /** Promotions starting later; never counted as available today. */
  upcoming: UpcomingOffer[];
  /** Present only when a radius was requested. */
  radiusKm?: number;
  resolvedOrigin?: Origin | null;
  nearbyBranches?: NearbyBranch[];
  excludedChains?: Array<{ chain: string; reason: string; distanceKm?: number }>;
  warnings: string[];
}

export interface ProductInput {
  /** Exactly one of these two identifies the product. */
  productUrl?: string | undefined;
  slug?: string | undefined;
  location?: string | undefined;
  stores?: string[] | undefined;
  excludeMembershipOnly?: boolean | undefined;
  validOn?: string | undefined;
}

export type PackageMode = 'preferred' | 'required';

export interface BasketItem {
  query: string;
  /** How much is needed, e.g. 2 with unit "kg". Defaults to one package. */
  amount?: number | undefined;
  unit?: InputUnit | undefined;
  /** Wanted package size. `required` leaves the item unresolved if unavailable. */
  package?: { amount: number; unit: InputUnit; mode?: PackageMode } | undefined;
  exclude?: string[] | undefined;
}

export interface BasketInput {
  items: BasketItem[];
  location?: string | undefined;
  maxStores?: number | undefined;
  allowedStores?: string[] | undefined;
  excludedStores?: string[] | undefined;
  availableMemberships?: string[] | undefined;
  validOn?: string | undefined;
  radiusKm?: number | undefined;
  origin?: { latitude: number; longitude: number } | undefined;
}

export interface BasketLine {
  query: string;
  product: Product;
  offer: Offer;
  /** Price of one package as printed. */
  packagePrice: number | null;
  packages: number;
  /** packagePrice × packages: what this line actually costs. */
  purchasePrice: number;
  /** Items inside one package, for a multipack. */
  packCount?: number;
  requestedQuantity?: string;
  purchasedQuantity?: string;
  priceSanity: PriceSanity;
  /** Why the result is approximate, in plain words; null when it is exact. */
  note: string | null;
}

export interface BasketStore {
  chain: string;
  branch: NearbyBranch | null;
  lines: BasketLine[];
  subtotal: number;
}

export interface BasketResult {
  status: 'complete' | 'partial';
  resolvedItems: number;
  totalItems: number;
  coverage: number;
  /** Cost of the resolved lines. */
  resolvedPrice: number;
  /** The whole basket's cost, or null when it could not be fully resolved. */
  totalPrice: number | null;
  stores: BasketStore[];
  unresolved: Array<{ query: string; reason: string }>;
  requestedLocation: string | null;
  location: string;
  validOn: string;
  radiusKm: number | null;
  resolvedOrigin: Origin | null;
  excludedChains: Array<{ chain: string; reason: string; distanceKm?: number }>;
  retrievedAt: string;
  warnings: string[];
}
