export interface Locality {
  label: string;
  id: string;
  sublocalityId: string | null;
}

export interface Config {
  cacheTtlMs: number;
  timeoutMs: number;
  maxConcurrency: number;
  /** Spacing between requests. This, not Kupi.cz, is what governs throughput. */
  minRequestIntervalMs: number;
  maxRetries: number;
  maxResponseBytes: number;
  userAgent: string;
  /** Pre-known locality cookies; a name outside this list is never guessed at. */
  localities: Locality[];
}

function integer(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

const key = (value: string): string => value.trim().toLocaleLowerCase('cs-CZ');

/**
 * Parses `KUPI_LOCALITIES` as `Label:id[:sublocalityId]`, comma separated.
 *
 * These are cookie values the operator obtained from their own browser session; the
 * server never translates a town name into one, because the endpoint that would do so is
 * disallowed by robots.txt.
 */
function parseLocalities(raw: string): Locality[] {
  const localities: Locality[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',')) {
    if (entry.trim() === '') continue;
    const [label, id, sublocalityId] = entry.split(':').map((part) => part.trim());
    if (!label || !id) {
      throw new Error(`KUPI_LOCALITIES entry "${entry.trim()}" must be "Label:id".`);
    }
    if (!/^\d+$/u.test(id) || (sublocalityId && !/^\d+$/u.test(sublocalityId))) {
      throw new Error(`KUPI_LOCALITIES entry "${label}" must use numeric IDs.`);
    }
    if (seen.has(key(label))) throw new Error(`KUPI_LOCALITIES repeats the label "${label}".`);
    seen.add(key(label));
    localities.push({ label, id, sublocalityId: sublocalityId || null });
  }
  return localities;
}

export function loadConfig(): Config {
  return {
    cacheTtlMs: integer('KUPI_CACHE_TTL_MS', 30 * 60 * 1000, 60 * 1000),
    timeoutMs: integer('KUPI_TIMEOUT_MS', 15_000, 1_000),
    maxConcurrency: integer('KUPI_MAX_CONCURRENCY', 2, 1),
    // Above the ~360 ms a response typically takes, so requests stay effectively
    // sequential and never arrive as a burst.
    minRequestIntervalMs: integer('KUPI_MIN_REQUEST_INTERVAL_MS', 600, 0),
    maxRetries: integer('KUPI_MAX_RETRIES', 2, 0),
    maxResponseBytes: integer('KUPI_MAX_RESPONSE_BYTES', 2 * 1024 * 1024, 64 * 1024),
    userAgent:
      process.env.KUPI_USER_AGENT?.trim() ||
      'kupi-mcp/1.0 (unofficial read-only integration; set KUPI_USER_AGENT)',
    localities: parseLocalities(process.env.KUPI_LOCALITIES ?? ''),
  };
}

/** The configured locality matching a requested name, or null — never a guess. */
export function findLocality(config: Config, name: string | undefined): Locality | null {
  if (!name) return null;
  const wanted = key(name);
  return config.localities.find((locality) => key(locality.label) === wanted) ?? null;
}
