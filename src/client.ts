import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config, Locality } from './config.js';

const KUPI_ORIGIN = 'https://www.kupi.cz';
const ALLOWED_HOSTS = new Set(['kupi.cz', 'www.kupi.cz']);

export type KupiErrorCode =
  | 'BLOCKED'
  | 'HTTP_ERROR'
  | 'INVALID_CONTENT'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'REQUEST_BUDGET_EXCEEDED'
  | 'INVALID_PRODUCT_URL';

export class KupiClientError extends Error {
  constructor(
    message: string,
    public readonly code: KupiErrorCode,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'KupiClientError';
  }
}

export interface FetchedDocument {
  html: string;
  sourceUrl: string;
  retrievedAt: string;
  requestedLocation: string | null;
  configuredLocationApplied: boolean;
  fromCache: boolean;
}

interface CachedDocument extends Omit<FetchedDocument, 'fromCache'> {
  expiresAt: number;
}

export interface KupiClientDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface KupiRequestMetrics {
  requestBudget: number;
  requestCount: number;
  cacheHits: number;
  retries: number;
  redirects: number;
  requestBudgetRemaining: number;
}

interface RequestContext {
  limit: number;
  requestCount: number;
  cacheHits: number;
  retries: number;
  redirects: number;
}

const MAX_CACHE_ENTRIES = 256;

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

function normalizeLocation(value: string): string {
  return value.trim().toLocaleLowerCase('cs-CZ');
}

export function resolveProductUrl(input: string): string {
  const value = input.trim();
  let url: URL;
  try {
    if (/^https?:\/\//iu.test(value)) {
      url = new URL(value);
    } else {
      const slug = value.replace(/^\/?sleva\//u, '');
      url = new URL(`/sleva/${slug}`, KUPI_ORIGIN);
    }
  } catch {
    throw new KupiClientError('The product URL or slug is invalid.', 'INVALID_PRODUCT_URL');
  }

  const valid =
    url.protocol === 'https:' &&
    ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase('en-US')) &&
    (url.port === '' || url.port === '443') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    /^\/sleva\/[a-z0-9][a-z0-9-]*$/u.test(url.pathname);
  if (!valid) {
    throw new KupiClientError(
      'Only HTTPS product URLs under https://www.kupi.cz/sleva/{slug} are allowed.',
      'INVALID_PRODUCT_URL',
    );
  }
  url.hostname = 'www.kupi.cz';
  return url.href;
}

export class KupiClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly semaphore: Semaphore;
  private readonly cache = new Map<string, CachedDocument>();
  private readonly cookieJars = new Map<string, Map<string, string>>();
  private readonly requestContexts = new AsyncLocalStorage<RequestContext>();
  private nextRequestAt = 0;
  /**
   * Where the time actually goes. Kept so a caller can tell self-imposed politeness
   * (`throttleWaitMs`) apart from the network and the parser, instead of guessing.
   */
  readonly stats = {
    requestCount: 0,
    /** Summed across requests, so with concurrency > 1 it can exceed wall-clock time. */
    throttleWaitMs: 0,
    /** Summed across requests, likewise. */
    networkMs: 0,
    cacheHits: 0,
    retries: 0,
    redirects: 0,
  };

  constructor(
    private readonly config: Config,
    dependencies: KupiClientDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.sleep =
      dependencies.sleep ?? ((milliseconds) => new Promise((r) => setTimeout(r, milliseconds)));
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  async search(query: string, requestedLocation?: string): Promise<FetchedDocument> {
    const url = new URL('/hledej', KUPI_ORIGIN);
    url.searchParams.set('f', query);
    return this.fetchHtml(url, requestedLocation);
  }

  /**
   * Fetches a public informational page such as a branch detail under `/obchod/`.
   * Restricted to that prefix so this cannot become a general-purpose fetcher, and so
   * the paths disallowed by robots.txt stay unreachable through it.
   */
  async getPage(path: string, requestedLocation?: string): Promise<FetchedDocument> {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (!/^\/obchod\/[a-z0-9-]+(?:\/[a-z0-9-]+)?$/u.test(normalized)) {
      throw new KupiClientError(
        'Only public /obchod/ pages can be fetched this way.',
        'INVALID_PRODUCT_URL',
      );
    }
    return this.fetchHtml(new URL(normalized, KUPI_ORIGIN), requestedLocation);
  }

  async getProduct(productUrlOrSlug: string, requestedLocation?: string): Promise<FetchedDocument> {
    return this.fetchHtml(new URL(resolveProductUrl(productUrlOrSlug)), requestedLocation);
  }

  clearCache(): void {
    this.cache.clear();
  }

  private cachedDocument(cacheKey: string): FetchedDocument | null {
    const cached = this.cache.get(cacheKey);
    if (!cached || cached.expiresAt <= this.now().getTime()) {
      if (cached) this.cache.delete(cacheKey);
      return null;
    }
    this.stats.cacheHits += 1;
    const context = this.requestContexts.getStore();
    if (context) context.cacheHits += 1;
    // Refresh insertion order so the bounded Map behaves as a small LRU cache.
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, cached);
    return {
      html: cached.html,
      sourceUrl: cached.sourceUrl,
      retrievedAt: cached.retrievedAt,
      requestedLocation: cached.requestedLocation,
      configuredLocationApplied: cached.configuredLocationApplied,
      fromCache: true,
    };
  }

  /**
   * Applies a hard budget to actual upstream fetches in one logical MCP call. Cache hits
   * are free; retries and redirects are not. AsyncLocalStorage keeps concurrent calls
   * isolated even when a Vercel instance shares one client.
   */
  async runWithRequestBudget<T>(
    maximumRequests: number,
    operation: () => Promise<T>,
  ): Promise<{ value: T; metrics: KupiRequestMetrics }> {
    const context: RequestContext = {
      limit: maximumRequests,
      requestCount: 0,
      cacheHits: 0,
      retries: 0,
      redirects: 0,
    };
    const value = await this.requestContexts.run(context, operation);
    return {
      value,
      metrics: {
        requestBudget: context.limit,
        requestCount: context.requestCount,
        cacheHits: context.cacheHits,
        retries: context.retries,
        redirects: context.redirects,
        requestBudgetRemaining: Math.max(0, context.limit - context.requestCount),
      },
    };
  }

  private resolveConfiguredLocation(requestedLocation?: string): Locality | null {
    if (!requestedLocation) return null;
    const requested = normalizeLocation(requestedLocation);
    return (
      this.config.localities.find(
        (location: Locality) => normalizeLocation(location.label) === requested,
      ) ?? null
    );
  }

  private async fetchHtml(url: URL, requestedLocation?: string): Promise<FetchedDocument> {
    this.validatePublicUrl(url);
    const configuredLocation = this.resolveConfiguredLocation(requestedLocation);
    const configuredLocationApplied = configuredLocation !== null;
    const locationKey = configuredLocation
      ? `configured:${normalizeLocation(configuredLocation.label)}`
      : `default:${requestedLocation ?? ''}`;
    const cacheKey = `${url.href}::${locationKey}`;
    const cached = this.cachedDocument(cacheKey);
    if (cached) return cached;

    const release = await this.semaphore.acquire();
    try {
      // Another concurrent call may have populated the cache while this one waited.
      const filledWhileWaiting = this.cachedDocument(cacheKey);
      if (filledWhileWaiting) return filledWhileWaiting;
      const html = await this.fetchWithRetries(url, configuredLocation, locationKey);
      const retrievedAt = this.now().toISOString();
      const document: Omit<FetchedDocument, 'fromCache'> = {
        html,
        sourceUrl: url.href,
        retrievedAt,
        requestedLocation: requestedLocation?.trim() || null,
        configuredLocationApplied,
      };
      this.cache.set(cacheKey, {
        ...document,
        expiresAt: this.now().getTime() + this.config.cacheTtlMs,
      });
      while (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return { ...document, fromCache: false };
    } finally {
      release();
    }
  }

  private async fetchWithRetries(
    url: URL,
    configuredLocation: Locality | null,
    locationKey: string,
  ): Promise<string> {
    let lastError: KupiClientError | null = null;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        this.stats.retries += 1;
        const context = this.requestContexts.getStore();
        if (context) context.retries += 1;
        await this.sleep(Math.min(4_000, 500 * 2 ** (attempt - 1)));
      }
      try {
        return await this.fetchOnce(url, configuredLocation, locationKey);
      } catch (error) {
        const clientError = this.asClientError(error);
        lastError = clientError;
        // A 429 explicitly asks us to back off. Never retry it inside the same user call.
        if (
          clientError.status === 429 ||
          !clientError.retryable ||
          attempt === this.config.maxRetries
        ) {
          throw clientError;
        }
      }
    }
    throw lastError ?? new KupiClientError('Unknown HTTP failure.', 'NETWORK_ERROR');
  }

  /**
   * Spaces requests out by `minRequestIntervalMs`.
   *
   * Note this reserves a slot on a single global timeline, so it serialises every request
   * regardless of `maxConcurrency`: with a 1000 ms interval, twelve searches take at least
   * twelve seconds no matter how many may run at once.
   */
  private async waitForRateLimit(): Promise<void> {
    const current = this.now().getTime();
    const wait = Math.max(0, this.nextRequestAt - current);
    this.nextRequestAt = Math.max(current, this.nextRequestAt) + this.config.minRequestIntervalMs;
    this.stats.throttleWaitMs += wait;
    if (wait > 0) await this.sleep(wait);
  }

  private async fetchOnce(
    initialUrl: URL,
    configuredLocation: Locality | null,
    locationKey: string,
  ): Promise<string> {
    const cookieJar = this.cookieJars.get(locationKey) ?? new Map<string, string>();
    this.cookieJars.set(locationKey, cookieJar);
    let url = initialUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      // Budget and throttling apply to every physical fetch, including redirects.
      this.consumeRequestBudget();
      await this.waitForRateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response: Response;
      const networkStarted = this.now().getTime();
      try {
        this.stats.requestCount += 1;
        response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: this.requestHeaders(configuredLocation, cookieJar),
          signal: controller.signal,
        });
        this.stats.networkMs += this.now().getTime() - networkStarted;
      } catch (error) {
        this.stats.networkMs += this.now().getTime() - networkStarted;
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new KupiClientError(
            `Kupi.cz did not respond within ${this.config.timeoutMs} ms.`,
            'TIMEOUT',
            null,
            true,
          );
        }
        throw new KupiClientError(
          `Network request to Kupi.cz failed: ${error instanceof Error ? error.message : String(error)}`,
          'NETWORK_ERROR',
          null,
          true,
        );
      } finally {
        clearTimeout(timeout);
      }

      this.captureCookies(response.headers, cookieJar);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirect === 3) {
          throw new KupiClientError(
            'Kupi.cz returned an invalid redirect.',
            'HTTP_ERROR',
            response.status,
          );
        }
        url = new URL(location, url);
        this.validatePublicUrl(url);
        this.stats.redirects += 1;
        const context = this.requestContexts.getStore();
        if (context) context.redirects += 1;
        continue;
      }

      if (response.status === 403) {
        throw new KupiClientError(
          'Kupi.cz denied the request (HTTP 403). No attempt was made to bypass the block.',
          'BLOCKED',
          403,
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new KupiClientError(
          `Kupi.cz rate-limited the request (HTTP 429).${retryAfter ? ` Retry after ${retryAfter}.` : ' Try again later.'}`,
          'HTTP_ERROR',
          429,
          true,
        );
      }
      if (response.status >= 500 && response.status <= 599) {
        throw new KupiClientError(
          `Kupi.cz returned a temporary server error (HTTP ${response.status}).`,
          'HTTP_ERROR',
          response.status,
          true,
        );
      }
      if (!response.ok) {
        throw new KupiClientError(
          `Kupi.cz returned HTTP ${response.status}.`,
          'HTTP_ERROR',
          response.status,
        );
      }

      const contentType = response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
      if (!contentType.startsWith('text/html')) {
        throw new KupiClientError(
          `Expected text/html from Kupi.cz, received ${contentType || 'no Content-Type'}.`,
          'INVALID_CONTENT',
          response.status,
        );
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > this.config.maxResponseBytes) {
        throw new KupiClientError(
          `Kupi.cz response exceeds ${this.config.maxResponseBytes} bytes.`,
          'RESPONSE_TOO_LARGE',
          response.status,
        );
      }

      const html = await this.readLimitedBody(response);
      if (/captcha|recaptcha|cf-chl-captcha/iu.test(html)) {
        throw new KupiClientError(
          'Kupi.cz returned a CAPTCHA or challenge page. No attempt was made to bypass it.',
          'BLOCKED',
          response.status,
        );
      }
      return html;
    }
    throw new KupiClientError('Too many redirects from Kupi.cz.', 'HTTP_ERROR');
  }

  private requestHeaders(
    configuredLocation: Locality | null,
    cookieJar: Map<string, string>,
  ): HeadersInit {
    const cookies = new Map(cookieJar);
    if (configuredLocation) {
      cookies.set('user_locality', configuredLocation.id);
      if (configuredLocation.sublocalityId) {
        cookies.set('user_slocality', configuredLocation.sublocalityId);
      }
    }
    const headers: Record<string, string> = {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.5',
      'User-Agent': this.config.userAgent,
    };
    if (cookies.size > 0) {
      headers.Cookie = [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    }
    return headers;
  }

  private captureCookies(headers: Headers, cookieJar: Map<string, string>): void {
    const compatibleHeaders = headers as Headers & { getSetCookie?: () => string[] };
    const values = compatibleHeaders.getSetCookie?.() ?? [];
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair?.indexOf('=') ?? -1;
      if (pair && separator > 0) {
        cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }

  private async readLimitedBody(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let result = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > this.config.maxResponseBytes) {
        await reader.cancel();
        throw new KupiClientError(
          `Kupi.cz response exceeds ${this.config.maxResponseBytes} bytes.`,
          'RESPONSE_TOO_LARGE',
          response.status,
        );
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  private validatePublicUrl(url: URL): void {
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase('en-US')) ||
      (url.port !== '' && url.port !== '443') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new KupiClientError(
        'Only public HTTPS pages on Kupi.cz are allowed.',
        'INVALID_PRODUCT_URL',
      );
    }
    const allowedPath =
      url.pathname === '/hledej' ||
      /^\/sleva\/[a-z0-9][a-z0-9-]*$/u.test(url.pathname) ||
      // Public chain and branch pages; the branch form carries the store's address.
      /^\/obchod\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u.test(url.pathname);
    if (!allowedPath) {
      throw new KupiClientError(
        'This Kupi.cz path is not allowed by the client.',
        'INVALID_PRODUCT_URL',
      );
    }
  }

  private consumeRequestBudget(): void {
    const context = this.requestContexts.getStore();
    if (!context) return;
    if (context.requestCount >= context.limit) {
      throw new KupiClientError(
        `Upstream request budget of ${context.limit} was exhausted. Narrow the request or try again after cached data is available.`,
        'REQUEST_BUDGET_EXCEEDED',
      );
    }
    context.requestCount += 1;
  }

  private asClientError(error: unknown): KupiClientError {
    return error instanceof KupiClientError
      ? error
      : new KupiClientError(
          error instanceof Error ? error.message : String(error),
          'NETWORK_ERROR',
          null,
          true,
        );
  }
}
