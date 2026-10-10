/** Exact, slot-locked retirement for the existing PUI acceptance cache. */
import { execFileSync } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanProcHolders, type HolderScan } from '../release-cut-reclaim';

export interface RetireAcceptanceDependenciesOptions {
  checkout: string;
  expectedSha: string;
  trees: string[];
  execute?: boolean;
  scan?: typeof scanProcHolders;
}

export async function retireAcceptanceDependencies(options: RetireAcceptanceDependenciesOptions) {
  if (!/^[0-9a-f]{40}$/.test(options.expectedSha)) throw new Error('exact source commit required');
  if (options.trees.length === 0 || options.trees.length > 50) throw new Error('name 1–50 dependency trees');
  const checkout = resolve(options.checkout);
  if ((await realpath(checkout)) !== checkout) throw new Error('checkout must be a physical slot directory');
  const actualSha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualSha !== options.expectedSha) throw new Error('slot source commit changed');
  const targets = [...new Set(options.trees)].map((tree) => {
    if (!/^(?:node_modules|(?:apps|packages|libs)\/[A-Za-z0-9._-]+\/node_modules)$/.test(tree)) {
      throw new Error(`not a dependency tree: ${tree}`);
    }
    return join(checkout, tree);
  });
  const identities = new Map<string, { dev: number; ino: number }>();
  for (const target of targets) {
    let value;
    try { value = await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(target)) !== target) {
      throw new Error(`dependency tree is not a physical directory: ${target}`);
    }
    identities.set(target, { dev: value.dev, ino: value.ino });
  }
  const scan = options.scan ?? scanProcHolders;
  const assertIdle = (result: HolderScan) => {
    if (!result.verified) throw new Error(`process-use scan unverified: ${result.reason ?? 'unknown'}`);
    if ((result.holders.get(checkout) ?? []).length > 0) throw new Error('acceptance slot is in use');
  };
  assertIdle(await scan([{ key: checkout, prefixes: [checkout] }]));
  const removed: string[] = [];
  if (options.execute) {
    for (const [target, identity] of identities) {
      assertIdle(await scan([{ key: checkout, prefixes: [checkout] }]));
      const current = await lstat(target);
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error(`dependency tree changed during retirement: ${target}`);
      }
      await rm(target, { recursive: true, force: false });
      removed.push(target);
    }
  }
  return { checkout, sourceSha: actualSha, dryRun: !options.execute, candidates: [...identities.keys()], removed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [checkout, expectedSha, ...args] = process.argv.slice(2);
  const execute = args.includes('--execute');
  const trees = args.filter((value) => value !== '--execute');
  try {
    console.log(JSON.stringify(await retireAcceptanceDependencies({ checkout: checkout ?? '', expectedSha: expectedSha ?? '', trees, execute })));
  } catch (error) {
    console.error(`release-acceptance: retirement refused: ${String(error)}`);
    process.exitCode = 2;
  }
}
