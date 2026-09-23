/**
 * WI-10002541: patches/@dbos-inc+dbos-sdk+4.27.6.patch makes DBOS's
 * `debugTriggerPoint` capture its call site (a `new Error()` stack, split and
 * regexed) only the FIRST time a point name is hit. Upstream captured it on
 * every call, and DBOS calls it per workflow step, per queue-poll iteration and
 * per `findAndMarkStartableWorkflows`: on the rig VM that showed up as
 * getCallSiteInfo/debugTriggerPoint in main-thread CPU profiles.
 *
 * `getCallSiteInfo` is called by a local reference, so it cannot be spied on.
 * Reading `err.stack` runs `Error.prepareStackTrace`, so counting those calls
 * counts the stack captures. That is observable from outside the package.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The package `exports` map blocks deep imports; resolve the installed module
// by path from the package's own main entry (dist/src/index.js). This is the
// SAME file the operator loads, so the test exercises the applied patch.
const require_ = createRequire(import.meta.url);
const debugpointPath = path.join(path.dirname(require_.resolve('@dbos-inc/dbos-sdk')), 'debugpoint.js');
const { debugTriggerPoint, pointLocations } = require_(debugpointPath) as {
  debugTriggerPoint(name: string): Promise<void>;
  pointLocations: Map<string, { name: string; fileName: string; lineNumber: number; hitCount: number }>;
};

const original = Error.prepareStackTrace;
afterEach(() => {
  Error.prepareStackTrace = original;
});

function countStackFormats(): { count: () => number } {
  let n = 0;
  Error.prepareStackTrace = (err, frames) => {
    n += 1;
    return original ? original(err, frames) : `${err}\n${frames.map((f) => `    at ${f}`).join('\n')}`;
  };
  return { count: () => n };
}

describe('DBOS debugTriggerPoint call-site capture (WI-10002541 patch)', () => {
  it('captures the call site once per point name, not once per hit', async () => {
    const name = `wi10002541-point-${Date.now()}`;
    const probe = countStackFormats();
    for (let i = 0; i < 100; i++) await debugTriggerPoint(name);
    expect(probe.count()).toBe(1);
    // The recorded location is still populated exactly as before.
    expect(pointLocations.get(name)).toMatchObject({ name, hitCount: 0 });
    expect(typeof pointLocations.get(name)?.lineNumber).toBe('number');
  });

  it('a second distinct point is captured once too (the counter measures real captures)', async () => {
    const a = `wi10002541-a-${Date.now()}`;
    const b = `wi10002541-b-${Date.now()}`;
    const probe = countStackFormats();
    for (let i = 0; i < 20; i++) {
      await debugTriggerPoint(a);
      await debugTriggerPoint(b);
    }
    expect(probe.count()).toBe(2);
  });
});
