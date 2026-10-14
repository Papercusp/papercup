#!/usr/bin/env node
/**
 * Native-Node bridge for lint:tests' resolved Vitest include/exclude audit.
 *
 * The caller batches every distinct route config into one stdin payload. Keep
 * stdout tolerant of config-module chatter: the final marker is the only
 * machine-readable line the caller consumes.
 */

import { resolveConfig } from 'vitest/node';
import { glob } from 'tinyglobby';
import { resolve, relative, isAbsolute } from 'node:path';

const MARKER = 'PC_VITEST_CONFIG_CONTRACTS=';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const input = JSON.parse(await readStdin());
const requests = Array.isArray(input.requests) ? input.requests : [];
const results = [];

for (const request of requests) {
  const cwd = process.cwd();
  const keys = ['PC_TEST_LANE', 'PC_TEST_FILTER_LIST', 'PC_TEST_REUSE_SKIP_LIST'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    if (request.enumerateFiles) {
      // Configs derive lane membership from cwd, exactly as npm's workspace child does.
      process.chdir(request.root);
      for (const key of keys) delete process.env[key];
      for (const key of keys.slice(0, 2)) {
        if (request.env?.[key] !== undefined) process.env[key] = request.env[key];
      }
    }
    const { vitestConfig } = await resolveConfig({
      root: request.root,
      config: request.config,
    });
    let files;
    if (request.enumerateFiles) {
      // These shapes require additional runner semantics; unknown is never an empty set.
      if (vitestConfig.includeSource?.length || vitestConfig.typecheck?.enabled ||
          vitestConfig.projects?.length) throw new Error('unsupported source/typecheck/project population');
      const base = vitestConfig.dir || vitestConfig.root;
      // Same glob engine and options as Vitest's TestProject.globFiles, without collection.
      files = (await glob(vitestConfig.include, {
        dot: true, cwd: base, ignore: vitestConfig.exclude, expandDirectories: false,
      })).map(file => relative(request.root, resolve(base, file)).replaceAll('\\', '/')).sort();
      if (files.some(file => isAbsolute(file) || file === '..' || file.startsWith('../')))
        throw new Error('resolved test population escapes workspace');
    }
    results.push({
      ok: true,
      ...(files ? { files, enumerated: true } : {}),
      config: {
        root: vitestConfig.root,
        ...(vitestConfig.dir ? { dir: vitestConfig.dir } : {}),
        include: vitestConfig.include,
        exclude: vitestConfig.exclude,
      },
    });
  } catch (error) {
    results.push({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (request.enumerateFiles) {
      process.chdir(cwd);
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }
}

process.stdout.write(`${MARKER}${JSON.stringify({ results })}\n`);
