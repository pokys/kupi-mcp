import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createHttpMcpHandler, type HttpMcpConfig } from '../src/http.js';

const kupiConfig: Config = {
  cacheTtlMs: 1_800_000,
  timeoutMs: 5_000,
  maxConcurrency: 2,
  minRequestIntervalMs: 0,
  maxRetries: 0,
  maxResponseBytes: 1_000_000,
  userAgent: 'kupi-mcp-http-test/0.1',
  localities: [],
};

function httpConfig(overrides: Partial<HttpMcpConfig> = {}): HttpMcpConfig {
  return {
    bearerToken: 'test-secret',
    allowUnauthenticated: false,
    allowedOrigins: ['https://client.example'],
    maxBodyBytes: 1_000_000,
    ...overrides,
  };
}

describe('Streamable HTTP MCP handler', () => {
  it('fails closed when HTTP authentication is not configured', async () => {
    const handler = createHttpMcpHandler(
      kupiConfig,
      httpConfig({ bearerToken: null, allowUnauthenticated: false }),
    );
    const response = await handler(
      new Request('https://server.example/api/mcp', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'HTTP_AUTH_NOT_CONFIGURED' },
    });
  });

  it('rejects invalid tokens and browser origins', async () => {
    const handler = createHttpMcpHandler(kupiConfig, httpConfig());
    const unauthorized = await handler(
      new Request('https://server.example/api/mcp', { method: 'POST', body: '{}' }),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');

    const wrongOrigin = await handler(
      new Request('https://server.example/api/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret', Origin: 'https://evil.example' },
        body: '{}',
      }),
    );
    expect(wrongOrigin.status).toBe(403);
  });

  it('accepts X-Api-Key as an alternative to the Authorization header', async () => {
    const handler = createHttpMcpHandler(kupiConfig, httpConfig());

    const wrongKey = await handler(
      new Request('https://server.example/api/mcp', {
        method: 'POST',
        headers: { 'X-Api-Key': 'wrong-secret' },
        body: '{}',
      }),
    );
    expect(wrongKey.status).toBe(401);

    const fetchThroughHandler: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handler(request);
    };
    const transport = new StreamableHTTPClientTransport(new URL('https://server.example/api/mcp'), {
      fetch: fetchThroughHandler,
      requestInit: { headers: { 'X-Api-Key': 'test-secret' } },
    });
    const client = new Client({ name: 'http-test-client', version: '0.1.0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('handles CORS preflight only for configured origins', async () => {
    const handler = createHttpMcpHandler(kupiConfig, httpConfig());
    const response = await handler(
      new Request('https://server.example/api/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://client.example' },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://client.example');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('rejects an oversized streamed body without relying on Content-Length', async () => {
    const handler = createHttpMcpHandler(kupiConfig, httpConfig({ maxBodyBytes: 100 }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(101)));
        controller.close();
      },
    });
    const response = await handler(
      new Request('https://server.example/api/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
        body,
        duplex: 'half',
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REQUEST_TOO_LARGE' },
    });
  });

  it('completes an MCP handshake and lists tools through stateless HTTP', async () => {
    const handler = createHttpMcpHandler(kupiConfig, httpConfig());
    const fetchThroughHandler: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handler(request);
    };
    const transport = new StreamableHTTPClientTransport(new URL('https://server.example/api/mcp'), {
      fetch: fetchThroughHandler,
      requestInit: { headers: { Authorization: 'Bearer test-secret' } },
    });
    const client = new Client({ name: 'http-test-client', version: '0.1.0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'compare_shopping_list',
        'get_product_offers',
        'search_products',
      ]);
    } finally {
      await client.close();
    }
  });
});
