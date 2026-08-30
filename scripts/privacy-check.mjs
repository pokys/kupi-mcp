import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.cwd());
const ignoredDirectories = new Set([
  '.git',
  '.vercel',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
]);
const binaryExtensions = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
  '.zip',
]);
const forbidden = [
  {
    label: 'e-mail address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    label: 'absolute Windows user-home path',
    pattern: /\b[A-Z]:[\\/]Users[\\/][^\\/\s]+/giu,
  },
  {
    label: 'absolute Unix user-home path',
    pattern: /\/(?:Users|home)\/[^/\s]+/gu,
  },
  {
    label: 'literal Kupi locality cookie value',
    pattern: /\buser_(?:s)?locality=\d+\b/gu,
  },
  {
    // Same secret, different spelling: KUPI_LOCALITIES carries the very cookie IDs the
    // rule above exists to keep out. Documentation examples must use placeholders.
    label: 'literal locality ID in a KUPI_LOCALITIES value',
    pattern: /[^\s:,]+:\d{4,}(?::\d+)?/gu,
    onlyNear: /KUPI_LOCALITIES/u,
  },
];

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesIn(absolute)));
    if (entry.isFile() && !binaryExtensions.has(extname(entry.name).toLocaleLowerCase('en-US'))) {
      result.push(absolute);
    }
  }
  return result;
}

const findings = [];
for (const file of await filesIn(root)) {
  const text = await readFile(file, 'utf8');
  for (const rule of forbidden) {
    // A rule may only apply to lines mentioning a marker, so that a broad pattern can be
    // used narrowly instead of matching every colon-number pair in the repository.
    const scope = rule.onlyNear
      ? text
          .split(/\r?\n/u)
          .filter((line) => rule.onlyNear.test(line))
          .join('\n')
      : text;
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(scope)) {
      findings.push(`${relative(root, file)}: ${rule.label}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Privacy check failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Privacy check passed: no e-mail, user-home path, or literal locality ID found.\n',
  );
}
