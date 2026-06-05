/**
 * Operator host-adapter for `@papercusp/locks`.
 *
 * Wires the package's single host seam — `getAdminBaseUrl` — to the
 * operator's embedded-pg discovery. The package derives the `papercusp_su`
 * side-database URL from this main admin URL and owns everything else
 * (pools, migrations, advisory lock, cascade, wait subsystem, janitor).
 *
 * Imported for its side-effect by every operator-side locks shim
 * (su-lock-store / coordinator / in-workspace-txn / workspace-listener /
 * path-normalize), so `configureLocks` runs before any store call no matter
 * which module a consumer loads first. `configureLocks` only sets a module
 * singleton, so repeated imports (ESM evaluates this module once) are a
 * no-op.
 */
import { configureLocks } from '@papercusp/locks';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';

configureLocks({
  getAdminBaseUrl: () => getHarnessAdminUrl(),
});
