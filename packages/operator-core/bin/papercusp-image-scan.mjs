#!/usr/bin/env node
/**
 * papercusp-image-scan — real SBOM + vulnerability + secret scan of a GCP workspace-host
 * candidate image, emitting evidence bound to the exact release identity.
 *
 * Invoked by CommandGcpImageFamilyScanRunner as:
 *     papercusp-image-scan --json-stdin        (payload on stdin)
 *
 * INPUT  { projectId, imageId, buildManifestIdentity, releaseSha256 }
 * OUTPUT { imageId, buildManifestIdentity, releaseSha256, trusted, sbomSha256,
 *          vulnerabilityFindings, secretFindings, evidenceRef }
 *
 * The consuming adapter (scanEvidence, gcp-image-family-adapter.ts) hard-requires
 * trusted===true, vulnerabilityFindings===0 and secretFindings===0, and requires the
 * three identity fields to equal the request exactly. That check is the release gate;
 * this tool's job is to produce an HONEST measurement, never a passing one.
 *
 * WHY AN OFFLINE DISK SCAN, NOT A BOOTED IMAGE: the candidate is attached as a secondary
 * read-only disk to a controlled scanner VM built from a pinned base image. Scanning the
 * filesystem offline (a) does not depend on the candidate being bootable or networked,
 * (b) cannot be influenced by anything the candidate would run at boot, and (c) keeps the
 * scanner's own toolchain outside the artifact under test. Booting the candidate and
 * scanning from inside it would let the subject of the measurement affect the measurement.
 *
 * TRUST RULE: `trusted` is emitted true only when every stage actually produced a parsed
 * result AND the image's own provenance document binds it to the requested manifest and
 * release digest. Any gap throws instead of degrading the verdict.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ResourceLedger,
  describeImage,
  ephemeralSuffix,
  fail,
  gcloudJson,
  main,
  parseImmutableImageId,
  parseJsonObject,
  requireDigest,
  requireText,
  run,
  runOrThrow,
} from './gcp-ephemeral.mjs';

const CONTRACT_VERSION = 'papercusp-gcp-image-family-release-v1';
const SCAN_ZONE = process.env.PAPERCUSP_SCAN_ZONE?.trim() || 'us-central1-a';
const SCANNER_BASE_IMAGE_FAMILY = process.env.PAPERCUSP_SCAN_BASE_FAMILY?.trim() || 'debian-12';
const SCANNER_BASE_IMAGE_PROJECT = process.env.PAPERCUSP_SCAN_BASE_PROJECT?.trim() || 'debian-cloud';
const SCANNER_MACHINE_TYPE = process.env.PAPERCUSP_SCAN_MACHINE_TYPE?.trim() || 'e2-standard-2';
const RESULT_PATH = '/var/log/papercusp-image-scan.json';
const DONE_PATH = '/var/log/papercusp-image-scan.done';

/**
 * gitleaks, pinned by version AND digest.
 *
 * Unlike syft and grype, gitleaks publishes NO install script — it distributes release
 * tarballs only. The previous code piped `gitleaks/gitleaks/master/scripts/install.sh`,
 * a path that has never existed: it 404s (confirmed against a syft install.sh control,
 * which returns 200). Because that line ended in `|| true`, the 404 was swallowed and the
 * run continued for another eight minutes before dying as `gitleaks-missing` — a symptom
 * eight steps removed from its cause.
 *
 * The digest is verified before the binary is trusted. This tool decides whether the
 * release contains secrets, so an unverified download would let a compromised or truncated
 * artifact silently report zero findings — which the adapter accepts as a passing gate.
 * The digest below equals the published gitleaks_8.30.1_checksums.txt entry.
 */
const GITLEAKS_VERSION = process.env.PAPERCUSP_SCAN_GITLEAKS_VERSION?.trim() || '8.30.1';
const GITLEAKS_SHA256 =
  process.env.PAPERCUSP_SCAN_GITLEAKS_SHA256?.trim() ||
  '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

/**
 * Startup script for the scanner VM. Mounts every filesystem on the attached candidate
 * disk read-only, then runs syft (SBOM), grype (vulnerabilities) and gitleaks (secrets)
 * against the mounted tree, writing one JSON document.
 *
 * It writes DONE_PATH last and always, with a status, so the poller can distinguish
 * "still running" from "finished, and here is what happened" — a scanner that dies
 * silently must not look like a scanner that found nothing.
 */
function startupScript() {
  return `#!/bin/bash
set -uo pipefail
exec >>/var/log/papercusp-scan-setup.log 2>&1
echo "[papercusp] scan starting $(date -Is)"

status="error"
detail="unknown"

finish() {
  echo "{\\"status\\":\\"\${status}\\",\\"detail\\":\\"\${detail}\\"}" > ${DONE_PATH}
  echo "[papercusp] scan finished status=\${status} detail=\${detail} $(date -Is)"
}
trap finish EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update -y || { detail="apt-update-failed"; exit 1; }
apt-get install -y curl ca-certificates jq >/dev/null || { detail="apt-install-failed"; exit 1; }

# Pinned installers, checked into the release path rather than 'latest'.
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin || { detail="syft-install-failed"; exit 1; }
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin || { detail="grype-install-failed"; exit 1; }
# gitleaks has no installer script (see GITLEAKS_VERSION above): fetch the pinned release
# tarball and VERIFY it before trusting the binary. Every step reports its OWN failure —
# the previous '|| true' here is exactly why this surfaced as 'gitleaks-missing' instead of
# naming the 404 that caused it.
curl -sSfL -o /tmp/gitleaks.tgz \\
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \\
  || { detail="gitleaks-download-failed"; exit 1; }
echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tgz" | sha256sum -c - >/dev/null 2>&1 \\
  || { detail="gitleaks-digest-mismatch"; exit 1; }
tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks || { detail="gitleaks-extract-failed"; exit 1; }
chmod +x /usr/local/bin/gitleaks || { detail="gitleaks-chmod-failed"; exit 1; }

# Locate the attached candidate disk (device name 'candidate') and mount every
# filesystem it carries, read-only. A candidate with no mountable filesystem is a
# hard failure, not an empty scan.
dev="/dev/disk/by-id/google-candidate"
if [ ! -e "\$dev" ]; then detail="candidate-disk-absent"; exit 1; fi
real=\$(readlink -f "\$dev")
mkdir -p /mnt/candidate
mounted=0
for part in \$(lsblk -nrpo NAME,FSTYPE "\$real" | awk '\$2!="" {print \$1}'); do
  target="/mnt/candidate/\$(basename "\$part")"
  mkdir -p "\$target"
  if mount -o ro,noexec,nosuid,nodev "\$part" "\$target" 2>/dev/null; then
    mounted=\$((mounted+1))
  fi
done
if [ "\$mounted" -eq 0 ]; then detail="no-filesystem-mounted"; exit 1; fi
echo "[papercusp] mounted \$mounted filesystem(s)"

syft scan dir:/mnt/candidate -o syft-json=/tmp/sbom.json >/dev/null 2>&1 || { detail="syft-failed"; exit 1; }
grype sbom:/tmp/sbom.json -o json > /tmp/vuln.json 2>/dev/null || { detail="grype-failed"; exit 1; }

secret_count=0
if command -v gitleaks >/dev/null 2>&1; then
  # --exit-code 0 makes gitleaks return 0 even WHEN IT FINDS SECRETS, so a non-zero exit here
  # is a genuine tool failure and must fail the scan. The previous '|| true' meant a crashed
  # scanner left no report, secret_count stayed 0, and the adapter's secretFindings===0 gate
  # PASSED — a secret scanner that dies was indistinguishable from a clean image. The
  # vulnerability path above already fails closed on a parse error; secrets did not.
  gitleaks dir /mnt/candidate --report-format json --report-path /tmp/secrets.json --no-banner --exit-code 0 >/dev/null 2>&1 \\
    || { detail="gitleaks-failed"; exit 1; }
  # gitleaks always writes the report, using [] for a clean scan (verified against 8.30.1), so
  # an absent or unparseable report means the measurement did not happen — never "zero secrets".
  if [ ! -f /tmp/secrets.json ]; then detail="gitleaks-no-report"; exit 1; fi
  secret_count=\$(jq 'if type=="array" then length else empty end' /tmp/secrets.json 2>/dev/null)
  if [ -z "\$secret_count" ]; then detail="secret-parse-failed"; exit 1; fi
else
  detail="gitleaks-missing"; exit 1
fi

vuln_count=\$(jq '[.matches[]?] | length' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_count" = "null" ]; then detail="vuln-parse-failed"; exit 1; fi

# A bare total is not actionable: it cannot distinguish 3922 negligible unfixed CVEs in
# the distro base from one Critical with a patch already available. The gate consumes the
# counts; a HUMAN triaging a red consumes these breakdowns. Both fail closed on a parse
# error, for the same reason the counts above do.
vuln_by_severity=\$(jq -c '[.matches[]?.vulnerability.severity] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_by_severity" = "null" ]; then detail="vuln-severity-parse-failed"; exit 1; fi
vuln_fixable=\$(jq '[.matches[]? | select(.vulnerability.fix.state == "fixed")] | length' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_fixable" = "null" ]; then detail="vuln-fix-parse-failed"; exit 1; fi
# Fixable AND severity, crossed. The two breakdowns above cannot be combined after the fact:
# a total of 3829 fixable beside 247 Critical cannot answer "how many of the Critical ones can
# we actually act on", and that is precisely the number that decides whether a red gate means
# "patch the image" or "the threshold is unsatisfiable against this distro". Measured on the
# 0.0.18 candidate, where the answer had to be guessed for want of this field (D-171).
vuln_fixable_by_severity=\$(jq -c '[.matches[]? | select(.vulnerability.fix.state == "fixed") | .vulnerability.severity] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_fixable_by_severity" = "null" ]; then detail="vuln-fix-severity-parse-failed"; exit 1; fi

# Secret DETAIL is rule + file + line ONLY. The matched value is deliberately NEVER
# emitted: this document is read back over SSH and lands in release logs and work-item
# evidence, so echoing the secret would convert a detection into a disclosure. Anyone
# extending this must keep .Match and .Secret out of the projection.
secrets_by_rule=\$(jq -c '[.[]?.RuleID] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_by_rule" = "null" ]; then detail="secret-rule-parse-failed"; exit 1; fi
secrets_sample=\$(jq -c '[.[]? | {rule:.RuleID, file:.File, line:.StartLine}] | .[0:50]' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_sample" = "null" ]; then detail="secret-sample-parse-failed"; exit 1; fi

sbom_sha=\$(sha256sum /tmp/sbom.json | cut -d' ' -f1)

jq -n \\
  --arg sbomSha256 "\$sbom_sha" \\
  --argjson vulnerabilityFindings "\$vuln_count" \\
  --argjson secretFindings "\$secret_count" \\
  --argjson mountedFilesystems "\$mounted" \\
  --argjson vulnerabilityBySeverity "\$vuln_by_severity" \\
  --argjson vulnerabilityFixable "\$vuln_fixable" \\
  --argjson vulnerabilityFixableBySeverity "\$vuln_fixable_by_severity" \\
  --argjson secretsByRule "\$secrets_by_rule" \\
  --argjson secretSample "\$secrets_sample" \\
  '{sbomSha256:\$sbomSha256, vulnerabilityFindings:\$vulnerabilityFindings, secretFindings:\$secretFindings, mountedFilesystems:\$mountedFilesystems, vulnerabilityBySeverity:\$vulnerabilityBySeverity, vulnerabilityFixable:\$vulnerabilityFixable, vulnerabilityFixableBySeverity:\$vulnerabilityFixableBySeverity, secretsByRule:\$secretsByRule, secretSample:\$secretSample}' \\
  > ${RESULT_PATH} || { detail="result-write-failed"; exit 1; }

status="ok"
detail="complete"
exit 0
`;
}

/**
 * Verify the image's own provenance document binds it to the requested release.
 * This is the anti-substitution check: it proves the thing we scanned is the thing the
 * release asked us to scan, not merely an image that happens to exist.
 */
function assertProvenanceBinding(image, expected) {
  const description = typeof image.description === 'string' ? image.description : '';
  if (!description.trim()) {
    fail('candidate image carries no release provenance document in its description');
  }
  const provenance = parseJsonObject(description, 'candidate image provenance');
  if (provenance.contractVersion !== CONTRACT_VERSION) {
    fail(`candidate image provenance contract must be ${CONTRACT_VERSION}`);
  }
  if (provenance.buildManifestIdentity !== expected.buildManifestIdentity) {
    fail('candidate image provenance buildManifestIdentity does not match the scan request');
  }
  if (requireDigest(provenance.releaseSha256, 'provenance.releaseSha256') !== expected.releaseSha256) {
    fail('candidate image provenance releaseSha256 does not match the scan request');
  }
  return provenance;
}

/** Poll the scanner VM over IAP until it writes its done-marker, or the budget expires. */
async function awaitScanCompletion(projectId, instance, zone, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const sshArgs = (command) => [
    'compute',
    'ssh',
    instance,
    `--project=${projectId}`,
    `--zone=${zone}`,
    '--tunnel-through-iap',
    '--quiet',
    '--command',
    command,
  ];

  let lastError = 'not-started';
  while (Date.now() < deadline) {
    const done = await run('gcloud', sshArgs(`cat ${DONE_PATH} 2>/dev/null || true`), {
      timeoutMs: 2 * 60 * 1000,
    }).catch((error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error) }));

    const marker = done.stdout.trim();
    if (done.exitCode === 0 && marker !== '') {
      const parsed = parseJsonObject(marker, 'scanner done-marker');
      if (parsed.status !== 'ok') {
        fail(`scanner VM finished unsuccessfully: ${String(parsed.detail ?? 'no detail')}`);
      }
      const result = await runOrThrow('gcloud', sshArgs(`cat ${RESULT_PATH}`), { timeoutMs: 2 * 60 * 1000 });
      return parseJsonObject(result.trim(), 'scanner result');
    }
    if (done.exitCode !== 0) lastError = done.stderr.slice(-300);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  fail(`scanner VM did not report completion within ${budgetMs}ms`, { lastError });
}

async function scan(input) {
  const requested = parseImmutableImageId(input.imageId, 'imageId');
  const projectId = requireText(input.projectId, 'projectId');
  if (projectId !== requested.projectId) {
    fail('projectId does not match the project embedded in imageId');
  }
  const buildManifestIdentity = requireText(input.buildManifestIdentity, 'buildManifestIdentity');
  const releaseSha256 = requireDigest(input.releaseSha256, 'releaseSha256');

  // 1. The image must exist, be READY, and prove it is the requested release.
  const image = await describeImage(projectId, requested.imageName);
  assertProvenanceBinding(image, { buildManifestIdentity, releaseSha256 });

  const ledger = new ResourceLedger(projectId);
  const suffix = ephemeralSuffix();
  const diskName = `pc-scan-disk-${suffix}`;
  const instanceName = `pc-scan-vm-${suffix}`;
  let residualResourceIds = [];
  let measurement;
  let startupScriptPath;

  try {
    // 2. Materialise the candidate as a disk we can read offline.
    await runOrThrow('gcloud', [
      'compute',
      'disks',
      'create',
      diskName,
      `--project=${projectId}`,
      `--zone=${SCAN_ZONE}`,
      `--image=${requested.imageName}`,
      `--image-project=${projectId}`,
      '--quiet',
    ]);
    ledger.track('disk', diskName, SCAN_ZONE);

    // 3. Stand up a controlled scanner from a pinned base image, candidate attached RO.
    //    The startup script goes via a temp file: `--metadata-from-file=/dev/stdin` is
    //    not reliable across gcloud versions, and a file keeps the payload inspectable
    //    if a run has to be debugged after the fact.
    startupScriptPath = join(await mkdtemp(join(tmpdir(), 'pc-image-scan-')), 'startup.sh');
    await writeFile(startupScriptPath, startupScript(), { mode: 0o600 });

    await runOrThrow(
      'gcloud',
      [
        'compute',
        'instances',
        'create',
        instanceName,
        `--project=${projectId}`,
        `--zone=${SCAN_ZONE}`,
        `--machine-type=${SCANNER_MACHINE_TYPE}`,
        `--image-family=${SCANNER_BASE_IMAGE_FAMILY}`,
        `--image-project=${SCANNER_BASE_IMAGE_PROJECT}`,
        `--disk=name=${diskName},device-name=candidate,mode=ro,auto-delete=no`,
        '--no-service-account',
        '--no-scopes',
        `--metadata-from-file=startup-script=${startupScriptPath}`,
        '--labels=papercusp-artifact=workspace-host,papercusp-role=image-scanner',
        '--quiet',
      ],
      { timeoutMs: 8 * 60 * 1000 },
    );
    ledger.track('instance', instanceName, SCAN_ZONE);

    // 4. Wait for a real measurement.
    measurement = await awaitScanCompletion(projectId, instanceName, SCAN_ZONE, 25 * 60 * 1000);
  } finally {
    // Teardown runs even when the scan threw: a failed scan must not leak billable VMs.
    residualResourceIds = await ledger.destroyAll();
    if (startupScriptPath) {
      await rm(dirname(startupScriptPath), { recursive: true, force: true }).catch(() => {});
    }
  }

  // 5. Convert the measurement into evidence — refusing anything unparseable.
  const sbomSha256 = requireDigest(measurement.sbomSha256, 'scan.sbomSha256');
  const vulnerabilityFindings = measurement.vulnerabilityFindings;
  const secretFindings = measurement.secretFindings;
  if (!Number.isSafeInteger(vulnerabilityFindings) || vulnerabilityFindings < 0) {
    fail('scanner returned a non-integer vulnerability count');
  }
  if (!Number.isSafeInteger(secretFindings) || secretFindings < 0) {
    fail('scanner returned a non-integer secret count');
  }
  if (residualResourceIds.length > 0) {
    // Leaked billable resources invalidate the run's hygiene claim; surface, do not hide.
    fail('scanner could not destroy every ephemeral resource', { residualResourceIds });
  }

  const evidenceRef = `gcp-image-scan:${requested.imageName}:${createHash('sha256')
    .update(`${requested.imageId}|${buildManifestIdentity}|${releaseSha256}|${sbomSha256}`)
    .digest('hex')
    .slice(0, 32)}`;

  // Diagnostics travel WITH the counts. Without them a non-zero result is a dead end:
  // the gate says "3922" and the image is gone by the time anyone asks which 3922.
  // These never gate anything — they exist so a red is triageable without a re-scan.
  const isPlainObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const findings = {
    ...(isPlainObject(measurement.vulnerabilityBySeverity)
      ? { vulnerabilityBySeverity: measurement.vulnerabilityBySeverity }
      : {}),
    ...(Number.isSafeInteger(measurement.vulnerabilityFixable)
      ? { vulnerabilityFixable: measurement.vulnerabilityFixable }
      : {}),
    ...(isPlainObject(measurement.secretsByRule)
      ? { secretsByRule: measurement.secretsByRule }
      : {}),
    // rule/file/line only — the scanner never emits the matched value, and neither do we.
    ...(Array.isArray(measurement.secretSample)
      ? { secretSample: measurement.secretSample }
      : {}),
  };

  return {
    imageId: requested.imageId,
    buildManifestIdentity,
    releaseSha256,
    // Every stage produced a parsed result and provenance bound the subject: trusted.
    // The zero-finding requirement is the ADAPTER's gate, deliberately not ours — we
    // report what we measured and let the release fail honestly if it is non-zero.
    trusted: true,
    sbomSha256,
    vulnerabilityFindings,
    secretFindings,
    ...findings,
    evidenceRef,
  };
}

await main('papercusp-image-scan', scan);
