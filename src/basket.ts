import { noGeography, resolveGeography } from './branches.js';
import type { BranchDirectory } from './branches.js';
import { MEDIUM } from './matching.js';
import {
  comparable,
  formatMeasure,
  money,
  parsePackage,
  planPackages,
  toBase,
} from './normalize.js';
import type { Measure } from './normalize.js';
import { packageFit, priceSanity, rankingCost, unitPriceOf } from './pricing.js';
import type { PackageWish } from './pricing.js';
import type { SearchService } from './search.js';
import type {
  BasketInput,
  BasketItem,
  BasketLine,
  BasketResult,
  BasketStore,
  Offer,
  Product,
  SearchResult,
  UnitPrice,
} from './types.js';

/** Cost added per extra shop, standing in for the bother of a second stop. */
const EXTRA_STORE_CZK = 50;
/** Chains considered when combining shops, to keep the search finite. */
const MAX_CHAINS = 12;

interface Candidate {
  product: Product;
  offer: Offer;
  purchasePrice: number;
  packages: number;
  ranking: number;
  line: Omit<BasketLine, 'query'>;
}

interface ItemPlan {
  item: BasketItem;
  candidates: Candidate[];
  /** Why nothing was usable, when that is already known. */
  rejection: string | null;
}

interface Combination {
  lines: BasketLine[];
  unresolved: Array<{ query: string; reason: string }>;
  total: number;
  chains: Set<string>;
}

function wishOf(item: BasketItem): PackageWish | null {
  if (!item.package) return null;
  return {
    amount: item.package.amount,
    unit: item.package.unit,
    mode: item.package.mode ?? 'preferred',
  };
}

function requirementOf(item: BasketItem): Measure | null {
  return item.amount !== undefined && item.unit !== undefined
    ? toBase(item.amount, item.unit)
    : null;
}

function membershipUsable(offer: Offer, memberships: string[]): boolean {
  if (!offer.membershipRequired && !offer.mobileAppRequired) return true;
  const held = memberships.map(comparable);
  const described = [offer.store, offer.membershipText, ...offer.conditions]
    .filter((value): value is string => Boolean(value))
    .map(comparable);
  return held.some((membership) =>
    described.some((text) => text.includes(membership) || membership.includes(text)),
  );
}

/**
 * Works out what one offer costs for what was asked for.
 *
 * The package count follows the offer's real package size: 2 kg from 600 g packs is four
 * packs, and 16 bottles from a "6 x 0,5 l" multipack is three. The price follows the count,
 * so what is reported is the checkout price, not the shelf price of one package.
 */
function priceCandidate(
  item: BasketItem,
  product: Product,
  offer: Offer,
  population: Array<UnitPrice | null>,
): Candidate | null {
  const unitPrice = offer.price;
  if (unitPrice === null) return null;

  const pack = parsePackage(offer.packageText) ?? parsePackage(product.packageText);
  const required = requirementOf(item);
  const notes: string[] = [];
  let packages = 1;
  let requestedQuantity: string | undefined;
  let purchasedQuantity: string | undefined;

  if (required) {
    const plan = pack ? planPackages(required, pack) : null;
    if (plan) {
      packages = plan.packages;
      requestedQuantity = formatMeasure(plan.required, plan.unit);
      purchasedQuantity = formatMeasure(plan.purchased, plan.unit);
      if (plan.overshoot) {
        notes.push(
          `Balení nelze dělit, takže vychází ${purchasedQuantity} místo ${requestedQuantity}.`,
        );
      }
    } else {
      notes.push('Velikost balení nelze porovnat s požadovaným množstvím; počítá se jedno balení.');
    }
  }

  const fit = packageFit(wishOf(item), offer.packageText ?? product.packageText);
  if (!fit.usable) return null;
  if (fit.penalty > 0 && item.package) {
    notes.push(
      `Velikost balení neodpovídá požadovaným ${item.package.amount} ${item.package.unit}.`,
    );
  }
  if (offer.needsManualCheck) {
    notes.push(`Podmínku nabídky nelze vyhodnotit: ${offer.unclearConditions.join('; ')}.`);
  }

  const purchasePrice = money(unitPrice * packages);
  return {
    product,
    offer,
    purchasePrice,
    packages,
    ranking: rankingCost(purchasePrice, fit),
    line: {
      product,
      offer,
      packagePrice: unitPrice,
      packages,
      purchasePrice,
      ...(pack && pack.count > 1 ? { packCount: pack.count } : {}),
      ...(requestedQuantity ? { requestedQuantity } : {}),
      ...(purchasedQuantity ? { purchasedQuantity } : {}),
      priceSanity: priceSanity(unitPriceOf(offer, product), population),
      note: notes.length > 0 ? notes.join(' ') : null,
    },
  };
}

function combinationsOf(chains: string[], maximum: number): string[][] {
  const result: string[][] = [];
  const visit = (start: number, picked: string[]): void => {
    if (picked.length > 0) result.push([...picked]);
    if (picked.length === maximum) return;
    for (let index = start; index < chains.length; index += 1) {
      const chain = chains[index];
      if (chain === undefined) continue;
      picked.push(chain);
      visit(index + 1, picked);
      picked.pop();
    }
  };
  visit(0, []);
  return result;
}

function evaluate(plans: ItemPlan[], chains: string[]): Combination {
  const open = new Set(chains);
  const lines: BasketLine[] = [];
  const unresolved: Array<{ query: string; reason: string }> = [];

  for (const plan of plans) {
    const available = plan.candidates.filter(
      (candidate) => candidate.offer.store && open.has(comparable(candidate.offer.store)),
    );
    const best = [...available].sort((left, right) => left.ranking - right.ranking)[0];
    if (!best) {
      unresolved.push({
        query: plan.item.query,
        reason: plan.rejection ?? 'Ve vybraných obchodech není vhodná nabídka.',
      });
      continue;
    }
    lines.push({ query: plan.item.query, ...best.line });
  }

  return {
    lines,
    unresolved,
    total: money(lines.reduce((sum, line) => sum + line.purchasePrice, 0)),
    chains: new Set(
      lines.map((line) => comparable(line.offer.store ?? '')).filter((chain) => chain !== ''),
    ),
  };
}

/**
 * Coverage outranks price: a cheaper set of shops that leaves items unbought is not a
 * better answer to "buy this list" than a slightly dearer one that covers everything.
 */
function better(candidate: Combination, current: Combination): boolean {
  if (candidate.unresolved.length !== current.unresolved.length) {
    return candidate.unresolved.length < current.unresolved.length;
  }
  return (
    candidate.total + candidate.chains.size * EXTRA_STORE_CZK <
    current.total + current.chains.size * EXTRA_STORE_CZK
  );
}

export class BasketPlanner {
  constructor(
    private readonly search: SearchService,
    private readonly branches?: BranchDirectory,
  ) {}

  async plan(input: BasketInput): Promise<BasketResult> {
    const validOn = input.validOn ?? new Date().toISOString().slice(0, 10);
    const searches: SearchResult[] = await Promise.all(
      input.items.map((item) =>
        this.search.search({
          query: item.query,
          location: input.location,
          stores: input.allowedStores,
          exclude: item.exclude,
          validOn: input.validOn,
          limit: 10,
        }),
      ),
    );

    const geography =
      input.radiusKm !== undefined && this.branches
        ? await resolveGeography(this.branches, input, [
            {
              branchLinks: searches
                .flatMap((result) => result.nearbyBranches ?? [])
                .map((b) => ({ chain: b.chain, path: new URL(b.url).pathname })),
              chains: searches
                .flatMap((result) =>
                  result.products.flatMap((product) =>
                    product.offers.map((offer) => offer.store ?? ''),
                  ),
                )
                .filter(Boolean),
            },
          ])
        : noGeography(input.radiusKm ?? null);

    const excludedStores = new Set((input.excludedStores ?? []).map(comparable));
    const memberships = input.availableMemberships ?? [];

    const plans: ItemPlan[] = input.items.map((item, index) => {
      const result = searches[index];
      const products = result?.products ?? [];
      // A wrong product is worse than an unresolved one.
      const confident = products.filter((product) => (product.match?.score ?? 1) >= MEDIUM);
      const population = confident.flatMap((product) =>
        product.offers.map((offer) => unitPriceOf(offer, product)),
      );

      const candidates = confident.flatMap((product) =>
        product.offers
          .filter(
            (offer) =>
              offer.store !== null &&
              offer.price !== null &&
              !excludedStores.has(comparable(offer.store)) &&
              membershipUsable(offer, memberships) &&
              (geography.allowed === null || geography.allowed.has(comparable(offer.store))),
          )
          .flatMap((offer) => {
            const candidate = priceCandidate(item, product, offer, population);
            return candidate ? [candidate] : [];
          }),
      );

      const rejection =
        candidates.length === 0 && confident.length === 0 && products.length > 0
          ? 'Žádný dostatečně jistý produkt neodpovídá dotazu.'
          : candidates.length === 0 && confident.length > 0
            ? 'Požadovanou velikost balení se nepodařilo najít.'
            : null;
      return { item, candidates, rejection };
    });

    const ranked = rankChains(plans);
    const maxStores = Math.min(input.maxStores ?? 3, ranked.length);
    let best: Combination | null = null;
    for (const combination of combinationsOf(ranked, maxStores)) {
      const evaluated = evaluate(plans, combination);
      if (!best || better(evaluated, best)) best = evaluated;
    }
    best ??= evaluate(plans, []);

    const stores: BasketStore[] = [...best.chains]
      .map((chain) => {
        const lines = best.lines.filter((line) => comparable(line.offer.store ?? '') === chain);
        const name = lines[0]?.offer.store ?? chain;
        return {
          chain: name,
          branch: geography.branchByChain.get(chain) ?? null,
          lines,
          subtotal: money(lines.reduce((sum, line) => sum + line.purchasePrice, 0)),
        };
      })
      .filter((store) => store.lines.length > 0)
      .sort((left, right) => left.chain.localeCompare(right.chain, 'cs-CZ'));

    const totalItems = input.items.length;
    const resolvedItems = best.lines.length;
    const complete = resolvedItems === totalItems && best.unresolved.length === 0;

    return {
      status: complete ? 'complete' : 'partial',
      resolvedItems,
      totalItems,
      coverage: totalItems === 0 ? 1 : Math.round((resolvedItems / totalItems) * 10_000) / 10_000,
      resolvedPrice: best.total,
      // Null rather than the resolved subtotal: a partial basket has no known total, and
      // showing the part as the whole is the misleading answer this avoids.
      totalPrice: complete ? best.total : null,
      stores,
      unresolved: best.unresolved,
      requestedLocation: input.location?.trim() || null,
      location: searches[0]?.location ?? 'Nezjištěná lokalita',
      validOn,
      radiusKm: geography.radiusKm,
      resolvedOrigin: geography.origin,
      excludedChains: geography.excluded,
      retrievedAt:
        searches
          .map((result) => result.retrievedAt)
          .sort()
          .at(-1) ?? new Date().toISOString(),
      warnings: [...new Set(searches.flatMap((result) => result.warnings))],
    };
  }
}

/** Chains worth combining, most useful first, capped so the search stays finite. */
function rankChains(plans: ItemPlan[]): string[] {
  const score = new Map<string, { covers: number; price: number }>();
  for (const plan of plans) {
    const seen = new Set<string>();
    for (const candidate of plan.candidates) {
      const chain = comparable(candidate.offer.store ?? '');
      if (!chain) continue;
      const entry = score.get(chain) ?? { covers: 0, price: 0 };
      if (!seen.has(chain)) {
        entry.covers += 1;
        seen.add(chain);
      }
      entry.price += candidate.purchasePrice;
      score.set(chain, entry);
    }
  }
  return [...score.entries()]
    .sort((left, right) => right[1].covers - left[1].covers || left[1].price - right[1].price)
    .slice(0, MAX_CHAINS)
    .map(([chain]) => chain);
}
