/**
 * linux-tutorial-desktop.test.ts — the LINUX tutorial-icon writer
 * (owner 2026-07-06, "how come I still don't see the icon on my taskbar in this dev
 * box"). writeLinuxTutorialDesktopEntry is the first-boot `.desktop` provisioner that
 * `installPapercuspFiles` was missing on Linux (it only ever wrote the macOS .app +
 * relied on the .deb postinstall, which never runs on a dev box / non-.deb install).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeLinuxTutorialDesktopEntry } from './papercusp-files';

let tmp: string;
let home: string;
let desktopPath: string;
const cli = '/home/u/.papercusp/bin/papercusp';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'linux-tut-'));
  home = path.join(tmp, 'home');
  desktopPath = path.join(home, '.local', 'share', 'applications', 'papercusp-tutorial.desktop');
});
afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

describe('writeLinuxTutorialDesktopEntry', () => {
  it('writes a valid per-user .desktop launcher pointed at the dispatcher', async () => {
    const ok = await writeLinuxTutorialDesktopEntry(desktopPath, cli, home, path.join(tmp, 'noroot'));
    expect(ok).toBe(true);
    const body = await fs.readFile(desktopPath, 'utf8');
    expect(body).toContain('[Desktop Entry]');
    expect(body).toContain('Type=Application');
    expect(body).toContain('Name=Papercusp Tutorial & Setup');
    expect(body).toContain(`Exec=${cli} tutorial`); // opens the guided tutorial
    expect(body).toContain('Terminal=true'); // DE opens a real terminal
    expect(body).toContain('Categories=Development;');
  });

  it('falls back to the themed icon name when no source PNG resolves', async () => {
    await writeLinuxTutorialDesktopEntry(desktopPath, cli, home, path.join(tmp, 'noroot'));
    const body = await fs.readFile(desktopPath, 'utf8');
    expect(body).toContain('Icon=papercusp-desktop'); // themed name (.deb / Tauri bundle install it)
  });

  it('installs a real icon into the hicolor theme + references it by absolute path when a source exists', async () => {
    // Seed an icon at one of the candidate locations relative to operatorAppRoot.
    const root = path.join(tmp, 'root');
    const iconSrc = path.join(root, 'icons', '128x128.png');
    await fs.mkdir(path.dirname(iconSrc), { recursive: true });
    await fs.writeFile(iconSrc, Buffer.from('PNGDATA'));

    await writeLinuxTutorialDesktopEntry(desktopPath, cli, home, root);
    const installed = path.join(home, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', 'papercusp-desktop.png');
    expect(await fs.readFile(installed, 'utf8')).toBe('PNGDATA'); // copied into the user theme
    const body = await fs.readFile(desktopPath, 'utf8');
    expect(body).toContain(`Icon=${installed}`); // absolute path — no icon-cache dependency
  });

  it('double-quotes an Exec path that contains spaces', async () => {
    const spaced = '/home/a b/.papercusp/bin/papercusp';
    await writeLinuxTutorialDesktopEntry(desktopPath, spaced, home, path.join(tmp, 'noroot'));
    const body = await fs.readFile(desktopPath, 'utf8');
    expect(body).toContain(`Exec="${spaced}" tutorial`);
  });
});
