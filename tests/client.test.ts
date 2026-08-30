import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { KupiClient, KupiClientError, resolveProductUrl } from '../src/client.js';
import { SearchService } from '../src/search.js';

const fixture = (): Promise<string> =>
  readFile(new URL('./fixtures/search.html', import.meta.url), 'utf8');

function config(overrides: Partial<Config> = {}): Config {
  return {
    cacheTtlMs: 1_800_000,
    timeoutMs: 5_000,
    maxConcurrency: 2,
    minRequestIntervalMs: 0,
    maxRetries: 1,
    maxResponseBytes: 1_000_000,
    userAgent: 'kupi-mcp-test/0.1',
    localities: [],
    ...overrides,
  };
}

describe('KupiClient', () => {
  it('caches HTML by URL/query/location and sends configured location cookies', async () => {
    const html = await fixture();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('cookie')).toContain('user_locality=test-locality-id');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    });
    const client = new KupiClient(
      config({
        localities: [
          {
            label: 'Testovací lokalita',
            id: 'test-locality-id',
            sublocalityId: 'test-sublocality-id',
          },
        ],
      }),
      { fetch: fetchMock },
    );
    const first = await client.search('máslo', 'Testovací lokalita');
    const second = await client.search('máslo', 'Testovací lokalita');
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical searches after the semaphore wait', async () => {
    const html = await fixture();
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
    );
    const client = new KupiClient(config({ maxConcurrency: 1 }), { fetch: fetchMock });
    const [first, second] = await Promise.all([client.search('máslo'), client.search('máslo')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([first.fromCache, second.fromCache].sort()).toEqual([false, true]);
  });

  it('picks the matching locality out of several configured ones', async () => {
    const html = await fixture();
    const sentCookies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      sentCookies.push(new Headers(init?.headers).get('cookie') ?? '');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    });
    const client = new KupiClient(
      config({
        localities: [
          { label: 'Testov', id: 'prvni-id', sublocalityId: 'prvni-sub' },
          { label: 'Tretimesto', id: 'druhe-id', sublocalityId: null },
        ],
      }),
      { fetch: fetchMock },
    );

    const prvni = await client.search('máslo', 'Testov');
    expect(prvni.configuredLocationApplied).toBe(true);
    expect(sentCookies[0]).toContain('user_locality=prvni-id');
    expect(sentCookies[0]).toContain('user_slocality=prvni-sub');

    // Case-insensitive match, and an entry without a sublocality omits that cookie.
    const druhe = await client.search('máslo', 'tretimesto');
    expect(druhe.configuredLocationApplied).toBe(true);
    expect(sentCookies[1]).toContain('user_locality=druhe-id');
    expect(sentCookies[1]).not.toContain('user_slocality=');

    // Each locality is cached separately rather than reusing the first response.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // An unknown locality still falls back to the anonymous default, never a guessed ID.
    const brno = await client.search('máslo', 'Brno');
    expect(brno.configuredLocationApplied).toBe(false);
    expect(sentCookies[2]).not.toContain('user_locality=');
  });

  it('retries temporary 5xx responses and then succeeds', async () => {
    const html = await fixture();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
      )
      .mockResolvedValue(
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
      );
    const client = new KupiClient(config(), { fetch: fetchMock, sleep: async () => undefined });
    await expect(client.search('máslo')).resolves.toMatchObject({ fromCache: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 429 inside the same user call', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } }),
    );
    const client = new KupiClient(config({ maxRetries: 2 }), {
      fetch: fetchMock,
      sleep: async () => undefined,
    });
    await expect(client.search('máslo')).rejects.toMatchObject({ status: 429, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts redirects and enforces a budget across different searches', async () => {
    const html = await fixture();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: '/hledej?f=maslo-2' } }),
      )
      .mockResolvedValueOnce(
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
      );
    const client = new KupiClient(config(), { fetch: fetchMock, sleep: async () => undefined });
    const { metrics } = await client.runWithRequestBudget(2, () => client.search('máslo'));
    expect(metrics).toMatchObject({ requestCount: 2, redirects: 1, requestBudgetRemaining: 0 });

    await expect(
      client.runWithRequestBudget(1, async () => {
        await client.search('první');
        await client.search('druhý');
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_BUDGET_EXCEEDED' });
  });

  it('returns a structured client error for HTTP blocks without bypassing them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('Forbidden', { status: 403 }));
    const client = new KupiClient(config(), { fetch: fetchMock });
    const request = client.search('máslo');
    await expect(request).rejects.toMatchObject<KupiClientError>({
      code: 'BLOCKED',
      status: 403,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong content types and oversized responses', async () => {
    const wrongType = new KupiClient(config(), {
      fetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    });
    await expect(wrongType.search('máslo')).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const oversized = new KupiClient(config({ maxResponseBytes: 100 }), {
      fetch: async () =>
        new Response('<html></html>', {
          headers: { 'Content-Type': 'text/html', 'Content-Length': '101' },
        }),
    });
    await expect(oversized.search('máslo')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('strictly prevents SSRF through product URLs', () => {
    expect(resolveProductUrl('maslo')).toBe('https://www.kupi.cz/sleva/maslo');
    expect(resolveProductUrl('https://kupi.cz/sleva/maslo')).toBe(
      'https://www.kupi.cz/sleva/maslo',
    );
    expect(() => resolveProductUrl('http://www.kupi.cz/sleva/maslo')).toThrow(KupiClientError);
    expect(() => resolveProductUrl('https://evil.example/sleva/maslo')).toThrow(KupiClientError);
    expect(() => resolveProductUrl('https://www.kupi.cz/get-akce')).toThrow(KupiClientError);
  });

  it('fails closed when the source HTML no longer has the expected structure', async () => {
    const html = await readFile(new URL('./fixtures/unexpected.html', import.meta.url), 'utf8');
    const client = new KupiClient(config(), {
      fetch: async () =>
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
    });
    const service = new SearchService(client);
    await expect(service.search({ query: 'máslo' })).rejects.toThrow(/struktura/iu);
  });
});
