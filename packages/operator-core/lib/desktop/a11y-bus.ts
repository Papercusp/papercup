/**
 * a11y-bus.ts — stand up a sandbox desktop's OWN accessibility bus
 * (agent-virtual-desktops-2026-08-23 P-007; D-010).
 *
 * Sibling of `gl-strategy.ts` and built the same way: constants + pure command
 * builders here, so the in-process provisioner and any future frame bootstrap derive
 * the recipe from ONE place instead of hand-maintaining two copies of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A MINIMAL BUS AND NOT `dbus-run-session`. This is the whole design, and it
 * was arrived at by measurement after four probes failed for reasons that all
 * LOOKED like "accessibility does not work headless".
 *
 * AT-SPI needs a session bus to activate `org.a11y.Bus`. The obvious way to get one
 * is `dbus-run-session`, which uses the system's real service directory — and that
 * directory contains `xdg-desktop-portal`. Measured on this box 2026-08-23, a GTK
 * app on such a session triggers a cascade: portal.Desktop → portal.Documents →
 * impl.portal.desktop.gnome → impl.portal.desktop.kde → gvfs → secrets/keyring,
 * with `fusermount3: failed to access mountpoint /run/user/1000/doc: Permission
 * denied` in the middle of it. The app does not paint for tens of seconds, and the
 * screenshots taken while that is happening are BLANK — which reads exactly like a
 * GL problem and sent this investigation down a renderer rabbit-hole (GSK_RENDERER,
 * GDK_GL, LIBGL_ALWAYS_SOFTWARE — none of which changed anything, because none of
 * them was the cause).
 *
 * A bus whose ONLY activatable service is `org.a11y.Bus` cannot start a portal.
 * Measured with it: the app painted within 4 seconds (200 distinct colours), and the
 * accessibility walk returned exactly ONE application — the app itself, with no
 * portal noise in the tree at all.
 *
 * ORDERING IS PART OF THE RECIPE, not an implementation detail. An app reads the
 * accessibility bus address ONCE, when its atk-bridge initialises. Start it before
 * the bus exists and it logs `Unable to acquire the address of the accessibility
 * bus` and never registers — it stays permanently invisible to accessibility even
 * though the bus comes up moments later. So the bus must be up BEFORE any app is
 * spawned, which is why this returns an address the caller then puts in the app env.
 *
 * DO NOT run `at-spi-bus-launcher` directly. It races the D-Bus service activation
 * and dies with `Failed to launch bus: Bus exited with code 0` (measured on :121).
 * Activating it THROUGH the bus — `org.a11y.Bus.GetAddress` — both starts it and
 * returns its address, which is why that one call is the whole bootstrap.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseA11yBusAddress, a11yBusCommand, A11Y_APP_ENV } from '../agent-tools/computer/accessibility-tree';
import { sandboxXEnv } from '../agent-tools/computer/desktop-driver';

export { A11Y_APP_ENV };

/** The system service file that makes `org.a11y.Bus` activatable. */
export const A11Y_SERVICE_FILE = '/usr/share/dbus-1/services/org.a11y.Bus.service';

/**
 * A session bus config whose service directory contains ONLY what we copy into it.
 * That is the entire mechanism by which the portal cascade is prevented: D-Bus can
 * only activate what a servicedir advertises.
 */
export function minimalSessionBusConfig(serviceDir: string): string {
  return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <servicedir>${serviceDir}</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;
}

/** `dbus-daemon` invocation that forks and prints the address it bound. */
export function sessionBusCommand(configPath: string): { bin: string; args: string[] } {
  return { bin: 'dbus-daemon', args: [`--config-file=${configPath}`, '--fork', '--print-address'] };
}

/**
 * Publish the bus on the display's root window, the way `at-spi-bus-launcher` would.
 *
 * This is what makes the binding DISCOVERABLE ACROSS PROCESSES with no registry
 * column and no in-process map: the display itself carries the answer to "which
 * accessibility bus is yours". An `observe` running in the operator can therefore
 * resolve a desktop provisioned by some other process, and an app launched later by
 * anyone at all finds the right bus on its own.
 */
export function publishBusPropertyCommand(display: string, busAddress: string): { bin: string; args: string[] } {
  return {
    bin: 'xprop',
    args: ['-display', display, '-root', '-f', 'AT_SPI_BUS', '8s', '-set', 'AT_SPI_BUS', busAddress],
  };
}

/**
 * Does this a11y bus actually belong to `display`?
 *
 * at-spi names its socket after the display it was started under — `bus_110` for
 * `:110` — so the address is self-describing and this is a cheap, exact check rather
 * than a heuristic. It exists because the failure it catches is SILENT and severe: a
 * launcher that inherited the wrong DISPLAY hands back a perfectly well-formed
 * address for someone else's session (measured: `bus_0`, the operator's own), and
 * every consumer downstream then works correctly against the wrong desktop.
 *
 * A bus whose name carries no display suffix at all is ACCEPTED: at-spi is entitled
 * to name its socket differently, and refusing an unrecognised shape would disable
 * accessibility on hosts where nothing is actually wrong. This rejects only the case
 * that is positively identifiable as another display's bus.
 */
export function busBelongsToDisplay(busAddress: string, display: string): boolean {
  const n = /^:(\d+)/.exec(display.trim())?.[1];
  if (!n) return false;
  const named = /at-spi\/bus_(\d+)/.exec(busAddress);
  if (!named) return true; // no display suffix to contradict us
  return named[1] === n;
}

export interface A11yBus {
  /** Address of the desktop's own minimal session bus. */
  sessionBus: string;
  /** Address of the accessibility bus that session activated. */
  a11yBus: string;
  /** Env additions an app must be launched with to register on it. */
  env: Record<string, string>;
}

export interface StartA11yBusOptions {
  /** Seconds to allow for `GetAddress` (which also starts at-spi). Default 20. */
  timeoutSec?: number;
}

/**
 * Bring up `display`'s accessibility bus and return everything needed to launch apps
 * onto it. Returns null — never throws — when the host cannot support accessibility,
 * because a desktop without an a11y bus is a perfectly usable screenshot-only
 * desktop, and failing provisioning over an optional capability would be a
 * regression for every caller that never wanted it.
 */
export function startA11yBus(display: string, opts: StartA11yBusOptions = {}): A11yBus | null {
  if (!existsSync(A11Y_SERVICE_FILE)) return null;
  const timeout = (opts.timeoutSec ?? 20) * 1000;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pc-a11y-'));
    const serviceDir = join(dir, 'services');
    spawnSync('mkdir', ['-p', serviceDir]);
    copyFileSync(A11Y_SERVICE_FILE, join(serviceDir, 'org.a11y.Bus.service'));
    const confPath = join(dir, 'session.conf');
    writeFileSync(confPath, minimalSessionBusConfig(serviceDir), 'utf8');

    const busCmd = sessionBusCommand(confPath);
    // 🚨 THE DAEMON'S ENV IS WHAT DECIDES WHICH DISPLAY at-spi BINDS TO, and getting
    // this wrong is silent. `at-spi-bus-launcher` is activated BY this daemon, so it
    // inherits THIS env, and it names its bus after the DISPLAY it sees. Spawned with
    // the operator's inherited environment it sees `DISPLAY=:0` and creates
    // `…/at-spi/bus_0` — the HOST's bus. Measured exactly that way on the first live
    // run of this code: a desktop provisioned at :110 came up bound to `bus_0`, which
    // means the sandbox's own apps would have registered on the OPERATOR'S session and
    // `observe` would have read the owner's real desktop. Same leak as the walker's
    // (D-010(b)), entering through the provisioner instead.
    //
    // `sandboxXEnv` both refuses `:0` outright and pins DISPLAY to the sandbox; the
    // host bus keys are stripped on top so an inherited session address cannot win.
    const daemonEnv = sandboxXEnv(display);
    delete daemonEnv.DBUS_SESSION_BUS_ADDRESS;
    delete daemonEnv.AT_SPI_BUS_ADDRESS;
    // NOT managedSpawn: --fork means this process exits immediately and the daemon it
    // left behind is the thing we want, so there is no child handle to enrol. The
    // daemon is reaped with the desktop by `release()`, which kills the bus address's
    // socket owner along with the rest of the display's processes.
    const started = spawnSync(busCmd.bin, busCmd.args, { encoding: 'utf8', timeout, env: daemonEnv });
    const sessionBus = (started.stdout ?? '').trim();
    if (!sessionBus) return null;

    const probe = a11yBusCommand(sessionBus);
    const got = spawnSync(probe.bin, probe.args, { encoding: 'utf8', env: probe.env, timeout });
    const a11yBus = parseA11yBusAddress(got.stdout ?? '');
    if (!a11yBus) return null;
    if (!busBelongsToDisplay(a11yBus, display)) return null;

    const publish = publishBusPropertyCommand(display, a11yBus);
    spawnSync(publish.bin, publish.args, { env: sandboxXEnv(display), timeout: 5000 });

    return {
      sessionBus,
      a11yBus,
      env: { ...A11Y_APP_ENV, DBUS_SESSION_BUS_ADDRESS: sessionBus, AT_SPI_BUS_ADDRESS: a11yBus },
    };
  } catch {
    return null;
  }
}
