/**
 * Boot the hosted Portal without placing integration secrets in systemd or a
 * plaintext checkout file. The hosted env file contains only literals and
 * `integration:NAME` references; each reference is resolved in this process,
 * then exposed to the standalone child through an ephemeral env slot using the
 * generic `env:NAME` resolver already bundled by the Portal.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type HostedSecretRefResolver = (reference: string) => Promise<string>;

const INTEGRATION_PREFIX = "integration:";
const SAFE_OPERATOR_ENV = [
  "HARNESS_ADMIN_DATABASE_URL",
  "PAPERCUSP_WORKSPACE",
  "PAPERCUSP_INTEGRATION_ROOT",
] as const;

/** Parse the small dotenv subset used by the checked-in deployment env files. */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const name = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    let value = assignment.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[name] = value;
  }
  return result;
}

/**
 * Replace encrypted-store references with env references understood by the
 * Portal's prebundled hosted-auth runtime. The returned object contains the
 * secret slots as well as the rewritten config names; values are never logged.
 */
export async function resolveIntegrationReferences(
  source: Record<string, string>,
  resolve: HostedSecretRefResolver,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = { ...source };
  for (const [name, reference] of Object.entries(source)) {
    if (!reference.startsWith(INTEGRATION_PREFIX)) continue;
    const integrationName = reference.slice(INTEGRATION_PREFIX.length).trim();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(integrationName)) {
      throw new Error(`portal_hosted_secret_ref_malformed:${reference}`);
    }
    const slot = `PAPERCUSP_CLOUD_PORTAL_SECRET_${integrationName}`;
    const value = await resolve(reference);
    if (!value.trim()) throw new Error(`portal_hosted_secret_ref_empty:${reference}`);
    resolved[slot] = value.trim();
    resolved[name] = `env:${slot}`;
  }
  return resolved;
}

function readOptional(path: string | undefined): Record<string, string> {
  if (!path) return {};
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const portalRoot = process.env.PAPERCUSP_PORTAL_ROOT?.trim();
  const startWeb = process.env.PAPERCUSP_PORTAL_START_WEB?.trim();
  const hostedEnvFile = process.env.PAPERCUSP_PORTAL_HOSTED_ENV_FILE?.trim();
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (!portalRoot || !startWeb || !hostedEnvFile || !integrationRoot) {
    throw new Error("portal_hosted_launcher_configuration_missing");
  }

  const hosted = parseEnvFile(readFileSync(hostedEnvFile, "utf8"));
  const operatorFile = readOptional(process.env.PAPERCUSP_PORTAL_OPERATOR_ENV_FILE?.trim());
  // The launcher is copied to ~/.local/bin, outside the repo's tsconfig path
  // map. Load the canonical resolver by absolute URL so a service restart does
  // not depend on the current working directory or a symlinked node_modules.
  const resolverModule = await import(
    pathToFileURL(join(integrationRoot, "packages/operator-core/lib/auth/hosted/secret-ref.ts")).href,
  ) as { resolveHostedSecretRef: HostedSecretRefResolver };
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...hosted };
  for (const name of SAFE_OPERATOR_ENV) {
    if (operatorFile[name]) childEnv[name] = operatorFile[name];
  }
  // The encrypted store reader uses the admin URL. Keep DATABASE_URL out of
  // the child so the Portal's own store remains its persistent/embedded store,
  // while the operator-state reader still has its database connection.
  childEnv.HARNESS_ADMIN_DATABASE_URL =
    process.env.HARNESS_ADMIN_DATABASE_URL
    ?? operatorFile.HARNESS_ADMIN_DATABASE_URL
    ?? operatorFile.DATABASE_URL;
  childEnv.PAPERCUSP_INTEGRATION_ROOT = integrationRoot;
  childEnv.PORTAL_LOCAL_MODE = "0";
  childEnv.PORTAL_USE_MEMORY_STORE = "0";
  childEnv.HOSTNAME = childEnv.HOSTNAME || "127.0.0.1";

  const rewritten = await resolveIntegrationReferences(hosted, resolverModule.resolveHostedSecretRef);
  Object.assign(childEnv, rewritten);

  const child = spawn(process.execPath, [startWeb], {
    cwd: portalRoot,
    env: childEnv,
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = exit.signal ? 1 : (exit.code ?? 1);
}

if (process.argv[1]?.endsWith("portal-hosted-launcher.ts") || process.argv[1]?.endsWith("cloud-portal-launcher.ts")) {
  main().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "unknown";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
