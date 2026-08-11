/**
 * WI-7249 — recurrence guard for the spawner-sidecar orphan leak
 * (plan `process-lifecycle-no-orphans-2026-08-02`, D-011).
 *
 * THE BUG THIS EXISTS TO PREVENT. Shutdown-hook registration used to be coupled to a
 * CALL SITE rather than to the spawn itself: `registerSpawnerSidecarShutdownHooks()`
 * had exactly one non-test caller (host-bootstrap, bg-host only), while the entry
 * points ordinary AGENT processes take — `git-via-sidecar` (git-sync, pot-git storage,
 * the harness docs runner, dev-deploy-state) and `dbos/orchestrator-runner` — spawned a
 * child and registered nothing to stop it. The call-site distribution is what proved
 * the mechanism: 1 of 50 orphans came from `papercup-bg-host.service` (the one path
 * that DOES register) and 49 of 50 from agent-session cgroups (the paths that do not).
 *
 * The leak is PERMANENT rather than a redundant duplicate, which is what made it
 * expensive: the IPC socket is pid-keyed (`spawner-socket-path.ts`), so once the owning
 * host dies its sidecar can never be addressed again — a corpse holding RAM, observed
 * at ages up to 403h (16.8 days), ~203 processes across ~50 instances.
 *
 * WHY A REGISTRY-DRIVEN GUARD AND NOT THREE HAND-WRITTEN CASES. The defect is not
 * "someone forgot in this one file" — it is a SHAPE that every sidecar here shares, and
 * the siblings survive only because each currently happens to have a single entry point
 * that remembers. A guard listing three names by hand would pass forever while a fourth
 * sidecar shipped with the same hole. So the class assertion below derives its expected
 * set from `SUPERVISED_PROCESSES` itself: add a new `node-child` sidecar and this test
 * fails until the sidecar is covered here. That is the D-011 requirement — "assert every
 * node-child sidecar registers shutdown hooks on spawn, so the next clone cannot omit it
 * silently" — expressed as something a future clone cannot walk past.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _resetSidecarShutdownHookRegistryForTests,
  _registeredSidecarShutdownLabelsForTests,
} from './sidecar-spawn-shared';
import { SUPERVISED_PROCESSES } from '../service-health';
import {
  spawnSpawnerSidecar,
  _setSpawnerSidecarProcessForTests,
} from '../fleet/spawner-sidecar-spawn';
import {
  spawnSubstrateSidecar,
  _setSubstrateSidecarProcessForTests,
} from '../sync/hyperbee/substrate-sidecar-spawn';
import {
  spawnEmbedSidecar,
  _setEmbedSidecarProcessForTests,
} from '../memory/embed-sidecar-spawn';

/** The events the shared registrar attaches to — snapshotted so this test leaves no
 *  listeners behind on the shared `process` object for sibling suites to trip over. */
const HOOK_EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'exit'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
type AnyListener = (...args: unknown[]) => void;

/** `process.listeners`/`removeListener` are typed as per-signal overloads, so passing the
 *  HookEvent UNION matches none of them. This is the emitter view we actually use. */
const proc = process as unknown as {
  listeners(event: HookEvent): AnyListener[];
  removeListener(event: HookEvent, listener: AnyListener): unknown;
};

/**
 * One row per `node-child` sidecar. `registryName` MUST match the entry's `name` in
 * SUPERVISED_PROCESSES — the class assertion joins on it.
 *
 * `setProcess` installs a fake already-running child so the spawn function takes its
 * early-return path: the registration under test happens BEFORE that return (that is
 * the point — a second entry point finding a live child must still ensure the hooks
 * exist), so the assertion holds without ever spawning a real `npm exec tsx` child.
 */
const NODE_CHILD_SIDECARS: ReadonlyArray<{
  registryName: string;
  label: string;
  setProcess: (proc: ChildProcess | null) => void;
  spawn: () => Promise<void>;
}> = [
  {
    registryName: 'spawner-sidecar',
    label: 'spawner-sidecar-spawn',
    setProcess: _setSpawnerSidecarProcessForTests,
    spawn: () => spawnSpawnerSidecar(),
  },
  {
    registryName: 'substrate-sidecar',
    label: 'substrate-sidecar-spawn',
    setProcess: _setSubstrateSidecarProcessForTests,
    spawn: () => spawnSubstrateSidecar(),
  },
  {
    registryName: 'embed-sidecar',
    label: 'embed-sidecar-spawn',
    setProcess: _setEmbedSidecarProcessForTests,
    spawn: () => spawnEmbedSidecar(),
  },
];

describe('sidecar shutdown hooks register on SPAWN, not at a call site (WI-7249 / D-011)', () => {
  let baseline: Map<HookEvent, Set<AnyListener>>;

  beforeEach(() => {
    baseline = new Map(
      HOOK_EVENTS.map((evt) => [evt, new Set<AnyListener>(proc.listeners(evt))]),
    );
    _resetSidecarShutdownHookRegistryForTests();
  });

  afterEach(() => {
    // Drop only the listeners THIS test added — the registry reset above clears the
    // idempotency set but not the real listeners, so without this the suite would leak
    // a handler per case and eventually trip Node's max-listeners warning.
    for (const evt of HOOK_EVENTS) {
      const before = baseline.get(evt) ?? new Set<AnyListener>();
      for (const listener of proc.listeners(evt)) {
        if (!before.has(listener)) proc.removeListener(evt, listener);
      }
    }
    for (const sidecar of NODE_CHILD_SIDECARS) sidecar.setProcess(null);
    _resetSidecarShutdownHookRegistryForTests();
  });

  for (const sidecar of NODE_CHILD_SIDECARS) {
    it(`${sidecar.registryName} registers its shutdown hooks as a side effect of spawning`, async () => {
      sidecar.setProcess({} as ChildProcess);

      // Precondition: nothing registered yet, so a pass cannot come from a sibling
      // suite having already registered this label in the same process.
      expect(_registeredSidecarShutdownLabelsForTests()).not.toContain(sidecar.label);

      await sidecar.spawn();

      expect(_registeredSidecarShutdownLabelsForTests()).toContain(sidecar.label);
    });
  }

  it('registration is idempotent — a second spawn does not stack a duplicate hook', async () => {
    const sidecar = NODE_CHILD_SIDECARS[0]!;
    sidecar.setProcess({} as ChildProcess);

    await sidecar.spawn();
    const afterFirst = process.listeners('SIGTERM').length;
    await sidecar.spawn();

    expect(process.listeners('SIGTERM').length).toBe(afterFirst);
    expect(
      _registeredSidecarShutdownLabelsForTests().filter((l) => l === sidecar.label),
    ).toHaveLength(1);
  });

  it('CLASS GUARD (registry): every node-child sidecar in SUPERVISED_PROCESSES is covered above', () => {
    // Derived, never hand-listed: a new node-child sidecar fails here until someone
    // adds it to NODE_CHILD_SIDECARS — which forces them to assert it registers on
    // spawn, which is the property that was missing when the leak shipped.
    const registryNodeChildren = SUPERVISED_PROCESSES.filter((e) => e.layer === 'node-child')
      .map((e) => e.name)
      .sort();
    const covered = NODE_CHILD_SIDECARS.map((s) => s.registryName).sort();

    expect(registryNodeChildren).toEqual(covered);
  });

  /**
   * CLASS GUARD (source) — and the reason it exists rather than the registry check alone.
   *
   * The registry check above derives its universe from `SUPERVISED_PROCESSES` entries whose
   * `layer` is `node-child`. That classification is about how a process is DEPLOYED, not
   * about whether some function in this repo spawns it as a child — and the two diverge.
   * The inference-gateway sidecar is spawned as a node child by
   * `inference-gateway/gateway-sidecar-spawn.ts`, yet it is registered as
   * `{ name: 'inference-gateway', layer: 'systemd-user' }` because it can ALSO run as a
   * systemd unit. So it has the exact shape this file exists to police and the registry
   * check cannot see it — the same "a guard that passes forever while a fourth sidecar
   * ships with the hole" failure the header warns about, arriving through a different door.
   *
   * It also cannot be covered behaviourally the way the three above are: its registration
   * sits on the child-spawn seam (`spawnGatewayChild`, deliberately — so the respawn and
   * reprobe paths are covered and the adopt-external path, which spawns nothing, correctly
   * registers nothing), and that function is module-private and really does spawn.
   *
   * So this asserts the property STATICALLY, against the source, for every sidecar-spawn
   * module: the module must call its own registrar from inside a `spawn*`/`ensure*`
   * function. That is precisely the falsifier for the original defect — where the ONLY
   * call to `registerSpawnerSidecarShutdownHooks()` lived in a different file
   * (host-bootstrap.ts) that just two of the three entry points happened to route through.
   */
  it('CLASS GUARD (source): every *-sidecar-spawn module calls its own registrar from inside its spawn seam', async () => {
    const libRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

    const modules: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/-sidecar-spawn\.ts$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          modules.push(path.relative(libRoot, full));
        }
      }
    };
    await walk(libRoot);
    modules.sort();

    // Inventory tripwire. A NEW sidecar-spawn module fails here, which is the point: the
    // author is forced to look at this file. A RENAME that drops a module out of the glob
    // fails here too, so the property check below can never pass vacuously on an empty set.
    expect(modules).toEqual([
      'fleet/spawner-sidecar-spawn.ts',
      'inference-gateway/gateway-sidecar-spawn.ts',
      'memory/embed-sidecar-spawn.ts',
      'sync/hyperbee/substrate-sidecar-spawn.ts',
    ]);

    const offenders: string[] = [];
    for (const rel of modules) {
      const src = await fs.readFile(path.join(libRoot, rel), 'utf8');
      const lines = src.split('\n');

      // The registrar this module DEFINES (each sidecar exports its own thin wrapper over
      // the shared registrar), so a module cannot pass by calling somebody else's.
      const defined = [...src.matchAll(/^export function (register\w*ShutdownHooks)\(/gm)].map(
        (m) => m[1]!,
      );
      if (defined.length === 0) {
        offenders.push(`${rel}: defines no register*ShutdownHooks wrapper`);
        continue;
      }

      const satisfied = defined.some((name) =>
        lines.some((line, i) => {
          // A CALL to the registrar, not its definition.
          if (!new RegExp(`(?<!function )\\b${name}\\(\\s*\\)`).test(line)) return false;
          // Walk back to the nearest top-level function declaration and require the call to
          // be inside a spawn/ensure seam — registering from a `stop`/`reprobe`/module scope
          // would satisfy a naive "the file mentions it somewhere" check but not the property.
          for (let j = i; j >= 0; j--) {
            const decl = /^(?:export )?(?:async )?function (\w+)/.exec(lines[j]!);
            if (decl) return /^(spawn|ensure)/.test(decl[1]!);
          }
          return false;
        }),
      );

      if (!satisfied) {
        offenders.push(
          `${rel}: ${defined.join('/')} is never called from inside a spawn*/ensure* function ` +
            `— registration is coupled to a call site again (WI-7249 / D-011)`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
