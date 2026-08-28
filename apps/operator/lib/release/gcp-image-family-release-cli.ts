/**
 * Run the production GCP workspace-host image-family release composition.
 *
 * The request file contains both the complete release request (including its already-verified
 * artifact/gate evidence) and the persisted provider connection.  The CLI performs read-only
 * credential/executable probes before invoking Packer, then calls the connection-bound concrete
 * adapter.  It never accepts a raw key path or silently falls back to ambient ADC.
 */
import { readFile } from "node:fs/promises";

import type { WorkspaceHostProviderConnection } from "@papercusp/deployment-driver";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import {
  executeConfiguredGcpImageFamilyRelease,
  probeGcpImageFamilyCredential,
  probeGcpImageFamilyExecutables,
  type GcpImageFamilyReleaseCompositionOptions,
} from "@papercusp/operator-core/lib/workspace-host/gcp-image-family-production";
import type {
  GcpImageFamilyReleaseRequest,
  GcpImageFamilyReleaseResult,
} from "@papercusp/operator-core/lib/workspace-host/gcp-image-family";

export interface GcpImageFamilyReleaseCliInput {
  request: GcpImageFamilyReleaseRequest;
  connection: WorkspaceHostProviderConnection;
}

export interface GcpImageFamilyReleaseCliDeps {
  readFile?: (path: string) => Promise<string>;
  execute?: typeof executeConfiguredGcpImageFamilyRelease;
}

export interface GcpImageFamilyReleaseCliArgs {
  requestFile: string;
  repositoryRoot?: string;
  guestToolVersionsFile?: string;
  json: boolean;
}

type ArgValue = string | boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

/** Parse CLI flags strictly; unknown flags are errors rather than silently ignored. */
export function parseGcpImageFamilyReleaseCliArgs(
  argv: readonly string[],
): GcpImageFamilyReleaseCliArgs {
  const values: Record<string, ArgValue> = {};
  const valueFlags = new Set([
    "request-file",
    "repo-root",
    "guest-tool-versions-file",
  ]);
  const booleanFlags = new Set(["json"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--"))
      throw new Error(`unexpected argument '${flag ?? ""}'`);
    const key = flag.slice(2);
    if (valueFlags.has(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`--${key} requires a value`);
      values[key] = value;
      index += 1;
    } else if (booleanFlags.has(key)) {
      if (values[key] !== undefined)
        throw new Error(`--${key} may be supplied only once`);
      values[key] = true;
    } else {
      throw new Error(`unknown argument '--${key}'`);
    }
  }
  return {
    requestFile: requiredString(values["request-file"], "--request-file"),
    ...(typeof values["repo-root"] === "string"
      ? { repositoryRoot: values["repo-root"] }
      : {}),
    ...(typeof values["guest-tool-versions-file"] === "string"
      ? { guestToolVersionsFile: values["guest-tool-versions-file"] }
      : {}),
    json: values.json === true,
  };
}

/** Validate only the envelope here; the release executor remains the authority for deep fields. */
export function parseGcpImageFamilyReleaseCliInput(
  raw: unknown,
): GcpImageFamilyReleaseCliInput {
  if (!isRecord(raw) || !isRecord(raw.request) || !isRecord(raw.connection)) {
    throw new Error(
      "request file must contain object fields request and connection",
    );
  }
  return {
    request: raw.request as unknown as GcpImageFamilyReleaseRequest,
    connection: raw.connection as unknown as WorkspaceHostProviderConnection,
  };
}

function parseGuestToolVersions(
  raw: unknown,
): Readonly<Record<string, string>> {
  if (!isRecord(raw))
    throw new Error("guest tool versions file must contain a JSON object");
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw)) {
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(
        `guest tool version for ${name} must be a non-empty string`,
      );
    }
    versions[name] = version.trim();
  }
  return versions;
}

async function readJson(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<unknown> {
  let text: string;
  try {
    text = await read(path);
  } catch {
    throw new Error(`cannot read JSON input '${path}'`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`JSON input '${path}' is not valid JSON`);
  }
}

/** Execute one already-parsed request through the production composition seam. */
export async function runGcpImageFamilyReleaseCli(
  input: GcpImageFamilyReleaseCliInput,
  options: GcpImageFamilyReleaseCompositionOptions = {},
  deps: Pick<GcpImageFamilyReleaseCliDeps, "execute"> = {},
): Promise<GcpImageFamilyReleaseResult> {
  return (deps.execute ?? executeConfiguredGcpImageFamilyRelease)(
    input.request,
    input.connection,
    options,
  );
}

function envOptions(
  args: GcpImageFamilyReleaseCliArgs,
  guestToolVersions?: Readonly<Record<string, string>>,
) {
  const env = process.env;
  return {
    ...(args.repositoryRoot ? { repositoryRoot: args.repositoryRoot } : {}),
    ...(guestToolVersions ? { guestToolVersions } : {}),
    ...(env.PAPERCUSP_GCP_PACKER_EXECUTABLE
      ? { packerExecutable: env.PAPERCUSP_GCP_PACKER_EXECUTABLE }
      : {}),
    ...(env.PAPERCUSP_GCP_SCAN_EXECUTABLE
      ? { scanExecutable: env.PAPERCUSP_GCP_SCAN_EXECUTABLE }
      : {}),
    ...(env.PAPERCUSP_GCP_CLEAN_ROOM_EXECUTABLE
      ? { cleanRoomExecutable: env.PAPERCUSP_GCP_CLEAN_ROOM_EXECUTABLE }
      : {}),
  } satisfies GcpImageFamilyReleaseCompositionOptions;
}

async function main(): Promise<void> {
  const args = parseGcpImageFamilyReleaseCliArgs(process.argv.slice(2));
  const read = (path: string) => readFile(path, "utf8");
  const input = parseGcpImageFamilyReleaseCliInput(
    await readJson(args.requestFile, read),
  );
  const guestToolVersions = args.guestToolVersionsFile
    ? parseGuestToolVersions(await readJson(args.guestToolVersionsFile, read))
    : undefined;
  const options = envOptions(args, guestToolVersions);

  // Auth is always reconstructed from the persisted connection reference by the composition seam.
  const credential = await probeGcpImageFamilyCredential(input.connection);
  const executables = await probeGcpImageFamilyExecutables(options);
  if (!credential.ok || !executables.ok) {
    const report = {
      ok: false,
      stage: "prerequisite" as const,
      credential: {
        ok: credential.ok,
        projectId: credential.projectId,
        credentialRef: credential.credentialRef,
        ...(credential.identity ? { identity: credential.identity } : {}),
        ...(credential.resolvedProjectId
          ? { resolvedProjectId: credential.resolvedProjectId }
          : {}),
        ...(credential.error ? { error: credential.error } : {}),
      },
      executables,
    };
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const result = await runGcpImageFamilyReleaseCli(input, options);
  const output = {
    ok: true,
    projectId: credential.projectId,
    credentialRef: credential.credentialRef,
    result,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
