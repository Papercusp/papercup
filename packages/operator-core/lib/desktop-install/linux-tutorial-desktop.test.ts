/**
 * linux-tutorial-desktop.test.ts — the LINUX tutorial-icon writer + dock pin
 * (owner 2026-07-06, "how come I still don't see the icon on my taskbar in this dev
 * box", escalated to a 5th report). writeLinuxTutorialDesktopEntry is the first-boot
 * `.desktop` provisioner that `installPapercuspFiles` was missing on Linux (it only ever
 * wrote the macOS .app + relied on the .deb postinstall, which never runs on a dev box /
 * non-.deb install). appendGnomeFavorite + pinLinuxTutorialToDock then PIN that launcher
 * to the GNOME dock — writing the `.desktop` alone only lands it in the app grid, but the
 * owner wants it ON the taskbar. The pin tests drive a PATH-injected fake `gsettings` so
 * they never read or mutate the real GNOME favorites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendGnomeFavorite, pinLinuxTutorialToDock, writeLinuxTutorialDesktopEntry } from './papercusp-files';

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

const ID = 'papercusp-tutorial.desktop';

describe('appendGnomeFavorite', () => {
  it('appends the id to a populated favorites array', () => {
    expect(appendGnomeFavorite("['firefox.desktop', 'org.gnome.Nautilus.desktop']", ID)).toBe(
      "['firefox.desktop', 'org.gnome.Nautilus.desktop', 'papercusp-tutorial.desktop']",
    );
  });

  it('creates the array from an empty [] and from the typed-empty @as []', () => {
    expect(appendGnomeFavorite('[]', ID)).toBe("['papercusp-tutorial.desktop']");
    expect(appendGnomeFavorite('@as []', ID)).toBe("['papercusp-tutorial.desktop']");
  });

  it('is a no-op when the id is already pinned (never double-pins)', () => {
    const cur = "['firefox.desktop', 'papercusp-tutorial.desktop']";
    expect(appendGnomeFavorite(cur, ID)).toBe(cur);
  });

  it('tolerates empty / whitespace-only input', () => {
    expect(appendGnomeFavorite('', ID)).toBe("['papercusp-tutorial.desktop']");
    expect(appendGnomeFavorite('   ', ID)).toBe("['papercusp-tutorial.desktop']");
  });
});

describe('pinLinuxTutorialToDock (fake gsettings on PATH)', () => {
  let stubDir: string;
  let setLog: string;
  let marker: string;
  let origPath: string | undefined;

  beforeEach(async () => {
    // A fake `gsettings` on PATH: `get` echoes $FAKE_FAV, `set` records argv[4] to $FAKE_SET_LOG.
    stubDir = path.join(tmp, 'stubbin');
    setLog = path.join(tmp, 'gsettings-set.log');
    marker = path.join(home, '.papercusp', 'state', 'linux-tutorial-dock-pinned');
    await fs.mkdir(stubDir, { recursive: true });
    const stub =
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  get) echo "${FAKE_FAV:-@as []}" ;;',
        '  set) printf "%s" "$4" > "$FAKE_SET_LOG" ;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n';
    await fs.writeFile(path.join(stubDir, 'gsettings'), stub, { mode: 0o755 });
    origPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${origPath ?? ''}`;
    process.env.FAKE_SET_LOG = setLog;
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    delete process.env.FAKE_FAV;
    delete process.env.FAKE_SET_LOG;
  });

  it('pins the launcher to favorite-apps and writes the once-marker', async () => {
    process.env.FAKE_FAV = "['firefox.desktop']";
    const pinned = await pinLinuxTutorialToDock(ID, marker);
    expect(pinned).toBe(true);
    expect(await fs.readFile(setLog, 'utf8')).toBe("['firefox.desktop', 'papercusp-tutorial.desktop']");
    await fs.access(marker); // one-time marker dropped
  });

  it('does not re-pin when the marker already exists (respects a later user un-pin)', async () => {
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, 'x');
    process.env.FAKE_FAV = "['firefox.desktop']";
    const pinned = await pinLinuxTutorialToDock(ID, marker);
    expect(pinned).toBe(false);
    await expect(fs.access(setLog)).rejects.toThrow(); // gsettings set NEVER invoked
  });

  it('does not duplicate when already pinned, but still drops the marker', async () => {
    process.env.FAKE_FAV = "['firefox.desktop', 'papercusp-tutorial.desktop']";
    const pinned = await pinLinuxTutorialToDock(ID, marker);
    expect(pinned).toBe(false); // favorites already contained it — nothing set
    await expect(fs.access(setLog)).rejects.toThrow();
    await fs.access(marker); // but the one-time attempt is still recorded
  });
});
