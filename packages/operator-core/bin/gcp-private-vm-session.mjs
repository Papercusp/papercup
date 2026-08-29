/**
 * gcp-private-vm-session — boot ONE private GCP instance, run a script on it over IAP,
 * capture stdout, and tear the whole thing down leaving zero residue.
 *
 * This is the flow shared by the two workspace-host clean-room subjects, which are
 * deliberately NOT the same thing:
 *
 *   1. PRE-BUILD bootstrap acceptance (papercusp-gcp-bootstrap-acceptance) boots STOCK
 *      Ubuntu and runs the release fixture's bootstrap script on it, proving the SIGNED
 *      BUNDLE installs and self-attests on a pristine machine. Its attestation becomes the
 *      expected reference the release gate ratifies.
 *   2. POST-BUILD canary (papercusp-gcp-clean-room) boots the ALREADY-BUILT candidate image
 *      and proves that image boots privately and self-attests to the same release.
 *
 * The ordering is load-bearing and is why (1) cannot boot the candidate image: the gate that
 * authorizes building the image consumes (1)'s report, so the image does not exist yet.
 * `gcp-image-family.ts:validateCleanBootProof` then checks (2)'s attestation AGAINST (1)'s.
 *
 * WHY PRIVATE-ONLY: instances are created with --no-address and reached exclusively over
 * IAP. For the canary this is the very property the gate asserts; for the acceptance run it
 * keeps the two rigs identical so a bundle that only installs on a publicly-addressed box
 * cannot pass here and fail there.
 *
 * TRUST RULE: every value returned is OBSERVED — read back from the GCP API or from the
 * guest's own stdout. Nothing is reported because we intended it. In particular `terminated`
 * and `residualResourceIds` are computed from the teardown's real outcome, so a leaked VM
 * can never be reported as a clean run.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResourceLedger, ephemeralSuffix, fail, gcloudJson, run, runOrThrow } from './gcp-ephemeral.mjs';
import { buildCleanRoomInstanceCreateArgs } from './gcp-clean-room-args.mjs';

/** Stock Ubuntu 24.04 LTS, matching WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION ('24.04'). */
export const STOCK_UBUNTU_IMAGE_PROJECT = 'ubuntu-os-cloud';
export const STOCK_UBUNTU_IMAGE_FAMILY_BY_ARCHITECTURE = Object.freeze({
  x86_64: 'ubuntu-2404-lts-amd64',
  amd64: 'ubuntu-2404-lts-amd64',
  arm64: 'ubuntu-2404-lts-arm64',
  aarch64: 'ubuntu-2404-lts-arm64',
});

const DEFAULT_BOOT_BUDGET_MS = 12 * 60 * 1000;
const DEFAULT_SCRIPT_BUDGET_MS = 20 * 60 * 1000;

/**
 * Resolve an image FAMILY to the concrete image it currently points at.
 *
 * The family is resolved to an exact name before the instance is created so the run records
 * WHICH stock image it actually used. Passing `--image-family` straight to `instances create`
 * would work but leaves no record: families advance (ubuntu-os-cloud republishes roughly
 * monthly), so a later investigation into "why did acceptance pass then fail" could not tell
 * whether the base image moved underneath it.
 */
export async function resolveImageFromFamily(imageProject, imageFamily) {
  const image = await gcloudJson([
    'compute',
    'images',
    'describe-from-family',
    imageFamily,
    `--project=${imageProject}`,
  ]);
  if (!image || typeof image !== 'object' || typeof image.name !== 'string' || image.name.trim() === '') {
    fail(`image family ${imageProject}/${imageFamily} did not resolve to a concrete image`);
  }
  if (image.status !== 'READY') {
    fail(`image ${image.name} from family ${imageFamily} is not READY (status=${String(image.status)})`);
  }
  return image.name;
}

/** Map a contract architecture string to its stock Ubuntu family, refusing anything unknown. */
export function stockUbuntuImageFamily(architecture) {
  const key = String(architecture ?? '').trim().toLowerCase();
  const family = STOCK_UBUNTU_IMAGE_FAMILY_BY_ARCHITECTURE[key];
  if (!family) {
    fail(
      `no stock Ubuntu image family is known for architecture '${architecture}'; ` +
        `expected one of ${Object.keys(STOCK_UBUNTU_IMAGE_FAMILY_BY_ARCHITECTURE).join(', ')}`,
    );
  }
  return family;
}

/** Wait until the instance reports RUNNING, or throw. */
async function awaitRunning(projectId, instance, zone, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let lastStatus = 'UNKNOWN';
  while (Date.now() < deadline) {
    const described = await gcloudJson([
      'compute',
      'instances',
      'describe',
      instance,
      `--project=${projectId}`,
      `--zone=${zone}`,
    ]).catch(() => null);
    if (described?.status) {
      lastStatus = described.status;
      if (lastStatus === 'RUNNING') return described;
      if (lastStatus === 'TERMINATED' || lastStatus === 'SUSPENDED') {
        fail(`private instance entered ${lastStatus} before it could be exercised`);
      }
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  fail(`private instance did not reach RUNNING within ${budgetMs}ms (last status ${lastStatus})`);
}

/**
 * Read back whether GCP actually assigned a public IPv4. This is READ FROM THE API rather
 * than inferred from the --no-address flag we passed: the property is about what exists, not
 * about what we asked for.
 */
export function hasPublicIpv4(instance) {
  const interfaces = Array.isArray(instance?.networkInterfaces) ? instance.networkInterfaces : [];
  return interfaces.some((nic) =>
    (Array.isArray(nic?.accessConfigs) ? nic.accessConfigs : []).some(
      (config) => typeof config?.natIP === 'string' && config.natIP.trim() !== '',
    ),
  );
}

/** Poll IAP SSH until it answers, proving OS Login is usable over the private path. */
async function awaitOsLogin(projectId, instance, zone, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let lastError = 'not-attempted';
  while (Date.now() < deadline) {
    const probe = await run(
      'gcloud',
      [
        'compute',
        'ssh',
        instance,
        `--project=${projectId}`,
        `--zone=${zone}`,
        '--tunnel-through-iap',
        '--quiet',
        '--command',
        'echo papercusp-oslogin-ready',
      ],
      { timeoutMs: 3 * 60 * 1000 },
    ).catch((error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error) }));

    if (probe.exitCode === 0 && probe.stdout.includes('papercusp-oslogin-ready')) return true;
    lastError = probe.stderr.slice(-300);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  fail(`OS Login over IAP did not become ready within ${budgetMs}ms`, { lastError });
}

/**
 * Create a private instance, run `script` on it as root over IAP, and tear it down.
 *
 * Teardown runs in a `finally`, so a failure anywhere above still destroys the instance —
 * a failed run must never leave a billable VM behind. The observed teardown outcome is
 * returned rather than assumed.
 */
export async function runScriptOnPrivateVm({
  projectId,
  zone,
  subnetwork,
  imageName,
  imageProject,
  script,
  fixtureId,
  role = 'clean-room',
  instancePrefix = 'pc-cleanroom',
  machineType,
  remotePath = '/tmp/papercusp-bootstrap.sh',
  bootBudgetMs = DEFAULT_BOOT_BUDGET_MS,
  scriptBudgetMs = DEFAULT_SCRIPT_BUDGET_MS,
}) {
  const ledger = new ResourceLedger(projectId);
  const instanceName = `${instancePrefix}-${ephemeralSuffix()}`;
  const observedAt = new Date().toISOString();

  let scriptDir;
  let stdout;
  let computeRunning = false;
  let osLoginReady = false;
  let publicIpv4Assigned = false;
  let residualResourceIds = [];

  try {
    scriptDir = await mkdtemp(join(tmpdir(), 'pc-private-vm-'));
    const scriptPath = join(scriptDir, 'bootstrap.sh');
    await writeFile(scriptPath, script, { mode: 0o700 });

    await runOrThrow(
      'gcloud',
      buildCleanRoomInstanceCreateArgs({
        instanceName,
        projectId,
        zone,
        imageName,
        imageProject,
        subnetwork,
        fixtureId,
        role,
        ...(machineType ? { machineType } : {}),
      }),
      { timeoutMs: 8 * 60 * 1000 },
    );
    ledger.track('instance', instanceName, zone);

    // Observed, not assumed.
    const running = await awaitRunning(projectId, instanceName, zone, bootBudgetMs);
    computeRunning = running.status === 'RUNNING';
    publicIpv4Assigned = hasPublicIpv4(running);
    if (publicIpv4Assigned) {
      fail('private instance was assigned a public IPv4; the private-boot property does not hold');
    }

    osLoginReady = await awaitOsLogin(projectId, instanceName, zone, bootBudgetMs);

    await runOrThrow(
      'gcloud',
      [
        'compute',
        'scp',
        scriptPath,
        `${instanceName}:${remotePath}`,
        `--project=${projectId}`,
        `--zone=${zone}`,
        '--tunnel-through-iap',
        '--quiet',
      ],
      { timeoutMs: 5 * 60 * 1000 },
    );

    stdout = await runOrThrow(
      'gcloud',
      [
        'compute',
        'ssh',
        instanceName,
        `--project=${projectId}`,
        `--zone=${zone}`,
        '--tunnel-through-iap',
        '--quiet',
        '--command',
        `sudo bash ${remotePath}`,
      ],
      { timeoutMs: scriptBudgetMs },
    );
  } finally {
    // Teardown always runs, including on every failure path above.
    residualResourceIds = await ledger.destroyAll();
    if (scriptDir) await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    instanceName,
    observedAt,
    stdout,
    computeRunning,
    osLoginReady,
    publicIpv4Assigned,
    // Terminated is true only when teardown actually left nothing behind.
    terminated: residualResourceIds.length === 0,
    residualResourceIds,
  };
}
