#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error('[kupi-mcp] MCP server is running over stdio.');
}

main().catch((error: unknown) => {
  console.error('[kupi-mcp] Fatal error:', error);
  process.exitCode = 1;
});
