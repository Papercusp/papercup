import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type InjectionHookRefresh = { status: 'current' | 'refreshed' | 'deferred' | 'unavailable'; files: string[] };
type Installer = (home: string, source: string) => Promise<string[]>;
const inFlight = new Map<string, Promise<InjectionHookRefresh>>();

/** Hook bytes outlive bootstrap's process cache. Reuse the installer, including
 * its shared lock and downgrade guard; never cache a refused install as fresh. */
export function refreshInjectionHooks(home: string, source: string,
  install: Installer = async (targetHome, sourceDir) => {
    const { installInjectionHooks } = await import('./papercusp-files');
    return installInjectionHooks(targetHome, sourceDir);
  }): Promise<InjectionHookRefresh> {
  const key = JSON.stringify([home, source]);
  const current = inFlight.get(key);
  if (current) return current;
  const pending = refresh(home, source, install).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

async function refresh(home: string, source: string, install: Installer): Promise<InjectionHookRefresh> {
  try {
    const files: string[] = [];
    for (const relative of ['', 'adapters']) {
      const names = await readdir(join(source, relative), { withFileTypes: true });
      files.push(...names.filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
        .map(entry => join(relative, entry.name)));
    }
    if (!files.includes('index.mjs')) return { status: 'unavailable', files: [] };
    const destination = join(home, '.papercusp', 'hooks', 'inject');
    const expected = await Promise.all(files.map(async file => ({ file, bytes: await readFile(join(source, file)) })));
    const matches = async () => (await Promise.all(expected.map(async ({ file, bytes }) => {
      const installed = await readFile(join(destination, file)).catch(() => null);
      return installed !== null && bytes.equals(installed);
    }))).every(Boolean);
    if (await matches()) return { status: 'current', files };
    const installed = await install(home, source);
    return { status: installed.length > 0 && await matches() ? 'refreshed' : 'deferred', files };
  } catch {
    return { status: 'unavailable', files: [] };
  }
}
