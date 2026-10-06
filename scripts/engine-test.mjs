#!/usr/bin/env node
// 用 esbuild 把引擎测试打包成单文件 ESM，再交给 node --test 运行。
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'node_modules/.cache/rollout.test.mjs');

await build({
  entryPoints: [path.join(root, 'src/services/rollout.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning'
});

const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
await rm(outfile, { force: true }).catch(() => {});
process.exit(result.status ?? 1);
