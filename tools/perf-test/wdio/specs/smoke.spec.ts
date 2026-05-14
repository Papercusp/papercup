/**
 * Smoke spec: confirms the packaged Tauri binary boots and the operator UI loads.
 * Captures INP via web-vitals injected at runtime; logs to console for now.
 *
 * Run after a successful `tauri build`. See ../wdio.conf.ts for prereqs.
 */
import { browser } from "@wdio/globals";

describe("Packaged Papercusp desktop binary", () => {
  it("loads the operator UI and reports web-vitals", async () => {
    // Wait for the Next.js app inside the webview to render the root layout.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector("[data-app-root]")
        ),
      { timeout: 30_000, timeoutMsg: "operator UI did not mount in 30s" }
    );

    // Inject web-vitals from CDN and collect INP/LCP/CLS for 10s while we click around.
    const metrics = await browser.execute(async () => {
      const script = document.createElement("script");
      script.type = "module";
      script.textContent = `
        import {onINP, onLCP, onCLS} from "https://esm.sh/web-vitals@4";
        window.__wv = {};
        onINP(m => window.__wv.INP = m.value);
        onLCP(m => window.__wv.LCP = m.value);
        onCLS(m => window.__wv.CLS = m.value);
      `;
      document.head.appendChild(script);
      await new Promise((r) => setTimeout(r, 10_000));
      return (window as unknown as { __wv: Record<string, number> }).__wv;
    });

    console.log("web-vitals:", metrics);
    expect(metrics).toBeDefined();
  });
});
