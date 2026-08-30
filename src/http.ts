import { timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { KupiClient } from './client.js';
import { createServer } from './server.js';

export interface HttpMcpConfig {
  bearerToken: string | null;
  allowUnauthenticated: boolean;
  allowedOrigins: string[];
  maxBodyBytes: number;
}

function booleanFromEnvironment(name: string): boolean {
  return ['1', 'true', 'yes'].includes(process.env[name]?.trim().toLocaleLowerCase('en-US') ?? '');
}

function positiveIntegerFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function loadHttpMcpConfig(): HttpMcpConfig {
  return {
    bearerToken: process.env.MCP_HTTP_BEARER_TOKEN?.trim() || null,
    allowUnauthenticated: booleanFromEnvironment('MCP_HTTP_ALLOW_UNAUTHENTICATED'),
    allowedOrigins: (process.env.MCP_HTTP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    maxBodyBytes: positiveIntegerFromEnvironment('MCP_HTTP_MAX_BODY_BYTES', 1024 * 1024),
  };
}

function jsonError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const init: ResponseInit = { status };
  if (headers) init.headers = headers;
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, init);
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function authorized(request: Request, config: HttpMcpConfig): boolean {
  if (!config.bearerToken) return config.allowUnauthenticated;
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    return tokenMatches(authorization.slice('Bearer '.length), config.bearerToken);
  }
  // Some MCP clients (e.g. claude.ai custom connectors configured for "None" sign-in)
  // cannot send a custom Authorization header, since that name is reserved for their
  // own OAuth flow. Accept X-Api-Key as an equivalent credential for those clients.
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) return tokenMatches(apiKey, config.bearerToken);
  return false;
}

function corsOrigin(request: Request, config: HttpMcpConfig): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) return origin;
  return '';
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
  headers.append('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class RequestTooLargeError extends Error {}

/** Enforces the body limit even for chunked requests without Content-Length. */
async function requestWithLimitedBody(request: Request, maximumBytes: number): Promise<Request> {
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
}

export function createHttpMcpHandler(
  kupiConfig: Config,
  httpConfig: HttpMcpConfig,
  sharedClient = new KupiClient(kupiConfig),
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const origin = corsOrigin(request, httpConfig);
    if (origin === '') {
      return jsonError(403, 'ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.');
    }
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 204 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Authorization, X-Api-Key, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (!httpConfig.bearerToken && !httpConfig.allowUnauthenticated) {
      return jsonError(
        503,
        'HTTP_AUTH_NOT_CONFIGURED',
        'Set MCP_HTTP_BEARER_TOKEN before exposing this endpoint.',
      );
    }
    if (!authorized(request, httpConfig)) {
      return withCors(
        jsonError(401, 'UNAUTHORIZED', 'A valid Bearer token is required.', {
          'WWW-Authenticate': 'Bearer',
        }),
        origin,
      );
    }

    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > httpConfig.maxBodyBytes) {
      return withCors(
        jsonError(413, 'REQUEST_TOO_LARGE', `Request exceeds ${httpConfig.maxBodyBytes} bytes.`),
        origin,
      );
    }

    let limitedRequest: Request;
    try {
      limitedRequest = await requestWithLimitedBody(request, httpConfig.maxBodyBytes);
    } catch (error) {
      if (!(error instanceof RequestTooLargeError)) throw error;
      return withCors(
        jsonError(413, 'REQUEST_TOO_LARGE', `Request exceeds ${httpConfig.maxBodyBytes} bytes.`),
        origin,
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createServer(kupiConfig, sharedClient);
    await server.connect(transport);
    const response = await transport.handleRequest(limitedRequest);
    return withCors(response, origin);
  };
}

let defaultHandler: ((request: Request) => Promise<Response>) | null = null;

async function fetchHandler(request: Request): Promise<Response> {
  defaultHandler ??= createHttpMcpHandler(loadConfig(), loadHttpMcpConfig());
  return defaultHandler(request);
}

export default { fetch: fetchHandler };
