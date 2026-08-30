import { describe, expect, it } from 'vitest';
import {
  comparable,
  formatMeasure,
  holdsItemSize,
  number,
  parsePackage,
  parseValidity,
  planPackages,
  sameSize,
  toBase,
  today,
  validOn,
} from '../src/normalize.js';

describe('text and numbers', () => {
  it('folds diacritics and case for comparison', () => {
    expect(comparable('Vepřová Krkovice')).toBe('veprova krkovice');
  });

  it('reads Czech and English decimal styles', () => {
    expect(number('1 234,50')).toBe(1234.5);
    expect(number('1,234.50')).toBe(1234.5);
    expect(number('17,90 Kč')).toBe(17.9);
    expect(number('bez čísla')).toBeNull();
  });
});

describe('packages', () => {
  it('reads a single package into base units', () => {
    expect(parsePackage('500 g')).toMatchObject({ amount: 500, unit: 'g', count: 1, each: 500 });
    expect(parsePackage('0,5 l')).toMatchObject({ amount: 500, unit: 'ml', count: 1 });
  });

  it('keeps a multipack shape: count, item size and total', () => {
    expect(parsePackage('6 x 0,5 l')).toMatchObject({
      count: 6,
      each: 500,
      amount: 3000,
      unit: 'ml',
    });
  });

  it('treats differently written but equal sizes as the same', () => {
    expect(sameSize('0,5 l', '500 ml')).toBe(true);
    expect(sameSize('1 kg', '1000 g')).toBe(true);
    expect(sameSize('1 kg', '500 g')).toBe(false);
    // A six-pack is not a single bottle, however you write it.
    expect(sameSize('6 x 0,5 l', '0,5 l')).toBe(false);
  });

  it('knows a multipack holds items of the wanted size', () => {
    expect(holdsItemSize('6 x 0,5 l', '0,5 l')).toBe(true);
    expect(holdsItemSize('6 x 0,33 l', '0,5 l')).toBe(false);
  });
});

describe('how many packages to buy', () => {
  it('counts by weight when the request is a weight', () => {
    // 2 kg from 600 g packs is four packs, not two.
    expect(planPackages(toBase(2, 'kg'), parsePackage('600 g')!)).toMatchObject({
      packages: 4,
      purchased: 2400,
      overshoot: true,
    });
  });

  it('counts by pieces when the request is in pieces', () => {
    const sixPack = parsePackage('6 x 0,5 l')!;
    expect(planPackages(toBase(16, 'ks'), sixPack)).toMatchObject({ packages: 3, purchased: 18 });
    expect(planPackages(toBase(12, 'ks'), sixPack)).toMatchObject({
      packages: 2,
      purchased: 12,
      overshoot: false,
    });
    expect(planPackages(toBase(13, 'ks'), sixPack)?.packages).toBe(3);
  });

  it('counts a weight multipack by its total', () => {
    // 4 x 100 g is 400 g per pack, so a kilo needs three of them.
    expect(planPackages(toBase(1, 'kg'), parsePackage('4 x 100 g')!)).toMatchObject({
      packages: 3,
      purchased: 1200,
    });
  });

  it('refuses to compare incompatible units', () => {
    expect(planPackages(toBase(1, 'kg'), parsePackage('1 l')!)).toBeNull();
  });

  it('formats amounts the way a shopper reads them', () => {
    expect(formatMeasure(2400, 'g')).toBe('2,4 kg');
    expect(formatMeasure(500, 'ml')).toBe('500 ml');
    expect(formatMeasure(18, 'ks')).toBe('18 ks');
  });
});

describe('validity', () => {
  const now = new Date('2026-08-30T10:00:00Z');

  it('reads a date range', () => {
    expect(parseValidity('platí 29. 8. – 3. 9. 2026', now)).toEqual({
      validFrom: '2026-08-29',
      validTo: '2026-09-03',
    });
  });

  it('reads relative wording', () => {
    expect(parseValidity('zítra končí', now).validTo).toBe('2026-08-31');
    expect(parseValidity('dnes končí', now).validTo).toBe('2026-08-30');
  });

  it('never treats a future promotion as valid today', () => {
    const future = { validFrom: '2026-08-31', validTo: '2026-09-01' };
    expect(validOn(future, '2026-08-30')).toBe(false);
    expect(validOn(future, '2026-08-31')).toBe(true);
    expect(validOn(future, '2026-09-02')).toBe(false);
  });

  it('stays permissive when Kupi.cz printed no start date', () => {
    // Requiring one would discard most offers, which print only "platí do".
    expect(validOn({ validFrom: null, validTo: '2026-09-01' }, '2026-08-30')).toBe(true);
    expect(validOn({ validFrom: null, validTo: null }, '2026-08-30')).toBe(true);
  });

  it('reports the date in Prague, not in the server time zone', () => {
    expect(today(new Date('2026-08-30T21:30:00Z'))).toBe('2026-08-30');
    expect(today(new Date('2026-08-30T22:30:00Z'))).toBe('2026-08-31');
  });
});
