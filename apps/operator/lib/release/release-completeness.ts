/**
 * release-completeness.ts — the PURE, dependency-free source of truth for what a
 * COMPLETE desktop release must carry: every desktop PRODUCT on every desktop
 * PLATFORM (WI-5515 / owner directive 2026-07-19).
 *
 * Extracted from record-release-cli.ts (which re-exports these for back-compat) so
 * a lightweight PRE-FLIGHT gate can reuse the matrix WITHOUT importing the record
 * CLI's fs/os/postgres surface. The record path classifies POST-build artifacts
 * against this matrix; the preflight (preflight-build-set.ts) asserts the intended
 * build's ROLE SET against the same PRODUCTS before any build starts.
 */

/** The desktop platforms a complete release is expected to cover. */
export const REQUIRED_DESKTOP_PLATFORMS = [
  'linux-x86_64',
  'darwin-universal',
  'windows-x86_64',
] as const;

/**
 * The desktop products a complete release is expected to carry on each platform.
 * `server` IS required: the old check covered only `gui`, so a version that
 * shipped a linux Server but no mac/windows Server passed as "complete" silently.
 * On mac/win the GUI does not self-host — it attaches to a separately-installed
 * Papercusp Server (launch_bundle(com.papercusp.server)), so a GUI shipped without
 * a Server to attach to is dead on arrival.
 */
export const REQUIRED_DESKTOP_PRODUCTS = ['gui', 'server'] as const;

export type RequiredDesktopProduct = (typeof REQUIRED_DESKTOP_PRODUCTS)[number];
export type RequiredDesktopPlatform = (typeof REQUIRED_DESKTOP_PLATFORMS)[number];

export interface MissingArtifactSlot {
  product: RequiredDesktopProduct;
  platform: RequiredDesktopPlatform;
}

/**
 * Which (product × platform) desktop slots a set of classified artifacts does NOT
 * cover. PURE (takes just { product, platform } shapes) so it is trivially
 * unit-testable and reusable by the page renderer and the record path. Mobile
 * artifacts are ignored — never required.
 */
export function computeReleaseCompleteness(
  artifacts: { product: string; platform: string }[],
): { missing: MissingArtifactSlot[]; complete: boolean } {
  const have = new Set(artifacts.map((a) => `${a.product}:${a.platform}`));
  const missing: MissingArtifactSlot[] = [];
  for (const product of REQUIRED_DESKTOP_PRODUCTS) {
    for (const platform of REQUIRED_DESKTOP_PLATFORMS) {
      if (!have.has(`${product}:${platform}`)) missing.push({ product, platform });
    }
  }
  return { missing, complete: missing.length === 0 };
}
