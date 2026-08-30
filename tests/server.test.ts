import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { clientServing, config, page } from './page.js';

const butter = {
  name: 'Máslo',
  slug: 'maslo',
  packageText: '250 g',
  rows: [
    { store: 'Lidl', price: 17.9, unitPrice: '7,16 Kč / 100 g' },
    { store: 'Albert', price: 39.9, unitPrice: '15,96 Kč / 100 g' },
  ],
};

async function connect(html = page([butter])): Promise<Client> {
  const server = createServer(config(), clientServing(html));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP server', () => {
  it('exposes exactly the three read-only tools', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'compare_shopping_list',
      'get_product_offers',
      'search_products',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('answers a search with readable text alongside the structured result', async () => {
    const result = await (
      await connect()
    ).callTool({
      name: 'search_products',
      arguments: { query: 'máslo' },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Máslo');
    expect(text).toContain('17,90 Kč');
    // Never let a leaflet price read as a promise that the shop has it in stock.
    expect(text).toContain('není potvrzením skladové dostupnosti');
    expect(result.structuredContent).toMatchObject({ success: true });
  });

  it('reports a source failure as a structured error rather than an empty result', async () => {
    const server = createServer(config(), clientServing('<html><body>nic</body></html>'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'search_products',
      arguments: { query: 'máslo' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, error: { retryable: false } });
  });

  it('rejects a product lookup that gives both a URL and a slug', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'get_product_offers',
      arguments: { productUrl: 'https://www.kupi.cz/sleva/maslo', slug: 'maslo' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('právě jedno');
  });

  it('says plainly that an incomplete basket has no known total', async () => {
    const client = await connect(page([]));
    const result = await client.callTool({
      name: 'compare_shopping_list',
      arguments: { items: [{ query: 'kaviár' }] },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('NEÚPLNÝ košík');
    expect(text).toContain('NEJDE o cenu celého nákupu');
  });
});
