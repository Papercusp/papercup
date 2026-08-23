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
import { activeWorkspaceId } from '../../workspace-registry';
import {
  registerDesktopSession,
  markDesktopReady,
  closeDesktopSession,
} from '../../desktop/desktop-session-registry';

type Provisioner = (opts?: ProvisionOptions) => Promise<SandboxDesktop>;

/**
 * P-003 (D-004): the registry mirror. `leases` above stays the AUTHORITY for
 * liveness — it holds the actual child process — and this map only remembers which
 * PG row describes it, so teardown can close the record.
 *
 * Every registry write here is BEST-EFFORT and deliberately so. A desktop works
 * perfectly well without its inventory row; failing a provision because Postgres
 * hiccupped would trade a working feature for bookkeeping. The degraded outcome is
 * that `computer:list_desktops` under-reports, which is visible and recoverable —
 * the reconciler and the next provision both repair it.
 */
const sessionIds = new Map<string, string>();

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
    await recordLeaseInRegistry(potSlug, desktop);
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

/**
 * Mirror a freshly-provisioned hive lease into the registry (scope='pot' per
 * D-005, kind='xvfb-local'). Best-effort: see `sessionIds`' comment for why a
 * failure here must never fail the provision.
 *
 * The GL verdict measured by P-002's ladder is stamped as a capability so
 * downstream consumers read it instead of re-probing the display (D-004:
 * capabilities are MEASURED, never assumed).
 */
async function recordLeaseInRegistry(potSlug: string, desktop: SandboxDesktop): Promise<void> {
  try {
    const session = await registerDesktopSession({
      workspaceId: activeWorkspaceId(),
      harnessSlug: potSlug,
      kind: 'xvfb-local',
      scope: 'pot',
      scopeRef: potSlug,
      display: desktop.display,
      displayGeometry: { width: desktop.width, height: desktop.height },
      // D-006: only sent when the caller REQUESTED a box. Omitted lets the registry
      // apply DEFAULT_CAPTURE_GEOMETRY, so the default lives in exactly one place.
      ...(desktop.capture ? { captureGeometry: desktop.capture } : {}),
      // P-005 — the cross-process freeze/kill handle. Without it the lifecycle
      // governor can see this desktop go idle and cannot do anything about it,
      // because `release()` above is a closure in THIS loop.
      taskId: desktop.taskId,
    });
    sessionIds.set(potSlug, session.id);
    await markDesktopReady(
      session.id,
      { capabilities: { gl: Boolean((desktop as { gl?: unknown }).gl) } },
      undefined,
    );
  } catch {
    /* inventory only — a desktop without its row still works; the reconciler repairs it */
  }
}

/** Close a hive's registry row, if it has one. Best-effort + idempotent. */
async function closeLeaseInRegistry(potSlug: string): Promise<void> {
  const id = sessionIds.get(potSlug);
  if (!id) return;
  sessionIds.delete(potSlug);
  try {
    await closeDesktopSession(id, 'released');
  } catch {
    /* inventory only */
  }
}

/** Tear down a hive's desktop (call from pot:dissolve). Idempotent. */
export async function releaseHiveDesktop(potSlug: string): Promise<void> {
  const d = leases.get(potSlug);
  if (!d) return;
  leases.delete(potSlug);
  await closeLeaseInRegistry(potSlug);
  await d.release();
}

/** Hive slugs that currently hold a desktop lease (observability). */
export function leasedHiveDesktops(): string[] {
  return [...leases.keys()];
}

/** Tear down EVERY leased desktop (operator shutdown). */
export async function releaseAllHiveDesktops(): Promise<void> {
  const all = [...leases.values()];
  const slugs = [...leases.keys()];
  leases.clear();
  await Promise.all(slugs.map((s) => closeLeaseInRegistry(s)));
  await Promise.all(all.map((d) => d.release().catch(() => {})));
}

/** The registry session id backing a hive's lease (observability / tests). */
export function hiveDesktopSessionId(potSlug: string): string | undefined {
  return sessionIds.get(potSlug);
}
