import { noGeography, resolveGeography } from './branches.js';
import type { BranchDirectory } from './branches.js';
import type { KupiClient } from './client.js';
import { MEDIUM, parseQuery, score } from './matching.js';
import { comparable, today, validOn as offerValidOn } from './normalize.js';
import { KupiParser } from './parser.js';
import { matchesStoreSelector } from './stores.js';
import type {
  Offer,
  Product,
  ProductInput,
  SearchInput,
  SearchResult,
  UpcomingOffer,
} from './types.js';

/** How far ahead a promotion is worth mentioning as a reason to wait. */
const UPCOMING_HORIZON_DAYS = 7;

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.round((end - start) / 86_400_000)
    : 0;
}

/**
 * Promotions that start later, as an explicit "worth waiting?" answer.
 *
 * Kept apart from the products so they can never be counted as available today, and held
 * to the same match threshold: suggesting someone wait for a margarine they did not ask
 * for is no better than selling it to them now.
 */
function upcomingOffers(
  products: Product[],
  validOn: string,
  query: string,
  exclude: string[],
): UpcomingOffer[] {
  const upcoming: UpcomingOffer[] = [];
  for (const product of products) {
    if (score(query, product.name, exclude).score < MEDIUM) continue;

    // Cheapest price today per package size, not per product. Kupi lists several sizes
    // under one product, and "wait and save 8 Kč" is false if today's price was for a
    // 250 g pack and the future one is 400 g.
    const bestBySize = new Map<string, number>();
    for (const offer of product.offers) {
      if (!offerValidOn(offer, validOn) || offer.price === null) continue;
      const size = comparable(offer.packageText ?? '');
      const known = bestBySize.get(size);
      if (known === undefined || offer.price < known) bestBySize.set(size, offer.price);
    }

    for (const offer of product.offers) {
      if (offer.validFrom === null || offer.validFrom <= validOn) continue;
      const startsInDays = daysBetween(validOn, offer.validFrom);
      if (startsInDays <= 0 || startsInDays > UPCOMING_HORIZON_DAYS) continue;
      // Null rather than a number derived from a different pack: no comparison is better
      // than one the caller cannot tell is invalid.
      const best = bestBySize.get(comparable(offer.packageText ?? '')) ?? null;
      upcoming.push({
        product: product.name,
        productUrl: product.productUrl,
        store: offer.store,
        price: offer.price,
        packageText: offer.packageText,
        validFrom: offer.validFrom,
        startsInDays,
        priceToday: best,
        savingIfWaiting:
          best !== null && offer.price !== null
            ? Math.round((best - offer.price) * 100) / 100
            : null,
      });
    }
  }
  // Biggest saving first; unknown savings last, since they cannot be recommended.
  return upcoming.sort(
    (a, b) => (b.savingIfWaiting ?? -Infinity) - (a.savingIfWaiting ?? -Infinity),
  );
}

function usableOffers(offers: Offer[], input: SearchInput, validOn: string): Offer[] {
  return offers.filter((offer) => {
    if (
      input.stores?.length &&
      !input.stores.some((selector) => matchesStoreSelector(offer.store, selector))
    ) {
      return false;
    }
    if (input.excludeMembershipOnly && (offer.membershipRequired || offer.mobileAppRequired)) {
      return false;
    }
    return offerValidOn(offer, validOn);
  });
}

export class SearchService {
  private readonly parser = new KupiParser();

  constructor(
    private readonly client: KupiClient,
    private readonly branches?: BranchDirectory,
  ) {}

  async search(input: SearchInput): Promise<SearchResult> {
    const validOn = input.validOn ?? today();
    // Packaging in the query stops Kupi.cz finding the product, so only the terms go out.
    const query = parseQuery(input.query);
    const fetched = await this.client.search(query.terms, input.location);
    const page = this.parser.parseSearch(fetched.html, fetched.sourceUrl, fetched.retrievedAt);

    if (page.parseStatus === 'unexpected') {
      throw new Error(
        'Struktura stránky Kupi.cz se změnila; nevracím data, která by mohla být nespolehlivá.',
      );
    }

    const upcoming = upcomingOffers(page.products, validOn, query.terms, input.exclude ?? []);

    // Scored for every result, whatever the ordering: how well a product answers the
    // query is a property of the product, and sorting by price used to discard it.
    let products: Product[] = page.products
      .map((product) => ({
        ...product,
        offers: usableOffers(product.offers, input, validOn),
        match: score(query.terms, product.name, input.exclude ?? []),
      }))
      .filter((product) => product.offers.length > 0);

    const geography =
      input.radiusKm !== undefined && this.branches
        ? await resolveGeography(this.branches, input, [
            {
              branchLinks: page.branchLinks,
              chains: products.flatMap((p) => p.offers.map((o) => o.store ?? '')).filter(Boolean),
            },
          ])
        : noGeography(input.radiusKm ?? null);

    if (geography.allowed) {
      const allowed = geography.allowed;
      products = products
        .map((product) => ({
          ...product,
          offers: product.offers.filter(
            (offer) => offer.store !== null && allowed.has(comparable(offer.store)),
          ),
        }))
        .filter((product) => product.offers.length > 0);
    }

    products = sort(products, input.sortBy ?? 'relevance').slice(0, input.limit ?? 10);

    const warnings = [...page.warnings];
    if (input.location && comparable(input.location) !== comparable(page.location)) {
      warnings.push(
        `Data jsou pro lokalitu „${page.location}“, nikoli „${input.location}“. Text lokality nelze bezpečně přeložit na interní ID.`,
      );
    }

    return {
      products,
      searchQuery: query.terms,
      requestedLocation: input.location?.trim() || null,
      location: page.location,
      validOn,
      sourceUrl: fetched.sourceUrl,
      retrievedAt: fetched.retrievedAt,
      upcoming,
      warnings,
      ...(geography.radiusKm !== null
        ? {
            radiusKm: geography.radiusKm,
            resolvedOrigin: geography.origin,
            excludedChains: geography.excluded,
            nearbyBranches: [...geography.branchByChain.values()],
          }
        : {}),
    };
  }

  /**
   * One product's offers from its detail page.
   *
   * The detail page lists every shop, where the search page shows only the leading few,
   * so this is the one to use once the product is known.
   */
  async product(input: ProductInput): Promise<SearchResult> {
    const validOn = input.validOn ?? today();
    const fetched = await this.client.getProduct(
      input.productUrl ?? input.slug ?? '',
      input.location,
    );
    const page = this.parser.parseDetail(fetched.html, fetched.sourceUrl, fetched.retrievedAt);

    if (page.parseStatus === 'unexpected') {
      throw new Error(
        'Struktura stránky Kupi.cz se změnila; nevracím data, která by mohla být nespolehlivá.',
      );
    }

    const products = page.products
      .map((product) => ({
        ...product,
        offers: usableOffers(product.offers, { query: '', ...input }, validOn),
      }))
      .filter((product) => product.offers.length > 0);

    return {
      products,
      searchQuery: products[0]?.name ?? '',
      requestedLocation: input.location?.trim() || null,
      location: page.location,
      validOn,
      sourceUrl: fetched.sourceUrl,
      retrievedAt: fetched.retrievedAt,
      upcoming: [],
      warnings: page.warnings,
    };
  }
}

/**
 * A discount to order by, for offers where the leaflet printed no percentage.
 *
 * Used for ordering only, never reported: `regularPrice` is Kupi's average across shops,
 * not this shop's own former price, so publishing a percentage derived from it would
 * claim precision the source does not have. Leaving such offers unranked is worse than
 * approximating, though — it sent the cheapest butter of the day to the bottom of the
 * list purely because its leaflet had no badge.
 */
function sortableDiscount(offer: Offer): number | null {
  if (offer.discountPercent !== null) return offer.discountPercent;
  if (offer.regularPrice === null || offer.price === null) return null;
  if (offer.regularPrice <= 0 || offer.price >= offer.regularPrice) return null;
  return Math.round((1 - offer.price / offer.regularPrice) * 100);
}

function sort(products: Product[], by: NonNullable<SearchInput['sortBy']>): Product[] {
  const lowest = (values: Array<number | null>): number => {
    const valid = values.filter((value): value is number => value !== null);
    return valid.length > 0 ? Math.min(...valid) : Number.POSITIVE_INFINITY;
  };
  const highest = (values: Array<number | null>): number => {
    const valid = values.filter((value): value is number => value !== null);
    return valid.length > 0 ? Math.max(...valid) : Number.NEGATIVE_INFINITY;
  };

  return [...products].sort((left, right) => {
    if (by === 'price') {
      return lowest(left.offers.map((o) => o.price)) - lowest(right.offers.map((o) => o.price));
    }
    if (by === 'unit_price') {
      return (
        lowest(left.offers.map((o) => o.unitPrice)) - lowest(right.offers.map((o) => o.unitPrice))
      );
    }
    if (by === 'discount') {
      return (
        highest(right.offers.map(sortableDiscount)) - highest(left.offers.map(sortableDiscount))
      );
    }
    return (right.match?.score ?? 0) - (left.match?.score ?? 0);
  });
}
