/**
 * The WI-6450 guard, generalized: every action module in this directory must be
 * REACHABLE THROUGH THE BARREL.
 *
 * Registration here happens by SIDE EFFECT — `lib/chat-actions/index.ts` carries
 * one `import './XyzAction'` line per axis, and the bar renders whatever those
 * imports registered. A module nobody imports is tree-shaken out and its control
 * simply never appears. That failure is silent and looks like a broken bar
 * rather than a missing import, which is why it has now happened more than once
 * (WI-6450 shipped the WHOLE action bar dead; EI-20187447948512809 re-checked
 * the same line months later).
 *
 * Every per-axis suite is blind to it, and blind in a way that FEELS covered:
 * each one begins with `import './XyzAction'`, so the axis is registered by the
 * test file itself and every assertion passes whether or not the barrel mentions
 * it. Adding a barrel case to each suite would work but relies on each future
 * author remembering — the same kind of vigilance that failed the first two
 * times. This asserts it once, from the DIRECTORY, so a new axis is covered by
 * existing on disk rather than by anyone remembering this file exists.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DIR = __dirname;

/** Action modules on disk: `SomethingAction.ts` / `SomethingActions.ts`, minus
 *  tests and the substrate itself. */
function actionModulesOnDisk(): string[] {
  return readdirSync(DIR)
    .filter((f) => /Actions?\.ts$/.test(f) && !f.includes('.test.'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

describe('chat-actions barrel', () => {
  it('imports EVERY action module in this directory', () => {
    const barrel = readFileSync(join(DIR, 'index.ts'), 'utf8');
    const missing = actionModulesOnDisk().filter(
      (m) => !new RegExp(`import\\s+'\\./${m}'`).test(barrel),
    );
    expect(
      missing,
      `these action modules exist but index.ts does not import them, so they are tree-shaken out and their controls never render: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('registers at least one action per module, loading ONLY the barrel', async () => {
    /*
     * The complement of the check above: the import line can be present while the
     * module registers nothing (a renamed export, a registration moved behind a
     * condition). Load the barrel in a FRESH module graph so nothing this process
     * already imported can mask a missing registration.
     */
    vi.resetModules();
    const registry = await import('./registry');
    await import('./index');
    const ids = [...registry.listAllChatModeActionIds(), ...registry.listAllChatActionIds()];
    expect(actionModulesOnDisk().length).toBeGreaterThan(0);
    expect(ids.length).toBeGreaterThanOrEqual(actionModulesOnDisk().length);
  });
});
