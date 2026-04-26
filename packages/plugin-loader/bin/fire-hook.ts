#!/usr/bin/env tsx
/**
 * papercusp-fire-hook — invoke a plugin lifecycle hook from a shell.
 *
 * Used by run.sh after DONE / DONE-like transitions to give plugins a
 * chance to act on the state. Each plugin is loaded in its own child
 * process so a misbehaving plugin can't crash the harness loop.
 *
 * Usage:
 *   papercusp-fire-hook <hook-name> <plugin-dir> \
 *     --project-slug=<slug> --project-dir=<path> --state-dir=<path>
 *
 * Hook names: afterDone | beforeMissionStart | onProposalAccepted | onFeaturePassed
 *
 * Exit codes:
 *   0  = hook fired successfully (or hook not implemented — no-op)
 *   2  = invalid usage / missing args
 *   3  = plugin failed validation (manifest mismatch, etc.)
 *   4  = hook threw
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadPluginFromDir } from '../src/index.ts';

interface CliArgs {
  hook: string;
  pluginDir: string;
  projectSlug: string;
  projectDir: string;
  stateDir: string;
  proposalPath?: string;
  featureId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      flags[k] = rest.join('=');
    }
  }
  if (positional.length < 2) {
    console.error('usage: papercusp-fire-hook <hook> <plugin-dir> --project-slug=X --project-dir=Y --state-dir=Z');
    process.exit(2);
  }
  const required = ['project-slug', 'project-dir', 'state-dir'];
  for (const r of required) {
    if (!flags[r]) {
      console.error(`papercusp-fire-hook: missing --${r}`);
      process.exit(2);
    }
  }
  return {
    hook: positional[0],
    pluginDir: positional[1],
    projectSlug: flags['project-slug'],
    projectDir: flags['project-dir'],
    stateDir: flags['state-dir'],
    proposalPath: flags['proposal-path'],
    featureId: flags['feature-id'],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await loadPluginFromDir(args.pluginDir, 'project');
  if ('error' in result) {
    console.error(`papercusp-fire-hook: failed to load ${args.pluginDir}: ${result.error}`);
    process.exit(3);
  }
  const plugin = result.plugin;

  // Build the context.
  const pluginDataDir = join(args.stateDir, 'plugins', plugin.name);
  await mkdir(pluginDataDir, { recursive: true });
  const ctx = {
    projectSlug: args.projectSlug,
    projectDir: args.projectDir,
    stateDir: args.stateDir,
    pluginDataDir,
    log: (msg: string) => console.log(`[plugin:${plugin.name}] ${msg}`),
  };

  const hooks = (plugin as any).hooks ?? {};
  const fn = hooks[args.hook];
  if (typeof fn !== 'function') {
    // No-op: this plugin doesn't implement this hook.
    process.exit(0);
  }

  try {
    if (args.hook === 'onProposalAccepted') {
      await fn(ctx, args.proposalPath ?? '');
    } else if (args.hook === 'onFeaturePassed') {
      await fn(ctx, args.featureId ?? '');
    } else {
      await fn(ctx);
    }
    process.exit(0);
  } catch (e: any) {
    console.error(`papercusp-fire-hook: ${plugin.name}.${args.hook} threw: ${e?.message ?? e}`);
    if (process.env.DEBUG) console.error(e?.stack);
    process.exit(4);
  }
}

main().catch((e) => {
  console.error(`papercusp-fire-hook: fatal: ${e?.message ?? e}`);
  process.exit(1);
});
