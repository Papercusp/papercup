import { defineTool } from '@papercusp/agent-mcp';
import { isTaskManagerEnabled } from '../../../task-manager/enabled';
import { getTaskInventory, disabledInventory } from '../../../task-manager/inventory';

/**
 * Admin task inventory — the NON-UI read surface for the Task Manager
 * (task-manager-no-escape-2026-07-27, P-017).
 *
 * Mirrors `/admin/schedules/inventory` exactly, including its posture: it shares the
 * SAME store the `processes:list` MCP tool reads, and it is READ-ONLY. Control verbs
 * live on the MCP tools, which are separately capability-gated (`processes:kill` /
 * `processes:control`) — a dashboard fetch must not be able to kill anything.
 *
 * ⚠ The PANE no longer reads through here (WI-6475). A bare `fetch` from the desktop
 * webview does not ride the sys:http IPC bridge that injects the loopback-superuser
 * bearer, so it resolves `unverified-loopback` and this VT gate 403-blanks the pane —
 * the failure mode documented in `endpoint-route/__tests__/auth-posture.test.ts`
 * (EI-338). The UI now reads the `taskManager.inventory` sync query instead, whose
 * transport is `auth:'loopback'`. This route stays for curl/external probes and shares
 * `getTaskInventory` with that resolver so the two can never report different numbers.
 *
 * `live=1` runs a dry-run reconcile so the caller can see kernel truth (unaccounted
 * groups, degraded scans) alongside the ledger. Still writes nothing.
 */
export default defineTool({
  method: 'GET',
  path: '/admin/tasks/inventory',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    // WI-6499: fail CLOSED via the shared authority — this used to `.catch(() => true)`,
    // which served a live inventory whenever the flag backend was unreachable.
    if (!(await isTaskManagerEnabled('admin:task-manager'))) return Response.json(disabledInventory());

    const url = new URL(req.url);
    return Response.json(
      await getTaskInventory({
        state: url.searchParams.get('state'),
        cls: url.searchParams.get('class'),
        includeEnded: url.searchParams.get('includeEnded') === '1',
        live: url.searchParams.get('live') === '1',
      }),
    );
  },
});
