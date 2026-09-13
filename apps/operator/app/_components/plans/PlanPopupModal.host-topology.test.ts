import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRelative = (path: string) =>
  readFileSync(resolve(import.meta.dirname, path), "utf8");

describe("PlanPopupModal shared host topology", () => {
  it("keeps both the desktop sidebar and cloud /plans route joined to the shared popup mount", () => {
    const desktopSidebar = readRelative("../OperatorChatSidebar.tsx");
    const cloudPlansRoute = readRelative(
      "../../../../../apps/operator-vite/src/components/route-content/PlansEmbedRoute.tsx",
    );
    const sharedPlansPane = readRelative("./PlansPane.tsx");

    expect(desktopSidebar).toMatch(
      /lazy\(\(\) => import\(['"]\.\/plans\/PlansPane['"]\)\)/,
    );
    expect(cloudPlansRoute).toMatch(
      /import PlansPane from ['"]@\/app\/_components\/plans\/PlansPane['"]/,
    );
    expect(cloudPlansRoute).toMatch(/<PlansPane layout=["']split["'] \/>/);
    expect(sharedPlansPane).toMatch(
      /import PlanPopupModal from ["']\.\/PlanPopupModal["']/,
    );
    expect(sharedPlansPane).toMatch(/<PlanPopupModal\b/);
  });
});
