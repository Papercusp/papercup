import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicAddress, publicHostname, publicMediaUrl, publicAddresses } from "../../../../infra/phone-app/media-config.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const deployPath = resolve(repoRoot, "infra/phone-app/deploy.sh");

describe("Phone hosted media deployment contract", () => {
  it("keeps the deploy script syntactically valid", () => {
    const result = spawnSync("bash", ["-n", deployPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps public and internal coordinates separate", () => {
    const source = readFileSync(deployPath, "utf8");
    expect(source).toContain("--hosted");
    expect(source).toContain('upsert_env_var "PHONE_LIVEKIT_URL"');
    expect(source).toContain('upsert_env_var "PHONE_LIVEKIT_PUBLIC_URL"');
    expect(source).toContain("media-config.mjs");
    expect(source).not.toContain("PHONE_LIVEKIT_API_SECRET=%s\\nPHONE_LIVEKIT_URL=ws://127.0.0.1:7890");
  });

  it.each([
    "ws://voice.example.com", "wss://localhost", "wss://127.1", "wss://10.0.0.1",
    "wss://[::1]", "wss://voice.local", "wss://voice.internal", "wss://voice.example.com:7890",
    "wss://user:pass@voice.example.com", "wss://voice.example.com/path", "wss://voice.example.com?key=secret",
    "wss://voice.example.com#token", "wss://voice.exa\nmple.com", "wss://voice.example.com.",
  ])("refuses unsafe browser origin %s", value => {
    expect(() => publicMediaUrl(value)).toThrow();
  });

  it("accepts a secure public DNS origin", () => {
    expect(publicMediaUrl("wss://voice.example.com").hostname).toBe("voice.example.com");
    expect(publicHostname("TURN.EXAMPLE.COM")).toBe("turn.example.com");
  });

  it.each(["127.0.0.1", "10.20.30.40", "172.31.0.1", "192.168.1.1", "100.64.0.1",
    "169.254.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1", "not-an-ip"])
  ("rejects non-global DNS answer %s", address => expect(isPublicAddress(address)).toBe(false));

  it("accepts global v4 and v6", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects mixed public/private DNS and empty answers", async () => {
    await expect(publicAddresses("voice.example.com", async () => [
      { address: "8.8.8.8" }, { address: "10.0.0.1" },
    ])).rejects.toThrow("exclusively");
    await expect(publicAddresses("voice.example.com", async () => [])).rejects.toThrow("exclusively");
    await expect(publicAddresses("voice.example.com", async () => [
      { address: "8.8.8.8" }, { address: "8.8.8.8" },
    ])).resolves.toEqual(["8.8.8.8"]);
  });
});
