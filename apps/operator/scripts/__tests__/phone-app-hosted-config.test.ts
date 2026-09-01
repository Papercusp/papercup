import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const deployPath = resolve(repoRoot, "infra/phone-app/deploy.sh");

describe("Phone hosted media deployment contract", () => {
  it("keeps the deploy script syntactically valid", () => {
    const result = spawnSync("bash", ["-n", deployPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("persists a separate public URL and refuses insecure hosted signalling", () => {
    const source = readFileSync(deployPath, "utf8");
    expect(source).toContain("--hosted");
    expect(source).toContain('upsert_env_var "PHONE_LIVEKIT_URL"');
    expect(source).toContain('upsert_env_var "PHONE_LIVEKIT_PUBLIC_URL"');
    expect(source).toContain("hosted deployment requires PHONE_LIVEKIT_PUBLIC_URL=wss://...");
    expect(source).not.toContain("PHONE_LIVEKIT_API_SECRET=%s\\nPHONE_LIVEKIT_URL=ws://127.0.0.1:7890");
  });
});
