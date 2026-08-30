import { describe, expect, it } from 'vitest';
import { deriveUnitPrice, normalizeUnitPrice, packageFit, priceSanity } from '../src/pricing.js';
import type { UnitPrice } from '../src/types.js';

const perKg = (value: number): UnitPrice => ({ value, currency: 'CZK', per: 'kg' });

describe('unit prices state their basis', () => {
  it('normalises any printed basis to one scale', () => {
    // Regression: a value per kilogram labelled "g" reads as a thousandth of the price.
    expect(normalizeUnitPrice(49.9, '100 g')).toEqual({ value: 499, currency: 'CZK', per: 'kg' });
    expect(normalizeUnitPrice(24.9, '500 ml')).toEqual({ value: 49.8, currency: 'CZK', per: 'l' });
    expect(normalizeUnitPrice(19.9, '200 g')).toEqual({ value: 99.5, currency: 'CZK', per: 'kg' });
    expect(normalizeUnitPrice(12.9, '1 ks')).toEqual({ value: 12.9, currency: 'CZK', per: 'ks' });
  });

  it('derives one from the package when none was printed', () => {
    expect(deriveUnitPrice(100, '500 g')?.value).toBe(200);
    expect(deriveUnitPrice(220, '1 kg')?.value).toBe(220);
  });

  it('refuses unusable input instead of guessing', () => {
    expect(normalizeUnitPrice(null, '1 kg')).toBeNull();
    expect(normalizeUnitPrice(10, 'za balení')).toBeNull();
  });
});

describe('price sanity', () => {
  it('sees nothing wrong in an ordinary spread', () => {
    const population = [100, 120, 140].map(perKg);
    expect(priceSanity(perKg(120), population).status).toBe('normal');
  });

  it('flags the live bio-chicken case', () => {
    const population = [99.9, 129.9, 149.83, 169.9, 199.8, 499.67].map(perKg);
    const result = priceSanity(perKg(499.67), population);
    expect(result.status).toBe('extreme');
    expect(result.ratioToMedian).toBeGreaterThan(3);
    expect(priceSanity(perKg(129.9), population).status).toBe('normal');
  });

  it('will not judge a lone candidate', () => {
    expect(priceSanity(perKg(500), [perKg(500)]).status).toBe('unknown');
  });

  it('withholds the softer verdict on a small sample', () => {
    expect(priceSanity(perKg(220), [100, 110, 220].map(perKg)).status).toBe('normal');
    expect(priceSanity(perKg(220), [100, 105, 110, 115, 220].map(perKg)).status).toBe('high');
  });

  it('never mixes bases into one median', () => {
    const mixed: UnitPrice[] = [
      perKg(100),
      perKg(120),
      { value: 5, currency: 'CZK', per: 'ks' },
      { value: 6, currency: 'CZK', per: 'ks' },
      { value: 7, currency: 'CZK', per: 'ks' },
    ];
    expect(priceSanity({ value: 6, currency: 'CZK', per: 'ks' }, mixed).sample).toBe(3);
    // Only two comparable weight candidates, so no verdict for that one.
    expect(priceSanity(perKg(100), mixed).status).toBe('unknown');
  });
});

describe('package preference', () => {
  const preferred = { amount: 2, unit: 'l' as const, mode: 'preferred' as const };
  const required = { amount: 0.5, unit: 'l' as const, mode: 'required' as const };

  it('does not constrain when nothing was asked for', () => {
    expect(packageFit(null, '0,33 l')).toMatchObject({ penalty: 0, usable: true });
  });

  it('scores by how far the size strays, not yes or no', () => {
    const sizes = ['2 l', '1,75 l', '1,5 l', '1 l', '0,5 l', '0,33 l'];
    const penalties = sizes.map((size) => packageFit(preferred, size).penalty);
    for (let i = 1; i < penalties.length; i += 1) {
      expect(penalties[i]!, sizes[i]).toBeGreaterThan(penalties[i - 1]!);
    }
  });

  it('accepts equivalent spellings as exact', () => {
    expect(packageFit(required, '500 ml')).toMatchObject({ penalty: 0, usable: true });
  });

  it('refuses another size when the size is required', () => {
    expect(packageFit(required, '0,33 l').usable).toBe(false);
    expect(packageFit(required, '0,5 l').usable).toBe(true);
  });

  it('accepts a multipack holding the required item size', () => {
    expect(packageFit(required, '6 x 0,5 l').usable).toBe(true);
    expect(packageFit(required, '6 x 0,33 l').usable).toBe(false);
  });
});
