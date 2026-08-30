import type { Config } from '../src/config.js';
import { KupiClient } from '../src/client.js';

/** One offer row as the search page prints it. */
export interface Row {
  store: string;
  price: number;
  packageText?: string;
  unitPrice?: string;
  validity?: string;
  note?: string;
  club?: boolean;
  /** The badge on the leaflet. Many real offers carry none. */
  discountPercent?: number;
}

export interface Item {
  name: string;
  slug: string;
  packageText?: string;
  /** Kupi's "Běžná cena": an average across shops, not any one shop's former price. */
  regularPrice?: number;
  rows: Row[];
}

/**
 * Builds a search page from a description.
 *
 * Tests state the scenario rather than a wall of markup, but the markup is still the real
 * thing the parser sees, so a change to the page structure fails these too.
 */
export function page(items: Item[], location = 'Testovací lokalita'): string {
  const groups = items
    .map((item, index) => {
      const id = 1000 + index;
      const rows = item.rows
        .map(
          (row, rowIndex) => `
        <div class="discount_row" data-product="${id}" data-discount="${id}${rowIndex}">
          <span class="discounts_shop_name"><span>${row.store}</span></span>
          <strong class="discount_price_value">${row.price.toFixed(2).replace('.', ',')}&nbsp;Kč</strong>
          <div class="discount_amount">/ ${row.packageText ?? item.packageText ?? ''}</div>
          ${row.unitPrice ? `<span class="price_per_unit">${row.unitPrice}</span>` : ''}
          ${
            row.discountPercent !== undefined
              ? `<div class="discount_percentage">–${row.discountPercent}&nbsp;%</div>`
              : ''
          }
          <div class="discounts_validity">${row.validity ?? 'platí do 31. 12. 2099'}</div>
          ${row.club ? '<div class="discounts_club">Platí pro členy klubu</div>' : ''}
          ${row.note ? `<div class="discount_note"><span>${row.note}</span></div>` : ''}
        </div>`,
        )
        .join('');
      return `
      <div class="group_discounts active">
        <div class="product--wrap" data-product="${id}" data-product-id="${id}">
          <div class="product_name">
            <h2>
              <a href="/sleva/${item.slug}"><strong>${item.name}</strong></a>
              ${item.packageText ? `<span class="nowrap">${item.packageText}</span>` : ''}
            </h2>
          </div>
          ${
            item.regularPrice !== undefined
              ? `<div class="avg_price">Běžná cena: <span>${item.regularPrice
                  .toFixed(2)
                  .replace('.', ',')}</span>&nbsp;Kč</div>`
              : ''
          }
        </div>
        <div class="promo_discounts"><div class="product_discounts_overview">${rows}</div></div>
      </div>`;
    })
    .join('');

  return `<!doctype html><html lang="cs"><body>
    <h2>Výsledky hledání
      <span class="locality_near_headline">v lokalitě <a data-user-localizator>${location}</a></span>
    </h2>
    <div id="product_append">${groups}</div>
  </body></html>`;
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    cacheTtlMs: 1_800_000,
    timeoutMs: 5_000,
    maxConcurrency: 2,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    maxResponseBytes: 1_000_000,
    userAgent: 'kupi-mcp-test/1.0',
    localities: [],
    ...overrides,
  };
}

/** A client that answers every request with the given page. */
export function clientServing(html: string): KupiClient {
  return new KupiClient(config(), {
    fetch: async () =>
      new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
  });
}
