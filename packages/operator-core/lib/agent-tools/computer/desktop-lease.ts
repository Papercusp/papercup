/**
 * desktop-lease.ts — per-hive sandbox-desktop lifecycle: the integration seam
 * between the desktop provisioner and capability:computer.
 *
 * A hive whose bees should operate a GUI gets ONE leased sandbox desktop. The
 * bee spawn env then points capability:computer at it via `desktopEnvForHive()`
 * (the operator merges that into the child env — the same way the frame path
 * sets `DISPLAY` from `acquireAgentDisplay`). Teardown rides pot:dissolve.
 *
 * In-process state (a desktop is a live child of THIS operator loop — if the loop
 * dies its Xvfb dies with it), mirroring `display-allocator`'s rationale: a
 * per-process resource lease is legitimately non-PG.
 *
 * The provisioner is an injectable seam so the lifecycle unit-tests without
 * spawning a real Xvfb.
 */
import {
  provisionSandboxDesktop as realProvision,
  type ProvisionOptions,
  type SandboxDesktop,
} from './desktop-provisioner';

type Provisioner = (opts?: ProvisionOptions) => Promise<SandboxDesktop>;

let provisionImpl: Provisioner = realProvision;
/** Test seam — swap the provisioner so the lifecycle tests need no live X. */
export function __setProvisionerForTests(next: Provisioner): void {
  provisionImpl = next;
}
export function __resetProvisioner(): void {
  provisionImpl = realProvision;
}

const leases = new Map<string, SandboxDesktop>();
/** Coalesce concurrent ensure() calls for the same hive onto one provision. */
const inflight = new Map<string, Promise<SandboxDesktop>>();

/** Provision (or return the existing) sandbox desktop for a hive. Idempotent + race-safe. */
export async function ensureHiveDesktop(potSlug: string, opts?: ProvisionOptions): Promise<SandboxDesktop> {
  const existing = leases.get(potSlug);
  if (existing) return existing;
  const pending = inflight.get(potSlug);
  if (pending) return pending;

  const p = (async () => {
    const desktop = await provisionImpl(opts);
    leases.set(potSlug, desktop);
    return desktop;
  })().finally(() => inflight.delete(potSlug));
  inflight.set(potSlug, p);
  return p;
}

/** The leased desktop for a hive, or undefined. */
export function hiveDesktop(potSlug: string): SandboxDesktop | undefined {
  return leases.get(potSlug);
}

/**
 * The leased X display string for a hive (e.g. ":110"), or undefined. For wiring
 * `DISPLAY` into a capability:bash exec (computer-tool-plan Gap C) so a bee can LAUNCH
 * GUI apps on its leased desktop (`firefox &`); capability:computer then drives them.
 * Never `:0` — a lease is always a sandbox display.
 */
export function displayForHive(potSlug: string): string | undefined {
  return leases.get(potSlug)?.display;
}

/**
 * The env vars capability:computer reads — merge into a bee's spawn env so the
 * tool resolves the hive's leased display (and never the host :0). Empty object
 * when the hive has no desktop (→ the tool errors "no desktop leased", which is
 * the correct deny-by-default).
 */
export function desktopEnvForHive(potSlug: string): Record<string, string> {
  const d = leases.get(potSlug);
  if (!d) return {};
  return {
    PAPERCUSP_COMPUTER_DISPLAY: d.display,
    PAPERCUSP_COMPUTER_WIDTH: String(d.width),
    PAPERCUSP_COMPUTER_HEIGHT: String(d.height),
  };
}

/** Tear down a hive's desktop (call from pot:dissolve). Idempotent. */
export async function releaseHiveDesktop(potSlug: string): Promise<void> {
  const d = leases.get(potSlug);
  if (!d) return;
  leases.delete(potSlug);
  await d.release();
}

/** Hive slugs that currently hold a desktop lease (observability). */
export function leasedHiveDesktops(): string[] {
  return [...leases.keys()];
}

/** Tear down EVERY leased desktop (operator shutdown). */
export async function releaseAllHiveDesktops(): Promise<void> {
  const all = [...leases.values()];
  leases.clear();
  await Promise.all(all.map((d) => d.release().catch(() => {})));
}
