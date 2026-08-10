/**
 * User-layer template shadowing (WI-37781 / template-supply-chain-repair P-009).
 *
 * THE BUG THIS PINS. The layered store lets the writable user layer shadow the
 * bundled first-party set on a ref collision — deliberate, since the user layer
 * is where `templates:install` (v2) writes. But the shadow was UNCONDITIONAL and
 * SILENT, and `readTemplateDir` treats a dir with only `template.yaml` as a
 * valid template (falling back to `title = id = ref`, `source = 'installed'`).
 * So a half-written user dir — an interrupted clone, a partial marketplace
 * write, a hand-copied snapshot — permanently replaced an official template with
 * an untitled, undescribed, non-official one, with no signal in any result.
 * Live on this box that was TWO of the three app-scope roots: papercusp-webapp
 * and papercusp-data-sync listed as nameless `local` entries for weeks.
 *
 * The fix must hold BOTH ways: refuse the degrade, but do not break the
 * supported v2 install shape (a `template.yaml`-only dir with no collision).
 */
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listLocalTemplates,
  listLocalTemplatesWithShadows,
  type TemplateRoot,
} from './template-store';

let tmp: string;
let bundledDir: string;
let userDir: string;

const roots = (): TemplateRoot[] => [
  { dir: bundledDir, layer: 'bundled' },
  { dir: userDir, layer: 'user' },
];

/** An OFFICIAL bundled template: listing.json (rich) + template.yaml. */
async function writeBundled(ref: string, title: string) {
  const dir = join(bundledDir, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'listing.json'),
    JSON.stringify({ id: ref, title, description: `${title} description`, source: 'first-party' }),
  );
  await fs.writeFile(join(dir, 'template.yaml'), `id: ${ref}\n`);
}

/** A user-layer dir. `withListing:false` is the half-written shape. */
async function writeUser(ref: string, withListing: boolean, title = 'User Copy') {
  const dir = join(userDir, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'template.yaml'), `id: ${ref}\n`);
  await fs.writeFile(join(dir, 'GUIDE.md'), 'guide\n');
  if (withListing) {
    await fs.writeFile(
      join(dir, 'listing.json'),
      JSON.stringify({ id: ref, title, description: 'installed', source: 'installed' }),
    );
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'template-shadow-'));
  bundledDir = join(tmp, 'bundled');
  userDir = join(tmp, 'user');
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.mkdir(userDir, { recursive: true });
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('a listing.json-less user dir must not degrade an official template', () => {
  it('reproduces the live symptom and REFUSES it — the official entry survives intact', async () => {
    await writeBundled('papercusp-webapp', 'Papercusp Official: Web App');
    await writeUser('papercusp-webapp', false); // the residue shape: no listing.json

    const { templates, shadows } = listLocalTemplatesWithShadows(roots());
    const webapp = templates.find((t) => t.ref === 'papercusp-webapp');

    // Before the fix these three assertions read: '', '', 'installed'.
    expect(webapp?.title).toBe('Papercusp Official: Web App');
    expect(webapp?.description).toBe('Papercusp Official: Web App description');
    expect(webapp?.source).toBe('first-party');
    expect(webapp?.layer).toBe('bundled');

    // …and the collision is REPORTED rather than silent.
    const event = shadows.find((s) => s.ref === 'papercusp-webapp');
    expect(event).toBeDefined();
    expect(event?.refused).toBe(true);
    expect(event?.winnerLayer).toBe('bundled');
    expect(event?.reason).toMatch(/listing\.json/);
  });

  it('still lets a COMPLETE user install shadow the bundled ref (v2 install path intact)', async () => {
    await writeBundled('papercusp-ui', 'Papercusp Official: UI');
    await writeUser('papercusp-ui', true, 'My Forked UI');

    const { templates, shadows } = listLocalTemplatesWithShadows(roots());
    const ui = templates.find((t) => t.ref === 'papercusp-ui');

    expect(ui?.title).toBe('My Forked UI');
    expect(ui?.layer).toBe('user');

    const event = shadows.find((s) => s.ref === 'papercusp-ui');
    expect(event?.refused).toBe(false);
    expect(event?.winnerLayer).toBe('user');
  });

  it('still resolves a template.yaml-only user dir when nothing collides', async () => {
    // The supported v2 shape — the refusal must be about the COLLISION, not
    // about listing.json being absent, or this breaks ordinary installs.
    await writeUser('my-private-template', false);

    const templates = listLocalTemplates(roots());
    const mine = templates.find((t) => t.ref === 'my-private-template');
    expect(mine).toBeDefined();
    expect(mine?.layer).toBe('user');
    expect(mine?.hasListing).toBe(false);
  });

  it('reports no shadows when the layers do not collide', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'template-shadow-iso-'));
    const b = join(isolated, 'bundled');
    const u = join(isolated, 'user');
    await fs.mkdir(b, { recursive: true });
    await fs.mkdir(u, { recursive: true });
    const saved = [bundledDir, userDir];
    bundledDir = b;
    userDir = u;
    try {
      await writeBundled('only-bundled', 'Only Bundled');
      const { templates, shadows } = listLocalTemplatesWithShadows(roots());
      expect(templates.map((t) => t.ref)).toEqual(['only-bundled']);
      expect(shadows).toEqual([]);
    } finally {
      [bundledDir, userDir] = saved;
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
