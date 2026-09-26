/** EI-24186802110515838: an IPC message from a file page must not abort WRY. */
import { browser, expect } from "@wdio/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Packaged WRY IPC with an unrepresentable page URI", () => {
  it("keeps the native WebView alive after IPC from a file page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "papercusp-wry-invalid-uri-"));
    try {
      const page = join(dir, "page.html");
      writeFileSync(page, "<!doctype html><title>WRY invalid URI regression</title>");
      await browser.url(pathToFileURL(page).href);
      expect(await browser.getTitle()).toBe("WRY invalid URI regression");

      const sent = await browser.execute(() => {
        const ipc = (window as unknown as {
          ipc?: { postMessage?: (value: string) => void };
        }).ipc;
        if (typeof ipc?.postMessage !== "function") return false;
        ipc.postMessage("invalid-uri-regression");
        return true;
      });
      expect(sent).toBe(true);
      await browser.pause(500);
      expect(await browser.getTitle()).toBe("WRY invalid URI regression");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
