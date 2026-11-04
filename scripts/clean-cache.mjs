#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cacheRoot = resolve(__dirname, '..', '.cache', 'tailor');

rmSync(cacheRoot, { recursive: true, force: true });
console.log(`clean-cache: removed ${cacheRoot}`);
