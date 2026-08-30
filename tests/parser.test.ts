import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { KupiParser, classifyOfferConditions } from '../src/parser.js';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const parser = new KupiParser();
const AT = '2026-08-30T06:00:00.000Z';

describe('search page', () => {
  it('reads products, offers and the locality the data is for', async () => {
    const page = parser.parseSearch(await fixture('search.html'), 'https://www.kupi.cz/hledej', AT);
    expect(page.parseStatus).toBe('ok');
    expect(page.products.length).toBeGreaterThan(0);
    expect(page.location).toBeTruthy();

    const first = page.products[0];
    expect(first?.name).toBeTruthy();
    expect(first?.productUrl).toMatch(/^https:\/\/www\.kupi\.cz\/sleva\//u);
    expect(first?.offers.length).toBeGreaterThan(0);
  });

  it('collects the nearest-branch link each chain advertises', async () => {
    const page = parser.parseSearch(await fixture('search.html'), 'https://www.kupi.cz/hledej', AT);
    for (const link of page.branchLinks) {
      expect(link.path).toMatch(/^\/obchod\/[a-z0-9-]+\/[a-z0-9-]+$/u);
      expect(link.chain).toBeTruthy();
    }
  });

  it('reports unexpected HTML rather than an empty result', async () => {
    const page = parser.parseSearch(
      await fixture('unexpected.html'),
      'https://www.kupi.cz/hledej',
      AT,
    );
    // Silently returning nothing would be indistinguishable from "no sales today".
    expect(page.parseStatus).toBe('unexpected');
  });
});

describe('offer conditions', () => {
  it('recognises a club price even without the word "klub"', () => {
    expect(classifyOfferConditions('Cena s Kaufland Card XTRA', []).membershipRequired).toBe(true);
  });

  it('flags conditions whose price effect cannot be worked out', () => {
    for (const condition of [
      's kuponem z aplikace',
      'při koupi 2 ks',
      '2 + 1 zdarma',
      'pouze na vybraných prodejnách',
    ]) {
      expect(
        classifyOfferConditions(null, [condition]).unsupportedConditions,
        condition,
      ).not.toHaveLength(0);
    }
  });

  it('leaves a plain quantity limit alone, since it does not change the price', () => {
    expect(classifyOfferConditions(null, ['max 12 ks/osoba/den']).unsupportedConditions).toEqual(
      [],
    );
  });
});
