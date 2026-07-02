/**
 * provisioner:* — agent control surface for the provisioner wizard (local-concurrent-
 * inference-2026-07-02 P-009, D-006 "detect → recommend → download/configure → register").
 * The headless-CLI/agent-facing mirror of the Desktop SetupWizard step — both drive the SAME
 * `provisioner/provision.ts` core, so there's one place the logic can drift out of sync.
 *
 * `provisioner:detect_hardware` / `provisioner:recommend` / `provisioner:plan_install` are all
 * READ-ONLY (the last does a filesystem probe for already-downloaded weights, nothing else).
 * `provisioner:install` is the one WRITE tool, and even it defaults to config-write +
 * gateway-registry-write only — it does NOT start the backend (and therefore does not touch
 * the GPU) unless the caller explicitly passes `start: true`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { detectHardware } from '../../provisioner/hardware-detect';
import { recommendCombo } from '../../provisioner/recommend';
import { planProvision, applyProvision } from '../../provisioner/provision';
import { resolveLlamaBinary, computeCapToArch } from '../../provisioner/llama-binary';

const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export const provisionerDetectHardwareTool = defineTool({
  name: 'provisioner:detect_hardware',
  description:
    "Probe this machine's GPU vendor/VRAM and platform (nvidia-smi / rocm-smi / sysctl — all read-only, never touches a GPU's resident memory). Returns {ok, hardware:{platform,arch,ramGB,gpu,notes}}.",
  guidance: {
    when: 'First-run provisioning, or re-checking hardware after a driver/GPU change.',
    notWhen: "You already have a recent detectHardware() result and just need a recommendation — that's provisioner:recommend, which detects internally.",
    chaining: 'provisioner:detect_hardware → provisioner:recommend (or call recommend directly, it re-detects) → provisioner:plan_install → provisioner:install.',
    seeAlso: ['provisioner:recommend', 'provisioner:plan_install'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const hardware = await detectHardware();
      return ok({ hardware });
    } catch (e) {
      return fail({ error: `provisioner:detect_hardware failed: ${errMsg(e)}` });
    }
  },
});

export const provisionerRecommendTool = defineTool({
  name: 'provisioner:recommend',
  description:
    "Detect this machine's hardware and recommend a catalog combo for it (D-005 catalog — entries may be `status:'provisional'` until the P-006/P-007 certification battery lands). Returns {ok, hardware, recommendation:{entry,tier,reason}}. `entry:null` means no local combo fits (surfaced in `reason`, e.g. no GPU → cloud gateway).",
  guidance: {
    when: 'Deciding what to install before committing to a plan/apply.',
    notWhen: "You're ready to actually write config — that's provisioner:plan_install (does the same detect+recommend, plus weights resolution + rendered config).",
    chaining: 'provisioner:recommend → provisioner:plan_install → provisioner:install.',
    seeAlso: ['provisioner:detect_hardware', 'provisioner:plan_install'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const hardware = await detectHardware();
      const recommendation = recommendCombo(hardware);
      return ok({ hardware, recommendation });
    } catch (e) {
      return fail({ error: `provisioner:recommend failed: ${errMsg(e)}` });
    }
  },
});

export const provisionerPlanInstallTool = defineTool({
  name: 'provisioner:plan_install',
  description:
    'Dry-run the full provisioner flow: detect hardware → recommend a combo → resolve its weights against the local ollama blob store → render its backend config. Performs NO writes (not the systemd unit, not the gateway registry) — this is provisioner:install\'s plan, without applying it. Returns {ok, plan:{hardware,recommendation,weights,unitFileContent,unitFilePath,gatewayRegisterInput,blocked}}. `blocked` non-null means it cannot be applied as-is yet (no combo fits, or weights need `ollama pull` first).',
  guidance: {
    when: 'Previewing exactly what provisioner:install would write, before committing.',
    notWhen: "You just want the recommendation without the weights/config detail — that's provisioner:recommend (cheaper, no filesystem probe).",
    chaining: 'provisioner:plan_install → (if blocked is null) provisioner:install.',
    seeAlso: ['provisioner:recommend', 'provisioner:install'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const plan = await planProvision();
      return ok({ plan });
    } catch (e) {
      return fail({ error: `provisioner:plan_install failed: ${errMsg(e)}` });
    }
  },
});

export const provisionerInstallTool = defineTool({
  name: 'provisioner:install',
  description:
    "Plan + apply the provisioner flow: writes the recommended backend's systemd user-unit and registers it in the gateway's durable local-backend pool (gateway:local_backend_register's same registry). By DEFAULT this does NOT start the backend or touch the GPU — pass `start:true` to also `systemctl --user enable --now` it and health-check it, which DOES load the model onto the GPU. Pass `provisionBinary:true` (WI-1617/D-009 #2) to first resolve a real `llama-server` binary — a cache hit is fast, but a first-time GitHub-release download or from-source CUDA build genuinely takes real minutes and network/CPU — instead of assuming `llama-server` is already on PATH; on a resolution failure the whole call fails rather than silently falling back to PATH. Returns {ok, plan, result:{wroteUnit,registered,started}}. If `plan.blocked` is non-null (no combo fits / weights not downloaded) the apply is refused and `result.error` explains why.",
  guidance: {
    when: 'Actually provisioning a local inference backend after reviewing provisioner:plan_install\'s output.',
    notWhen: 'A GPU-resident process may already be running (another backend load, a live smoke test) — check coord:presence / coord:ask before passing start:true. Config-write + registry-registration alone (start omitted/false) is always safe. Also not when you only want to know WHAT would be resolved without committing minutes to a real download/build — inspect llama-binary.ts\'s pure `assetNameRules`/`pickPrebuiltAsset` directly for that.',
    chaining: 'provisioner:plan_install (review) → provisioner:install (start:false by default; add provisionBinary:true on the first run for a given box) → once verified idle, provisioner:install again with start:true, or start the unit manually.',
    seeAlso: ['provisioner:plan_install', 'gateway:local_backend_list', 'gateway:local_backend_register'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    start: z
      .boolean()
      .optional()
      .describe(
        'Also enable+start the systemd unit and health-check it. Default false. WARNING: true loads the recommended model onto the GPU — confirm via coord:presence/coord:ask that nothing else needs the card first.',
      ),
    provisionBinary: z
      .boolean()
      .optional()
      .describe(
        'Resolve (download a matching GitHub-release prebuilt, or build from source) a real llama-server binary before planning, instead of assuming one is already on PATH. Default false. A from-source build can take real minutes.',
      ),
  }),
  async handler({ start, provisionBinary }) {
    try {
      let binPath: string | undefined;
      if (provisionBinary) {
        const hw = await detectHardware();
        const binaryResult = await resolveLlamaBinary(hw, {
          cudaArch: hw.gpu?.vendor === 'nvidia' && hw.gpu.computeCap ? computeCapToArch(hw.gpu.computeCap) : undefined,
          cudaHostCompiler: hw.gpu?.vendor === 'nvidia' ? process.env.PAPERCUSP_CUDA_HOST_COMPILER : undefined,
        });
        if (!binaryResult.ok) {
          return fail({ error: `provisioner:install failed: binary provisioning failed: ${binaryResult.blocked}` });
        }
        binPath = binaryResult.binPath;
      }
      const plan = await planProvision({ binPath });
      const result = await applyProvision(plan, { start: start ?? false });
      return ok({ plan, result });
    } catch (e) {
      return fail({ error: `provisioner:install failed: ${errMsg(e)}` });
    }
  },
});
