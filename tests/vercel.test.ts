import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface VercelConfig {
  installCommand?: unknown;
  buildCommand?: unknown;
  outputDirectory?: unknown;
  functions?: Record<string, { includeFiles?: string; maxDuration?: number }>;
}

const config = async (): Promise<VercelConfig> =>
  JSON.parse(await readFile('vercel.json', 'utf8')) as VercelConfig;

describe('Vercel configuration', () => {
  it('installs dev dependencies, because the build needs the TypeScript compiler', async () => {
    // "--omit=dev" strips typescript and the build fails with "tsc: command not found".
    expect((await config()).installCommand).toBe('npm ci');
  });

  it('names a real output directory', async () => {
    // outputDirectory: null means "detect one", not "there is none", and the deploy then
    // fails looking for public/.
    expect((await config()).outputDirectory).toBe('public');
    expect((await stat('public')).isDirectory()).toBe(true);
  });

  it('bundles the branch snapshot with the MCP function', async () => {
    // The snapshot is read at runtime through a computed path, which file tracing cannot
    // see; without this an operator-generated data/ is simply absent from the bundle and
    // every branch is fetched live until the request times out.
    expect((await config()).functions?.['api/mcp.ts']?.includeFiles).toBe('data/**');
  });

  it('allows the MCP function long enough for a radius search', async () => {
    expect((await config()).functions?.['api/mcp.ts']?.maxDuration).toBe(60);
  });
});
