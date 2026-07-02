/**
 * POST /api/desktop/local-model-install — the provisioner wizard's Desktop-UI write side
 * (local-concurrent-inference-2026-07-02 P-009). Plans + applies via `provisioner/provision.ts`
 * (same core as the CLI and the `provisioner:install` agent-tool): writes the backend's systemd
 * unit and registers it in the gateway's durable local-backend pool.
 *
 * Body: `{ start?: boolean }`. `start` DEFAULTS TO FALSE — config-write + gateway-registration
 * only, no process started, no GPU touched. `start:true` also enables+starts the systemd unit
 * and health-checks it, which DOES load the model onto the GPU; the StepLocalModel UI gates
 * that behind an explicit confirmation (see its warning copy) — this route trusts the caller
 * already got that confirmation and does not re-derive it server-side.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { planProvision, applyProvision } from '../../../provisioner/provision';

export default defineTool({
  method: 'POST',
  path: '/desktop/local-model-install',
  auth: {},
  async handler(req: Request) {
    let start = false;
    try {
      const body = (await req.json().catch(() => ({}))) as { start?: unknown };
      start = body?.start === true;
    } catch {
      // no/invalid body — default to start:false (the safe path)
    }
    try {
      const plan = await planProvision();
      const result = await applyProvision(plan, { start });
      return Response.json({ ok: result.ok, plan, result });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});
