import { describe, expect, it } from 'vitest';
import { BasketPlanner } from '../src/basket.js';
import { KupiClient } from '../src/client.js';
import { SearchService } from '../src/search.js';
import type { BasketInput, BasketResult } from '../src/types.js';
import { config, page, type Item } from './page.js';

/** Answers each search with the page whose first product best matches the query. */
function planner(pages: Record<string, Item[]>): BasketPlanner {
  const client = new KupiClient(config(), {
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const query = url.searchParams.get('f') ?? '';
      const items = pages[query] ?? [];
      return new Response(page(items), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      });
    },
  });
  return new BasketPlanner(new SearchService(client));
}

const plan = (pages: Record<string, Item[]>, input: BasketInput): Promise<BasketResult> =>
  planner(pages).plan(input);

describe('basket', () => {
  it('reports no total for a basket it could not fully resolve', async () => {
    const result = await plan(
      {
        máslo: [
          {
            name: 'Máslo',
            slug: 'maslo',
            packageText: '250 g',
            rows: [{ store: 'Lidl', price: 17.9 }],
          },
        ],
        kaviár: [],
      },
      { items: [{ query: 'máslo' }, { query: 'kaviár' }] },
    );

    expect(result.status).toBe('partial');
    // The resolved part is not the price of the shopping; saying otherwise would be a lie
    // the caller has no way to detect.
    expect(result.totalPrice).toBeNull();
    expect(result.resolvedPrice).toBe(17.9);
    expect(result.unresolved.map((item) => item.query)).toEqual(['kaviár']);
  });

  it('gives a total only when every item is covered', async () => {
    const result = await plan(
      {
        máslo: [
          {
            name: 'Máslo',
            slug: 'maslo',
            packageText: '250 g',
            rows: [{ store: 'Lidl', price: 17.9 }],
          },
        ],
        chléb: [
          {
            name: 'Chléb',
            slug: 'chleb',
            packageText: '1 kg',
            rows: [{ store: 'Lidl', price: 29.9 }],
          },
        ],
      },
      { items: [{ query: 'máslo' }, { query: 'chléb' }] },
    );

    expect(result.status).toBe('complete');
    expect(result.totalPrice).toBe(47.8);
    expect(result.stores).toHaveLength(1);
  });

  it('buys whole packages and prices what is actually taken to the till', async () => {
    const result = await plan(
      {
        máslo: [
          {
            name: 'Máslo',
            slug: 'maslo',
            packageText: '250 g',
            rows: [{ store: 'Lidl', price: 17.9 }],
          },
        ],
      },
      { items: [{ query: 'máslo', amount: 1, unit: 'kg' }] },
    );

    const line = result.stores[0]?.lines[0];
    expect(line?.packages).toBe(4);
    expect(line?.purchasePrice).toBe(71.6);
    expect(line?.packagePrice).toBe(17.9);
  });

  it('counts the items inside a multipack rather than the packs', async () => {
    const result = await plan(
      {
        pivo: [
          {
            name: 'Pivo',
            slug: 'pivo',
            packageText: '6 x 0,5 l',
            rows: [{ store: 'Kaufland', price: 89.9 }],
          },
        ],
      },
      { items: [{ query: 'pivo', amount: 9, unit: 'l' }] },
    );

    const line = result.stores[0]?.lines[0];
    // 9 l is three multipacks of 3 l, not nine.
    expect(line?.packages).toBe(3);
    expect(line?.packCount).toBe(6);
    expect(line?.purchasedQuantity).toBe('9 l');
  });

  it('says when a whole package overshoots what was asked for', async () => {
    const result = await plan(
      {
        mouka: [
          {
            name: 'Mouka',
            slug: 'mouka',
            packageText: '1 kg',
            rows: [{ store: 'Lidl', price: 19.9 }],
          },
        ],
      },
      { items: [{ query: 'mouka', amount: 2.5, unit: 'kg' }] },
    );

    const line = result.stores[0]?.lines[0];
    expect(line?.packages).toBe(3);
    expect(line?.note).toMatch(/3 kg místo 2,5 kg/u);
  });

  it('leaves an item unresolved rather than substituting a required package size', async () => {
    const pages = {
      mléko: [
        {
          name: 'Mléko',
          slug: 'mleko',
          packageText: '1 l',
          rows: [{ store: 'Lidl', price: 21.9 }],
        },
      ],
    };

    const preferred = await plan(pages, {
      items: [{ query: 'mléko', package: { amount: 250, unit: 'ml', mode: 'preferred' } }],
    });
    expect(preferred.status).toBe('complete');

    const required = await plan(pages, {
      items: [{ query: 'mléko', package: { amount: 250, unit: 'ml', mode: 'required' } }],
    });
    expect(required.status).toBe('partial');
    expect(required.unresolved[0]?.reason).toMatch(/velikost balení/iu);
  });

  it('never picks a product that does not confidently answer the query', async () => {
    const result = await plan(
      {
        máslo: [
          {
            name: 'Margarín máslová příchuť Rama',
            slug: 'rama',
            packageText: '400 g',
            rows: [{ store: 'Penny', price: 24.9 }],
          },
        ],
      },
      { items: [{ query: 'máslo' }] },
    );

    // An unresolved item is a usable answer; the wrong product is not.
    expect(result.status).toBe('partial');
    expect(result.unresolved[0]?.reason).toMatch(/jistý produkt/iu);
  });

  it('uses a club price only when the shopper holds that card', async () => {
    const pages = {
      káva: [
        {
          name: 'Káva',
          slug: 'kava',
          packageText: '250 g',
          rows: [
            { store: 'Albert', price: 79.9, club: true },
            { store: 'Lidl', price: 99.9 },
          ],
        },
      ],
    };

    const without = await plan(pages, { items: [{ query: 'káva' }] });
    expect(without.stores[0]?.chain).toBe('Lidl');

    const withCard = await plan(pages, {
      items: [{ query: 'káva' }],
      availableMemberships: ['Albert'],
    });
    expect(withCard.stores[0]?.chain).toBe('Albert');
  });

  it('respects the maximum number of shops even when spreading out is cheaper', async () => {
    const pages = {
      máslo: [
        {
          name: 'Máslo',
          slug: 'maslo',
          packageText: '250 g',
          rows: [
            { store: 'Lidl', price: 17.9 },
            { store: 'Penny', price: 21.9 },
          ],
        },
      ],
      chléb: [
        {
          name: 'Chléb',
          slug: 'chleb',
          packageText: '1 kg',
          rows: [
            { store: 'Penny', price: 24.9 },
            { store: 'Lidl', price: 29.9 },
          ],
        },
      ],
    };

    const result = await plan(pages, {
      items: [{ query: 'máslo' }, { query: 'chléb' }],
      maxStores: 1,
    });
    expect(result.stores).toHaveLength(1);
    expect(result.status).toBe('complete');
  });

  it('skips shops the caller ruled out', async () => {
    const result = await plan(
      {
        máslo: [
          {
            name: 'Máslo',
            slug: 'maslo',
            packageText: '250 g',
            rows: [
              { store: 'Lidl', price: 17.9 },
              { store: 'Albert', price: 19.9 },
            ],
          },
        ],
      },
      { items: [{ query: 'máslo' }], excludedStores: ['Lidl'] },
    );
    expect(result.stores[0]?.chain).toBe('Albert');
  });

  it('refuses an offer that cannot supply the amount within its per-person limit', async () => {
    const pages = {
      máslo: [
        {
          name: 'Máslo',
          slug: 'maslo',
          packageText: '250 g',
          rows: [{ store: 'Lidl', price: 17.9, note: 'max 5 ks/osoba/den' }],
        },
      ],
    };

    // 1 kg is four packs, inside the limit of five.
    const within = await plan(pages, { items: [{ query: 'máslo', amount: 1, unit: 'kg' }] });
    expect(within.status).toBe('complete');
    expect(within.stores[0]?.lines[0]?.packages).toBe(4);

    // 2 kg is eight packs, which the shop will not sell at the promotional price.
    const over = await plan(pages, { items: [{ query: 'máslo', amount: 2, unit: 'kg' }] });
    expect(over.status).toBe('partial');
    expect(over.totalPrice).toBeNull();
    expect(over.unresolved[0]?.reason).toMatch(/omezena na 5 ks/u);
  });

  it('prefers the offer whose conditions can be checked when the price is the same', async () => {
    const result = await plan(
      {
        'kuřecí prsa': [
          {
            name: 'Kuřecí prsa',
            slug: 'kureci-prsa',
            packageText: '1 kg',
            rows: [
              { store: 'FLOP TOP', price: 149.9, note: 'pouze ve vybraných prodejnách' },
              { store: 'FLOP', price: 149.9 },
            ],
          },
        ],
      },
      { items: [{ query: 'kuřecí prsa' }] },
    );

    expect(result.stores[0]?.chain).toBe('FLOP');
    expect(result.stores[0]?.lines[0]?.offer.needsManualCheck).toBe(false);
  });

  it('still takes a genuinely cheaper offer despite an uncheckable condition', async () => {
    const result = await plan(
      {
        'kuřecí prsa': [
          {
            name: 'Kuřecí prsa',
            slug: 'kureci-prsa',
            packageText: '1 kg',
            rows: [
              { store: 'FLOP TOP', price: 119.9, note: 'pouze ve vybraných prodejnách' },
              { store: 'FLOP', price: 149.9 },
            ],
          },
        ],
      },
      { items: [{ query: 'kuřecí prsa' }] },
    );

    // The condition is a nuisance, not a disqualification: 20% cheaper still wins.
    expect(result.stores[0]?.chain).toBe('FLOP TOP');
    expect(result.stores[0]?.lines[0]?.note).toMatch(/nelze vyhodnotit/u);
  });
});
