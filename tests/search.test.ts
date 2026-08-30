import { describe, expect, it } from 'vitest';
import { SearchService } from '../src/search.js';
import { clientServing, page } from './page.js';

const butter = {
  name: 'Máslo',
  slug: 'maslo',
  packageText: '250 g',
  rows: [
    { store: 'Lidl', price: 17.9, unitPrice: '7,16 Kč / 100 g' },
    { store: 'Albert', price: 39.9, unitPrice: '15,96 Kč / 100 g', club: true },
  ],
};

const margarine = {
  name: 'Margarín máslová příchuť Rama',
  slug: 'rama',
  packageText: '400 g',
  rows: [{ store: 'Penny', price: 24.9 }],
};

function service(items: Parameters<typeof page>[0]): SearchService {
  return new SearchService(clientServing(page(items)));
}

describe('search', () => {
  it('scores every product against the query, whatever the sort order', async () => {
    for (const sortBy of ['relevance', 'price', 'unit_price', 'discount'] as const) {
      const result = await service([butter, margarine]).search({ query: 'máslo', sortBy });
      // Sorting by price used to drop the score, leaving a caller no way to tell that the
      // cheapest row was margarine rather than butter.
      expect(result.products.every((product) => product.match !== undefined)).toBe(true);
    }
  });

  it('separates a differently named product from the one asked for', async () => {
    const result = await service([butter, margarine]).search({ query: 'máslo' });
    const scored = new Map(
      result.products.map((product) => [product.slug, product.match?.quality]),
    );
    expect(scored.get('maslo')).toBe('high');
    expect(scored.get('rama')).toBe('low');
  });

  it('strips packaging from the query before it reaches the source', async () => {
    const result = await service([butter]).search({ query: 'máslo 250 g' });
    // Kupi.cz finds nothing when the size is left in the search box.
    expect(result.searchQuery).toBe('máslo');
  });

  it('honours excluded words', async () => {
    const smoked = {
      name: 'Uzená makrela',
      slug: 'makrela',
      rows: [{ store: 'Lidl', price: 49.9 }],
    };
    const result = await service([smoked]).search({ query: 'makrela', exclude: ['uzená'] });
    expect(result.products[0]?.match?.quality).toBe('low');
  });

  it('keeps only offers valid on the requested day', async () => {
    const items = [
      {
        ...butter,
        rows: [
          { store: 'Lidl', price: 17.9, validity: 'platí 1. 9. – 10. 9. 2026' },
          { store: 'Albert', price: 19.9, validity: 'platí 20. 9. – 30. 9. 2026' },
        ],
      },
    ];
    const result = await service(items).search({ query: 'máslo', validOn: '2026-09-05' });
    expect(result.products[0]?.offers.map((offer) => offer.store)).toEqual(['Lidl']);
  });

  it('reports a promotion that has not started as a reason to wait, never as available', async () => {
    const items = [
      {
        ...butter,
        rows: [
          { store: 'Lidl', price: 25.9, validity: 'platí 1. 9. – 10. 9. 2026' },
          { store: 'Albert', price: 17.9, validity: 'platí 8. 9. – 14. 9. 2026' },
        ],
      },
    ];
    const result = await service(items).search({ query: 'máslo', validOn: '2026-09-05' });
    expect(result.products[0]?.offers.map((offer) => offer.store)).toEqual(['Lidl']);
    expect(result.upcoming).toHaveLength(1);
    expect(result.upcoming[0]).toMatchObject({
      store: 'Albert',
      startsInDays: 3,
      priceToday: 25.9,
      savingIfWaiting: 8,
    });
  });

  it('does not suggest waiting for a product that was not asked for', async () => {
    const items = [
      {
        ...margarine,
        rows: [{ store: 'Penny', price: 9.9, validity: 'platí 8. 9. – 14. 9. 2026' }],
      },
    ];
    const result = await service(items).search({ query: 'máslo', validOn: '2026-09-05' });
    expect(result.upcoming).toEqual([]);
  });

  it('filters by shop and by membership requirement', async () => {
    const onlyLidl = await service([butter]).search({ query: 'máslo', stores: ['Lidl'] });
    expect(onlyLidl.products[0]?.offers.map((offer) => offer.store)).toEqual(['Lidl']);

    const noClub = await service([butter]).search({ query: 'máslo', excludeMembershipOnly: true });
    expect(noClub.products[0]?.offers.every((offer) => !offer.membershipRequired)).toBe(true);
  });

  it('warns when the data came back for a different locality than was asked for', async () => {
    const client = clientServing(page([butter], 'Jiná lokalita'));
    const result = await new SearchService(client).search({ query: 'máslo', location: 'Testov' });
    expect(result.location).toBe('Jiná lokalita');
    expect(result.warnings.join(' ')).toContain('Jiná lokalita');
  });

  it('ranks a discount the leaflet never printed a percentage for', async () => {
    const items = [
      {
        name: 'Máslo levné',
        slug: 'maslo-levne',
        packageText: '250 g',
        regularPrice: 41.26,
        // 57% off, but the leaflet shows no badge, so discountPercent stays null.
        rows: [{ store: 'Lidl', price: 17.9 }],
      },
      {
        name: 'Máslo drahé',
        slug: 'maslo-drahe',
        packageText: '250 g',
        regularPrice: 41.26,
        rows: [{ store: 'Albert', price: 19.9, discountPercent: 50 }],
      },
    ];

    const result = await service(items).search({ query: 'máslo', sortBy: 'discount' });
    // It used to sort last: a missing percentage counted as no discount at all.
    expect(result.products[0]?.slug).toBe('maslo-levne');
    // Ordering only — the field itself must not claim a figure the source never gave.
    expect(result.products[0]?.offers[0]?.discountPercent).toBeNull();
  });

  it('does not compare a future price with today price for a different pack size', async () => {
    const items = [
      {
        name: 'Máslo',
        slug: 'maslo',
        rows: [
          {
            store: 'Lidl',
            price: 25.9,
            packageText: '250 g',
            validity: 'platí 1. 9. – 10. 9. 2026',
          },
          {
            store: 'Albert',
            price: 17.9,
            packageText: '150 g',
            validity: 'platí 8. 9. – 14. 9. 2026',
          },
        ],
      },
    ];

    const result = await service(items).search({ query: 'máslo', validOn: '2026-09-05' });
    expect(result.upcoming).toHaveLength(1);
    // 25,90 for 250 g against 17,90 for 150 g is not an 8 Kč saving, so no number is given.
    expect(result.upcoming[0]?.priceToday).toBeNull();
    expect(result.upcoming[0]?.savingIfWaiting).toBeNull();
  });

  it('refuses to return data when the page structure is no longer recognised', async () => {
    const client = clientServing('<!doctype html><html><body><p>nic</p></body></html>');
    await expect(new SearchService(client).search({ query: 'máslo' })).rejects.toThrow(
      /struktura/iu,
    );
  });
});
