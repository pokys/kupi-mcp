import { comparable, text } from './normalize.js';

const ALBERT = 'albert';
const ALBERT_SUPERMARKET = 'Albert Supermarket';
const ALBERT_HYPERMARKET = 'Albert Hypermarket';

/**
 * Kupi often labels both Albert formats simply as "Albert" in the offer row. The
 * linked leaflet is more specific, so it is the authoritative format signal.
 */
export function canonicalStoreName(
  store: string | null,
  formatEvidence?: string | null,
): string | null {
  const clean = text(store ?? '') || null;
  if (!clean) return null;

  const normalizedStore = comparable(clean);
  if (!/^albert(?:\s+(?:supermarket|hypermarket))?$/u.test(normalizedStore)) return clean;

  const evidence = comparable(`${formatEvidence ?? ''} ${clean}`);
  if (/\balbert[\s/-]+hypermarket\b/u.test(evidence)) return ALBERT_HYPERMARKET;
  if (/\balbert[\s/-]+supermarket\b/u.test(evidence)) return ALBERT_SUPERMARKET;
  return 'Albert';
}

/** Generic "Albert" selects both formats; a format-specific selector selects only itself. */
export function matchesStoreSelector(store: string | null, selector: string): boolean {
  if (!store) return false;
  const normalizedStore = comparable(store);
  const normalizedSelector = comparable(selector);
  if (normalizedStore === normalizedSelector) return true;
  return normalizedSelector === ALBERT && normalizedStore.startsWith(`${ALBERT} `);
}
