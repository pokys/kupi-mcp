import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { ZipArchive } from 'archiver';

const workspace = resolve(process.cwd());
const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
const outputDirectory = join(workspace, 'artifacts');
const outputPath = join(outputDirectory, `${packageJson.name}-${packageJson.version}.zip`);
const fixedDate = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 946684800) * 1000);
const allowedFiles = [
  'LICENSE',
  'README.md',
  'package-lock.json',
  'package.json',
  'scripts/clean.mjs',
  'tsconfig.json',
  'tsconfig.vercel.json',
  'vercel.json',
];
const allowedDirectories = new Map([
  ['api', new Set(['.ts'])],
  ['dist', new Set(['.js', '.map', '.ts'])],
  ['src', new Set(['.ts'])],
]);
const allowedPublicFiles = new Set(['favicon.ico', 'icon-512.png', 'icon.png', 'robots.txt']);

async function collect(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(absolute, extensions)));
    if (entry.isFile() && extensions.has(extname(entry.name))) files.push(absolute);
  }
  return files;
}

const packagedFiles = allowedFiles.map((file) => join(workspace, file));
for (const [directory, extensions] of allowedDirectories) {
  packagedFiles.push(...(await collect(join(workspace, directory), extensions)));
}
for (const file of allowedPublicFiles) packagedFiles.push(join(workspace, 'public', file));

await mkdir(outputDirectory, { recursive: true });
const output = createWriteStream(outputPath);
const archive = new ZipArchive({ zlib: { level: 9 } });
const completed = new Promise((resolvePromise, rejectPromise) => {
  output.on('close', resolvePromise);
  output.on('error', rejectPromise);
  archive.on('error', rejectPromise);
});
archive.pipe(output);

for (const absolute of packagedFiles) {
  const metadata = await stat(absolute);
  const name = relative(workspace, absolute).split(sep).join('/');
  archive.file(absolute, {
    name,
    date: fixedDate,
    mode: metadata.mode & 0o777,
  });
}

archive.append(
  `${JSON.stringify(
    {
      name: packageJson.name,
      version: packageJson.version,
      node: packageJson.engines?.node ?? null,
      entrypoints: { stdio: 'dist/index.js', vercel: 'api/mcp.ts' },
    },
    null,
    2,
  )}\n`,
  { name: 'artifact-manifest.json', date: fixedDate, mode: 0o644 },
);
await archive.finalize();
await completed;

process.stdout.write(`${relative(workspace, outputPath)} (${archive.pointer()} bytes)\n`);
