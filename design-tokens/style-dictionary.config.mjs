// SPDX-License-Identifier: GPL-3.0-or-later
// Style Dictionary v4 config for papercup (desktop + harness).
//
// Emits two CSS files imported by apps/operator/app/globals.css:
//   _brand-primitives.css  — workspace brand palette as CSS variables (--sky-400 etc.)
//   _semantic.css          — desktop's semantic + ink layer as CSS variables (--bg, --accent etc.)
//
// Mobile mirrors primitives.tokens.json (see Phase 4); each platform's
// semantic/component layers stay local.

import { globSync } from "node:fs";
import StyleDictionary from "style-dictionary";
import { preflight } from "./_preflight.mjs";

preflight(globSync("design-tokens/*.tokens.json"));

// Hex normalizer: emit CSS hex with shortest form (3/6/8 digits preserved).
StyleDictionary.registerTransform({
  name: "color/cssHex",
  type: "value",
  filter: (t) => t.$type === "color",
  transform: (t) => {
    const raw = String(t.$value).trim();
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(raw);
    if (!m) {
      // Allow rgba()/named/other — pass through unchanged.
      return raw;
    }
    return `#${m[1].toLowerCase()}`;
  },
});

// Skip leaf "color." prefix in var names. color.sky.400 → --sky-400.
// Names without a "color." prefix pass through as-is (--bg, --accent).
StyleDictionary.registerTransform({
  name: "name/cssKebabNoColor",
  type: "name",
  transform: (t) => {
    const parts = t.path[0] === "color" ? t.path.slice(1) : t.path;
    return parts.join("-").toLowerCase();
  },
});

// Filter: primitives layer only (anything under `color.*`).
const isPrimitive = (t) => t.path[0] === "color";

// Filter: semantic layer — top-level non-color, non-meta keys. Includes
// motion tokens (ease/dur), elevation (card-shadow), and overlays (frost),
// which share the desktop CSS-var namespace.
const isSemantic = (t) => t.path[0] !== "color" && !t.path[0].startsWith("_");

export default {
  source: ["design-tokens/*.tokens.json"],
  platforms: {
    "css-primitives": {
      transforms: ["attribute/cti", "color/cssHex", "name/cssKebabNoColor"],
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_brand-primitives.css",
          format: "css/variables",
          options: { outputReferences: false, selector: ":root" },
          filter: isPrimitive,
        },
      ],
    },
    "css-semantic": {
      transforms: ["attribute/cti", "color/cssHex", "name/cssKebabNoColor"],
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_semantic.css",
          format: "css/variables",
          options: { outputReferences: true, selector: ":root" },
          filter: isSemantic,
        },
      ],
    },
  },
  log: {
    verbosity: "default",
    warnings: "warn",
    errors: { brokenReferences: "throw" },
  },
};
