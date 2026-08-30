import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

const workspace = resolve(process.cwd());
const target = resolve(workspace, 'dist');

if (dirname(target) !== workspace || basename(target) !== 'dist') {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await rm(target, { recursive: true, force: true });
