import { afterEach, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSeedKey,
  sealBytes,
  openBytes,
  sealFile,
  openFile,
  keysEqual,
  SeedCryptoError,
  SEED_KEY_LEN,
} from "./index";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length)
    rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-crypto-"));
  cleanups.push(dir);
  return dir;
}

describe("seed crypto", () => {
  it("round-trips sealed bytes", () => {
    const key = generateSeedKey();
    const pt = Buffer.from("the private repo bundle bytes");
    const sealed = sealBytes(key, pt);
    expect(sealed.length).toBeGreaterThan(pt.length); // nonce + tag overhead
    expect(openBytes(key, sealed).equals(pt)).toBe(true);
  });

  it("generateSeedKey is 32 bytes", () => {
    expect(generateSeedKey().length).toBe(SEED_KEY_LEN);
  });

  it("two seals of the same plaintext differ (random nonce)", () => {
    const key = generateSeedKey();
    const pt = Buffer.from("same");
    expect(sealBytes(key, pt).equals(sealBytes(key, pt))).toBe(false);
  });

  it("rejects a wrong key", () => {
    const sealed = sealBytes(generateSeedKey(), Buffer.from("x"));
    expect(() => openBytes(generateSeedKey(), sealed)).toThrow(SeedCryptoError);
  });

  it("rejects a tampered blob", () => {
    const key = generateSeedKey();
    const sealed = sealBytes(key, Buffer.from("hello world"));
    sealed[sealed.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => openBytes(key, sealed)).toThrow(/wrong key or tampered/);
  });

  it("rejects a too-short blob", () => {
    expect(() => openBytes(generateSeedKey(), Buffer.from([1, 2, 3]))).toThrow(
      /too short/,
    );
  });

  it("rejects a wrong-length key", () => {
    expect(() => sealBytes(Buffer.from([1, 2, 3]), Buffer.from("x"))).toThrow(
      /must be 32 bytes/,
    );
  });

  it("streams files across multiple chunks with the existing byte envelope in both directions", async () => {
    const dir = tempDir();
    const key = generateSeedKey();
    const plaintext = Buffer.alloc(9 * 1024 * 1024 + 37);
    for (let offset = 0; offset < plaintext.length; offset += 1)
      plaintext[offset] = offset % 251;
    const source = join(dir, "source.bin");
    const sealed = join(dir, "sealed.bin");
    const opened = join(dir, "opened.bin");
    writeFileSync(source, plaintext);

    await sealFile(key, source, sealed);
    expect(openBytes(key, readFileSync(sealed)).equals(plaintext)).toBe(true);
    await openFile(key, sealed, opened);
    expect(readFileSync(opened).equals(plaintext)).toBe(true);

    const legacySealed = join(dir, "legacy-sealed.bin");
    const legacyOpened = join(dir, "legacy-opened.bin");
    writeFileSync(
      legacySealed,
      sealBytes(key, Buffer.from("existing envelope")),
    );
    await openFile(key, legacySealed, legacyOpened);
    expect(readFileSync(legacyOpened, "utf8")).toBe("existing envelope");
  });

  it("does not publish unauthenticated plaintext or leave a partial file after corruption", async () => {
    const dir = tempDir();
    const key = generateSeedKey();
    const source = join(dir, "source.bin");
    const sealed = join(dir, "sealed.bin");
    const destination = join(dir, "destination.bin");
    writeFileSync(source, Buffer.alloc(9 * 1024 * 1024 + 17, 0x5a));
    await sealFile(key, source, sealed);
    const tampered = readFileSync(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(sealed, tampered);
    writeFileSync(destination, "previous authenticated value");

    await expect(openFile(key, sealed, destination)).rejects.toThrow(
      /wrong key or tampered/,
    );
    expect(readFileSync(destination, "utf8")).toBe(
      "previous authenticated value",
    );
    expect(
      readdirSync(dir).filter((name) =>
        name.startsWith(".destination.bin.partial-"),
      ),
    ).toEqual([]);
  });

  it("keysEqual compares keys", () => {
    const k = generateSeedKey();
    expect(keysEqual(k, Buffer.from(k))).toBe(true);
    expect(keysEqual(k, generateSeedKey())).toBe(false);
  });
});