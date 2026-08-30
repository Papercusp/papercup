/**
 * Is the stored ElevenLabs credential USABLE — not merely present?
 *
 * P-004 needs a TTS leg to exist before speech-to-speech latency can be
 * measured at all. Plan decision D-005 rests its vendor availability finding on
 * `operator:credentials_status` reporting elevenlabs "SET". That field is
 * `configured`, not `healthy` — a distinction the store itself draws, since
 * `readElevenLabsKey()` returns null for a configured-but-invalid value.
 *
 * So this probe answers the question the status field cannot: would an outbound
 * call authenticate? It prints a verdict and a masked prefix; the secret itself
 * never reaches stdout.
 *
 *   npx tsx infra/phone-app/probe-elevenlabs.ts
 */
import {
  inspectElevenLabsApiKey,
  maskKey,
  readElevenLabsKey,
} from "../../packages/operator-core/lib/voice-credentials.ts";

async function main(): Promise<void> {
  // allowInvalid:true is the status/migration door — it is what lets us SEE a
  // value the safe default deliberately hides from call sites.
  const raw = await readElevenLabsKey({ allowInvalid: true });
  const safe = await readElevenLabsKey();

  if (!raw) {
    console.log("[el-probe] stored: ABSENT — nothing configured at all.");
    return;
  }

  const status = inspectElevenLabsApiKey(raw);
  console.log(
    `[el-probe] stored: ${maskKey(raw)} len=${raw.length} ` +
      `startsWithSk=${raw.startsWith("sk_")} ` +
      `configured=${status.configured} healthy=${status.healthy} ` +
      `error=${status.error ?? "none"}`,
  );
  console.log(`[el-probe] readElevenLabsKey() (the call-site door) returns: ${safe ? "a key" : "NULL"}`);

  // The decisive check: static validation is our opinion; the vendor's 401 is
  // the fact. Ask ElevenLabs directly, with a short timeout.
  const ctl = AbortSignal.timeout(15_000);
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": raw },
      signal: ctl,
    });
    const body = await res.text();
    console.log(
      `[el-probe] LIVE /v1/user -> HTTP ${res.status} ${res.statusText}; ` +
        `body(first 200): ${body.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  } catch (err) {
    console.log(`[el-probe] LIVE /v1/user -> request failed: ${String(err)}`);
  }
}

void main().catch((err: unknown) => {
  console.error("[el-probe] failed:", err);
  process.exitCode = 1;
});
