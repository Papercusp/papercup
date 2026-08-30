/**
 * Bind the phone worker to our EXISTING voice credentials — plan
 * `phone-app-2026-08-30`, P-004 ("ElevenLabs TTS plugin reusing our existing
 * voice infra").
 *
 * "Reusing our existing voice infra" is a real constraint, not a phrasing. The
 * operator already holds an ElevenLabs key in the encrypted
 * `operator_voice_credentials` store, and it is the key the rest of the suite
 * speaks with. The wrong way to satisfy P-004 is to have a human paste a SECOND
 * copy into a file for the worker: two copies drift, only one gets rotated, and
 * the day the operator's key is replaced the phone silently keeps using a
 * revoked one. So the worker's key is DERIVED from the operator's, here, and
 * this script is re-runnable whenever the operator's key changes.
 *
 * WHERE IT LANDS, and why not the repo. `deploy.sh` already established the
 * pattern for this app: rendered secrets live in ~/.config/papercusp-phone/ at
 * mode 0600, outside every repo, and the worker's config.ts already reads that
 * exact file as its fallback after process.env. This appends to the same file
 * under the same rules rather than inventing a second location.
 *
 * THE SECRET IS NEVER PRINTED. The only thing this writes to stdout is a masked
 * confirmation, because the output of a script like this ends up in a terminal
 * scrollback, an agent transcript, and a systemd journal.
 *
 *   npx tsx infra/phone-app/sync-worker-secrets.ts
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  maskKey,
  readElevenLabsKey,
} from "../../packages/operator-core/lib/voice-credentials.ts";

const ENV_FILE = join(homedir(), ".config", "papercusp-phone", "livekit.env");

/**
 * Upsert one KEY=VALUE line, preserving every other line.
 *
 * Rewriting the whole file from a known set would silently drop whatever
 * `deploy.sh` put there (the LiveKit key/secret/URL) — so this edits in place
 * and leaves unrecognised lines exactly as found.
 */
function upsertEnvLine(path: string, key: string, value: string): "added" | "updated" | "unchanged" {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = before.length > 0 ? before.split("\n") : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  const line = `${key}=${value}`;

  if (idx >= 0) {
    if (lines[idx] === line) return "unchanged";
    lines[idx] = line;
  } else {
    // Keep a trailing newline rather than gluing onto the last line.
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") lines.push(line);
    else lines[Math.max(lines.length - 1, 0)] = line;
    lines.push("");
  }

  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  chmodSync(path, 0o600); // explicit: writeFileSync's mode only applies on CREATE
  return idx >= 0 ? "updated" : "added";
}

/**
 * Resolve the Vertex project WITHOUT copying an env var.
 *
 * The worker needs GOOGLE_CLOUD_PROJECT for both Gemini STT and Gemini TTS, and
 * it is not optional: `new google.beta.TTS({ vertexai: true })` throws
 * "Project ID is required for Vertex AI" without it. Until now it only ever
 * worked because an interactive shell happened to export it — so the worker ran
 * for a human and failed for anything confined (a systemd unit, a supervised
 * pot, a sandboxed job), which is every way it will actually be launched.
 *
 * The service-account JSON already names its own project, so that is the source
 * of truth here rather than whatever a shell happens to hold. One less value a
 * human has to keep in sync, and it cannot disagree with the credential it
 * belongs to.
 */
function projectFromServiceAccount(credentialsPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as { project_id?: unknown };
    return typeof parsed.project_id === "string" && parsed.project_id ? parsed.project_id : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!existsSync(ENV_FILE)) {
    console.error(
      `[phone-secrets] ${ENV_FILE} does not exist.\n` +
        `Run infra/phone-app/deploy.sh first — it mints the LiveKit credentials this file holds.`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Vertex settings: config, not secrets, but the worker cannot start
  // without them and must not depend on an interactive shell to supply them.
  const credentialsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    join(homedir(), ".config", "gcloud", "vertex-sa.json");
  if (existsSync(credentialsPath)) {
    const credResult = upsertEnvLine(ENV_FILE, "GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
    const project = projectFromServiceAccount(credentialsPath);
    if (project) {
      const projResult = upsertEnvLine(ENV_FILE, "GOOGLE_CLOUD_PROJECT", project);
      console.log(
        `[phone-secrets] GOOGLE_CLOUD_PROJECT ${projResult} (${project}) — read from the ` +
          `service account's own project_id, not from a shell env var.`,
      );
    } else {
      console.error(
        `[phone-secrets] ⚠ ${credentialsPath} has no project_id. Gemini STT and TTS both ` +
          `require a Vertex project and will throw at worker start.`,
      );
      process.exitCode = 1;
    }
    console.log(`[phone-secrets] GOOGLE_APPLICATION_CREDENTIALS ${credResult} (${credentialsPath})`);
  } else {
    console.error(
      `[phone-secrets] ⚠ no Vertex service account at ${credentialsPath}. ` +
        `Gemini STT (and Gemini TTS, if ElevenLabs is unavailable) cannot authenticate.`,
    );
    process.exitCode = 1;
  }

  const key = await readElevenLabsKey();
  if (!key) {
    // A missing key is a real, actionable state — not an error to swallow. The
    // worker will still start; it just cannot speak, which is worth saying now
    // rather than discovering on the first call.
    console.error(
      "[phone-secrets] no ElevenLabs key in the operator voice-credential store.\n" +
        "Save one via the operator settings UI (or setup:save_key), then re-run this.",
    );
    process.exitCode = 1;
    return;
  }

  const result = upsertEnvLine(ENV_FILE, "ELEVEN_API_KEY", key);
  console.log(
    `[phone-secrets] ELEVEN_API_KEY ${result} in ${ENV_FILE} (${maskKey(key)}) — ` +
      `sourced from the operator voice-credential store, not a second copy.`,
  );
}

// Not top-level await: the repo's tsx transform emits CJS, which rejects it.
void main().catch((err: unknown) => {
  console.error("[phone-secrets] failed:", err);
  process.exitCode = 1;
});
