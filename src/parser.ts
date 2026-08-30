import { load, type CheerioAPI } from 'cheerio';
import {
  comparable,
  text,
  discountPercent,
  parsePackage,
  price,
  parseQuantityLimit,
  unitPrice as unitPriceOf,
  parseValidity,
} from './normalize.js';
import type { Offer, ParsedPage, Product } from './types.js';
import { canonicalStoreName, matchesStoreSelector } from './stores.js';

const KUPI_ORIGIN = 'https://www.kupi.cz';
type Selection = ReturnType<CheerioAPI>;

interface ParseContext {
  sourceUrl: string;
  retrievedAt: string;
  now: Date;
  location: string;
}

interface StructuredOffer {
  offeredBy: string | null;
  price: number | null;
  validTo: string | null;
}

interface StructuredProduct {
  name: string | null;
  image: string | null;
  offers: StructuredOffer[];
}

/**
 * Kupi uses both a dedicated club-price element and free-text conditions. The dedicated
 * element is authoritative even when its wording contains no Czech word for "club"
 * (for example "Cena s Kaufland Card XTRA").
 */
export function classifyOfferConditions(
  membershipText: string | null,
  conditions: string[],
): {
  membershipRequired: boolean;
  mobileAppRequired: boolean;
  unsupportedConditions: string[];
} {
  const corpus = comparable([membershipText, ...conditions].filter(Boolean).join(' '));
  const membershipRequired =
    membershipText !== null ||
    /\b(?:clen|clenstvi|klub|club|clubcard|card|xtra|bonus|vernostni)\b/u.test(corpus) ||
    /\b(?:s|se|na)\s+(?:kartou|kartu)\b/u.test(corpus);
  const mobileAppRequired = /\b(?:mobilni\s+)?aplikac/u.test(corpus);
  const unsupportedConditions = conditions.filter((condition) => {
    const text = comparable(condition);
    return (
      /\bkupon/u.test(text) ||
      /\bpri\s+koupi\b/u.test(text) ||
      /\b(?:minimalne|min\.)\s*\d/u.test(text) ||
      /\b\d+\s*\+\s*\d+\b/u.test(text) ||
      /\bvybran(?:e|ych)\s+prodejn/u.test(text) ||
      /\bpouze\s+(?:online|pro\s+nove)/u.test(text)
    );
  });
  return { membershipRequired, mobileAppRequired, unsupportedConditions };
}

function absoluteUrl(value: string | null | undefined): string | null {
  const clean = value?.trim();
  if (!clean) return null;
  try {
    const url = new URL(clean, KUPI_ORIGIN);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function slugFromUrl(value: string): string {
  try {
    return new URL(value).pathname.split('/').filter(Boolean).at(-1) ?? '';
  } catch {
    return '';
  }
}

function parseLocation($: CheerioAPI): string {
  return (
    text($('.locality_near_headline [data-user-localizator]').first().text()) ||
    'Nezjištěná lokalita'
  );
}

function offerDeduplicationKey(offer: Offer): string {
  return (
    offer.id ??
    [offer.store, offer.price, offer.packageText, offer.validityText, offer.leafletUrl].join('|')
  );
}

export function deduplicateOffers(offers: Offer[]): Offer[] {
  const seen = new Map<string, Offer>();
  for (const offer of offers) {
    const key = offerDeduplicationKey(offer);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, offer);
    } else if (existing.sourceSection !== 'recommended' && offer.sourceSection === 'recommended') {
      seen.set(key, offer);
    }
  }
  return [...seen.values()];
}

function parseOffer(
  $: CheerioAPI,
  row: Selection,
  context: ParseContext,
  packageFallback: string | null,
  regularPrice: number | null,
): Offer {
  const priceText = text(row.find('.discount_price_value').first().text()) || null;
  const packageText =
    text(row.find('.discount_amount').first().text()).replace(/^\/\s*/u, '') || packageFallback;
  const unitPriceText = text(row.find('.price_per_unit').first().text()) || null;
  const unitPrice = unitPriceOf(unitPriceText);
  const discountText = text(row.find('.discount_percentage').first().text()) || null;
  const validityText = text(row.find('.discounts_validity').first().text()) || null;
  const validity = parseValidity(validityText, context.now);
  const membershipText = text(row.find('.discounts_club').first().text()) || null;
  const noteTexts = row
    .find('.discount_note')
    .map((_, element) => text($(element).text()))
    .get()
    .filter(Boolean);
  const allConditions = [membershipText, ...noteTexts].filter((value): value is string =>
    Boolean(value),
  );
  const conditionCorpus = allConditions.join(' ');
  const classified = classifyOfferConditions(membershipText, noteTexts);
  const sourceSection = row.closest('.recommended_discounts').length
    ? 'recommended'
    : row.closest('.promo_discounts').length
      ? 'price'
      : 'unknown';
  const leafletUrl = absoluteUrl(row.find('a.btn_link_leaflet').first().attr('href'));
  const store = canonicalStoreName(
    text(row.find('.discounts_shop_name').first().text()) || null,
    leafletUrl,
  );

  return {
    id: row.attr('data-discount')?.trim() || null,
    store,
    price: price(priceText),
    regularPrice,
    discountPercent: discountPercent(discountText),
    packageText,
    unitPrice: unitPrice.price,
    unitPriceUnit: unitPrice.unit,
    validFrom: validity.validFrom,
    validTo: validity.validTo,
    validityText,
    membershipRequired: classified.membershipRequired,
    membershipText,
    mobileAppRequired: classified.mobileAppRequired,
    quantityLimit: parseQuantityLimit(conditionCorpus),
    needsManualCheck: classified.unsupportedConditions.length > 0,
    unclearConditions: classified.unsupportedConditions,
    conditions: allConditions,
    leafletUrl,
    sourceUrl: context.sourceUrl,
    sourceSection,
    location: context.location,
    retrievedAt: context.retrievedAt,
  };
}

function parseRows(
  $: CheerioAPI,
  scope: Selection,
  context: ParseContext,
  packageText: string | null,
  regularPrice: number | null,
): Offer[] {
  const offers: Offer[] = [];
  scope.find('.discount_row').each((_, element) => {
    offers.push(parseOffer($, $(element), context, packageText, regularPrice));
  });
  return deduplicateOffers(offers);
}

function parseSearchProduct(
  $: CheerioAPI,
  group: Selection,
  context: ParseContext,
): Product | null {
  const header = group.children('.product--wrap').first();
  const productLink = header.find('.product_name h2 a[href^="/sleva/"]').first();
  const productUrl = absoluteUrl(productLink.attr('href'));
  const name = text(productLink.find('strong').first().text() || productLink.text());
  if (!productUrl || !name) return null;

  const packageText = text(header.find('.product_name h2 .nowrap').first().text()) || null;
  const packageValue = parsePackage(packageText);
  const regularPriceText = text(header.find('.avg_price span').first().text()) || null;
  const regularPrice = price(regularPriceText);
  const image = header.find('.product_image img').first();
  const imageUrl = absoluteUrl(image.attr('data-src') || image.attr('src'));

  return {
    id: header.attr('data-product-id')?.trim() || header.attr('data-product')?.trim() || null,
    name,
    slug: slugFromUrl(productUrl),
    packageText,
    quantity: packageValue?.amount ?? null,
    unit: packageValue?.unit ?? null,
    regularPrice,
    productUrl,
    imageUrl,
    offers: parseRows($, group, { ...context, sourceUrl: productUrl }, packageText, regularPrice),
    retrievedAt: context.retrievedAt,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStructuredProduct($: CheerioAPI): StructuredProduct | null {
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data: unknown = JSON.parse($(element).text());
      const record = recordValue(data);
      if (!record || record['@type'] !== 'Product') continue;
      const aggregate = recordValue(record.offers);
      const rawOffers = Array.isArray(aggregate?.offers) ? aggregate.offers : [];
      return {
        name: stringValue(record.name),
        image: stringValue(record.image),
        offers: rawOffers.map((raw) => {
          const offer = recordValue(raw);
          return {
            offeredBy: stringValue(offer?.offeredBy),
            price: numberValue(offer?.price),
            validTo: stringValue(offer?.priceValidUntil),
          };
        }),
      };
    } catch {
      // Ignore malformed third-party structured data and continue with visible HTML.
    }
  }
  return null;
}

function detailPackageText($: CheerioAPI): string | null {
  const blindHeading = text($('h2.blind').first().text());
  const packageMatch = blindHeading.match(
    /(\d+(?:[.,]\d+)?\s*(?:[×x]\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|ml|l|ks))\s*$/iu,
  );
  return packageMatch?.[1] ? text(packageMatch[1]) : null;
}

function supplementStructuredValidity(offers: Offer[], structured: StructuredProduct | null): void {
  if (!structured) return;
  for (const offer of offers) {
    if (offer.validTo) continue;
    const matches = structured.offers.filter(
      (candidate) =>
        candidate.offeredBy !== null &&
        matchesStoreSelector(offer.store, candidate.offeredBy) &&
        candidate.price !== null &&
        offer.price !== null &&
        Math.abs(candidate.price - offer.price) < 0.001,
    );
    const match = matches.length === 1 ? matches[0] : null;
    if (match?.validTo && /^\d{4}-\d{2}-\d{2}$/u.test(match.validTo)) {
      offer.validTo = match.validTo;
    }
  }
}

/**
 * Collects the "N nejbližších poboček" links the search page prints for each chain.
 * Each one points at that chain's nearest branch for the currently configured locality,
 * which is exactly the candidate a radius filter needs to verify.
 */
function parseBranchLinks($: CheerioAPI): Array<{ chain: string; path: string }> {
  const links = new Map<string, { chain: string; path: string }>();
  $('.discounts_markets a[href^="/obchod/"]').each((_index, element) => {
    const node = $(element);
    const href = node.attr('href')?.trim();
    // Chain pages are /obchod/{chain}; only the two-segment form is a branch.
    if (!href || !/^\/obchod\/[a-z0-9-]+\/[a-z0-9-]+$/u.test(href)) return;
    const row = node.closest('.discount_row');
    const leaflet = absoluteUrl(row.find('a.btn_link_leaflet').first().attr('href'));
    const visibleStore = text(row.find('.discounts_shop_name').first().text());
    const chain = canonicalStoreName(
      visibleStore || text(node.attr('data-shop') ?? node.attr('title') ?? ''),
      leaflet,
    );
    if (!chain) return;
    if (!links.has(href)) links.set(href, { chain, path: href });
  });
  return [...links.values()];
}

export class KupiParser {
  parseSearch(html: string, sourceUrl: string, retrievedAt: string): ParsedPage {
    const $ = load(html);
    const location = parseLocation($);
    const context: ParseContext = {
      sourceUrl,
      retrievedAt,
      now: new Date(retrievedAt),
      location,
    };
    const products: Product[] = [];
    $('.group_discounts').each((_, element) => {
      const product = parseSearchProduct($, $(element), context);
      if (product) products.push(product);
    });
    return {
      products,
      location,
      parseStatus:
        products.length > 0 ? 'ok' : $('#product_append').length > 0 ? 'empty' : 'unexpected',
      branchLinks: parseBranchLinks($),
      warnings:
        products.length === 0 && $('#product_append').length === 0
          ? ['Ve stránce nebyla rozpoznána očekávaná struktura výsledků.']
          : [],
    };
  }

  parseDetail(html: string, sourceUrl: string, retrievedAt: string): ParsedPage {
    const $ = load(html);
    const location = parseLocation($);
    const structured = parseStructuredProduct($);
    const scope = $('.group_discounts.detail_discounts').first();
    const name =
      text(scope.find('h1.product_detail_headline').first().text()) || structured?.name || '';
    if (!scope.length || !name) {
      return {
        products: [],
        location,
        branchLinks: [],
        parseStatus: 'unexpected',
        warnings: ['Detail produktu nemá očekávanou HTML strukturu.'],
      };
    }

    const packageText = detailPackageText($);
    const packageValue = parsePackage(packageText);
    const regularPriceText = text(scope.find('.avg_price span').first().text()) || null;
    const regularPrice = price(regularPriceText);
    const context: ParseContext = {
      sourceUrl,
      retrievedAt,
      now: new Date(retrievedAt),
      location,
    };
    const offers = parseRows($, scope, context, packageText, regularPrice);
    supplementStructuredValidity(offers, structured);
    const product: Product = {
      id:
        $('#product_id').attr('value')?.trim() ||
        scope.find('.discount_row').first().attr('data-product')?.trim() ||
        null,
      name,
      slug: slugFromUrl(sourceUrl),
      packageText,
      quantity: packageValue?.amount ?? null,
      unit: packageValue?.unit ?? null,
      regularPrice,
      productUrl: sourceUrl,
      imageUrl:
        absoluteUrl(scope.find('.product_image img').first().attr('src')) ||
        absoluteUrl(structured?.image),
      offers,
      retrievedAt,
    };
    return {
      products: [product],
      location,
      branchLinks: [],
      parseStatus: offers.length > 0 ? 'ok' : 'empty',
      warnings:
        offers.length === 0 ? ['Pro produkt nebyla rozpoznána žádná aktuální nabídka.'] : [],
    };
  }
}
