import { describe, expect, it } from 'vitest';
import { MEDIUM, parseQuery, score } from '../src/matching.js';

/** The right product must both outrank the wrong one and clear the usable threshold. */
function prefers(query: string, right: string, wrong: string): void {
  const good = score(query, right);
  const bad = score(query, wrong);
  expect(good.score, `${query} -> ${right}`).toBeGreaterThanOrEqual(MEDIUM);
  expect(bad.score, `${query} -> ${wrong}`).toBeLessThan(MEDIUM);
  expect(good.score).toBeGreaterThan(bad.score);
}

describe('semantic traps seen on the live site', () => {
  it('rejects a spread when the cheese was asked for', () => {
    prefers('hermelín', 'Hermelín', 'Pomazánka hermelínová Hruška');
  });

  it('rejects a butter-flavoured fat when butter was asked for', () => {
    prefers('máslo', 'Máslo', 'Tuk cukrářský máslová příchuť Stella');
  });

  it('rejects smoked and marinated pork when fresh was asked for', () => {
    prefers('vepřová krkovice', 'Vepřová krkovice bez kosti', 'Uzená vepřová krkovice');
    prefers('vepřová krkovice', 'Vepřová krkovice bez kosti', 'Vepřová krkovice marinovaná');
  });

  it('rejects a filled baguette when plain bread was asked for', () => {
    prefers('bageta', 'Bageta', 'Obložená bageta');
  });

  it('rejects a roasted snack when the vegetable was asked for', () => {
    prefers('kukuřice', 'Kukuřice sterilovaná', 'Pražená kukuřice snack');
  });

  it('rejects ready-made pulled chicken when raw fillets were asked for', () => {
    expect(score('kuřecí prsní řízky', 'Kuřecí prsní řízky').score).toBeGreaterThanOrEqual(MEDIUM);
    expect(score('kuřecí prsní řízky', 'Kuřecí prsa k natrhání sous vide').score).toBeLessThan(
      MEDIUM,
    );
  });

  it('does not penalise preservation, which leaves the product intact', () => {
    // Sterilised corn is still corn; only a change of nature should count against it.
    expect(score('kukuřice', 'Kukuřice sterilovaná').quality).toBe('high');
  });

  it('names what made a candidate different', () => {
    expect(score('hermelín', 'Pomazánka hermelínová').differs).toContain('pomazanka');
  });

  it('honours an explicit exclusion', () => {
    expect(score('krkovice', 'Uzená krkovice', ['uzená']).score).toBe(0);
  });
});

describe('query preprocessing', () => {
  it('separates the size from the product terms', () => {
    expect(parseQuery('hermelín 100 g')).toEqual({
      terms: 'hermelín',
      size: { amount: 100, unit: 'g' },
    });
  });

  it('keeps a meaningful number but drops the packaging', () => {
    // "pivo 10" is a beer strength; "0,5 l" is the bottle.
    expect(parseQuery('pivo 10° 0,5 l')).toEqual({
      terms: 'pivo',
      size: { amount: 0.5, unit: 'l' },
    });
  });

  it('drops a leading item count', () => {
    expect(parseQuery('4x Hermelín cca 100 g').terms).toBe('Hermelín');
    expect(parseQuery('16x pivo 10° 0,5 l').terms).toBe('pivo');
  });

  it('leaves a query without packaging alone', () => {
    expect(parseQuery('kuřecí prsní řízky')).toEqual({ terms: 'kuřecí prsní řízky' });
  });
});
