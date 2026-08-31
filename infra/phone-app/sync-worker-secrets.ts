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
import { readIntegrationKey } from "../../packages/operator-core/lib/integration-credentials.ts";

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

  // ── Deepgram: the vendor the worker ACTUALLY ships, on BOTH legs.
  //
  // D-011 pinned STT to Deepgram nova-3; D-015 pinned TTS to Deepgram Aura
  // (ttsTtfb 652ms -> 180ms, which is what put speech-to-speech under the
  // 1500ms target). So this is the one key a supervised worker cannot start
  // correctly without — and until now it reached the worker ONLY through
  // `capability:bash { integration_env }`, i.e. only when an agent hand-launched
  // it. A systemd unit has no such door, so it would have resolved stt=gemini
  // and tts=gemini SILENTLY, which is precisely the class that cost four
  // measurement runs. PHONE_REQUIRE_VENDORS makes that loud; this makes it not
  // happen.
  //
  // Read from the SAME encrypted store integration_env reads
  // (harness_shared.operator_integration_credentials), so there is still exactly
  // one copy of the secret — the rule this whole file exists to honour.
  const deepgramKey = (await readIntegrationKey("SIDESTAGE_DEEPGRAM_API_KEY"))?.trim();
  if (deepgramKey) {
    const dgResult = upsertEnvLine(ENV_FILE, "DEEPGRAM_API_KEY", deepgramKey);
    console.log(
      `[phone-secrets] DEEPGRAM_API_KEY ${dgResult} in ${ENV_FILE} (${maskKey(deepgramKey)}) — ` +
        `sourced from the encrypted integration-credential store, not a second copy.`,
    );
  } else {
    console.error(
      "[phone-secrets] ⚠ no SIDESTAGE_DEEPGRAM_API_KEY in the integration-credential store.\n" +
        "The worker ships Deepgram for BOTH STT (nova-3, D-011) and TTS (Aura, D-015).\n" +
        "Without it a supervised worker resolves gemini on both legs and misses the latency\n" +
        "target — and PHONE_REQUIRE_VENDORS in the unit will refuse to start rather than let\n" +
        "it run as something other than what was measured.",
    );
    process.exitCode = 1;
  }

  // ── ElevenLabs: kept in sync, but NOT fatal, and deliberately last.
  //
  // D-007 established that the stored ElevenLabs credential is not a usable
  // `sk_` key, so the shipping TTS is Deepgram Aura. Syncing the key still
  // matters — the elevenlabs arm remains in the seam and P-004's item text names
  // it — but its ABSENCE must not abort this script. It used to `return` here,
  // which after the Deepgram leg above would have meant a wall on a vendor we do
  // NOT ship silently skipping the vendor we DO.
  const key = await readElevenLabsKey();
  if (key) {
    const result = upsertEnvLine(ENV_FILE, "ELEVEN_API_KEY", key);
    console.log(
      `[phone-secrets] ELEVEN_API_KEY ${result} in ${ENV_FILE} (${maskKey(key)}) — ` +
        `sourced from the operator voice-credential store, not a second copy.`,
    );
  } else {
    console.log(
      "[phone-secrets] no usable ElevenLabs key — EXPECTED, see D-007. TTS ships Deepgram Aura; " +
        "the elevenlabs arm stays in the seam for when a real sk_ key exists.",
    );
  }
}

// Not top-level await: the repo's tsx transform emits CJS, which rejects it.
void main().catch((err: unknown) => {
  console.error("[phone-secrets] failed:", err);
  process.exitCode = 1;
});
