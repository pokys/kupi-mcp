/**
 * Generates the branch snapshot the server reads instead of fetching branch pages.
 *
 * Addresses and coordinates change very rarely, so a generated file removes almost all
 * branch traffic from ordinary requests — including after a cold start, where an
 * in-memory cache is always empty.
 *
 *   npm run branches:refresh -- --location Mesto --radius 50
 *
 * Regional by design: crawling the country would be expensive and is not needed for a
 * radius search around one town. The file is merged, so runs for different towns
 * accumulate.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { BranchDirectory, branchKey } from '../dist/branches.js';
import { KupiClient } from '../dist/client.js';
import { loadConfig } from '../dist/config.js';
import { KupiParser } from '../dist/parser.js';

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const location = argument('location');
const radiusKm = Number(argument('radius', '50'));
const output = resolve(process.cwd(), argument('out', 'data/store-branches.json'));
/** Chosen to surface as many different chains as possible. */
const SEEDS = ['maslo', 'chleb', 'pivo', 'jogurt', 'kava'];

if (!location) {
  process.stderr.write('Použití: npm run branches:refresh -- --location Mesto [--radius 50]\n');
  process.exit(1);
}

const client = new KupiClient(loadConfig());
const parser = new KupiParser();
const branches = new BranchDirectory(client);

process.stdout.write(
  `Obnova snapshotu poboček\n  lokalita: ${location}\n  radius:   ${radiusKm} km\n`,
);

const links = new Map();
for (const query of SEEDS) {
  const fetched = await client.search(query, location);
  const page = parser.parseSearch(fetched.html, fetched.sourceUrl, fetched.retrievedAt);
  for (const link of page.branchLinks) links.set(link.path, link.chain);
  process.stdout.write(`  "${query}": ${page.branchLinks.length} odkazů na pobočky\n`);
}

const paths = [...links.keys()];
const origin = await branches.resolveOrigin(location, paths);
if (!origin) {
  process.stderr.write(
    `\nV lokalitě "${location}" nebyla ověřena žádná pobočka; snapshot nevznikl.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `  výchozí bod: ${origin.name} (${origin.coordinates.latitude}, ${origin.coordinates.longitude})\n`,
);

// Generous here on purpose: the runtime budget protects one request's latency, which does
// not apply to an offline run.
const found = await branches.near(origin.coordinates, paths, radiusKm, {
  fetches: 400,
  branches: 400,
});
process.stdout.write(`  nalezeno poboček: ${found.length}\n`);

const merged = new Map();
try {
  const existing = JSON.parse(await readFile(output, 'utf8'));
  for (const branch of existing.branches ?? []) merged.set(branchKey(branch), branch);
  process.stdout.write(`  převzato z předchozího snapshotu: ${merged.size}\n`);
} catch {
  // No previous snapshot is normal on a first run.
}

for (const branch of found) {
  // The branch, not the distance: distance depends on whoever is asking.
  const record = { ...branch };
  delete record.distanceKm;
  delete record.opening;
  delete record.branchApplicability;
  merged.set(branchKey(record), record);
}

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: 'kupi',
      branches: [...merged.values()].sort((left, right) =>
        `${left.chain}${left.name}`.localeCompare(`${right.chain}${right.name}`, 'cs-CZ'),
      ),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`\nUloženo ${merged.size} poboček do ${output}\n`);
