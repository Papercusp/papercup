// SPDX-License-Identifier: GPL-3.0-or-later
// Style Dictionary v4 config for papercup (desktop + harness).
//
// Emits two CSS files imported by apps/operator/app/globals.css:
//   _brand-primitives.css  — workspace brand palette as CSS variables (--sky-400 etc.)
//   _semantic.css          — desktop's semantic + ink layer as CSS variables (--bg, --accent etc.)
//
// Tooling (transforms + preflight) comes from @papercusp/token-kit — generic,
// brand-value-free, shared with Restart's @restart/design-tokens. Only the
// papercup-specific *.tokens.json values + the platform wiring below live here.
//
// Mobile mirrors primitives.tokens.json (see Phase 4); each platform's
// semantic/component layers stay local.

import { globSync } from "node:fs";
import StyleDictionary from "style-dictionary";
import { transforms, preflight } from "@papercusp/token-kit";

preflight(globSync("design-tokens/*.tokens.json"));

for (const t of transforms) StyleDictionary.registerTransform(t);

// Filter: primitives layer only (anything under `color.*`).
const isPrimitive = (t) => t.path[0] === "color";

// Filter: semantic layer — top-level non-color, non-meta keys. Includes
// motion tokens (ease/dur), elevation (card-shadow), and overlays (frost),
// which share the desktop CSS-var namespace.
const isSemantic = (t) => t.path[0] !== "color" && !t.path[0].startsWith("_");

const sharedTransforms = ["attribute/cti", "tokenkit/srgb", "tokenkit/name"];

export default {
  source: ["design-tokens/*.tokens.json"],
  platforms: {
    "css-primitives": {
      transforms: sharedTransforms,
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
      transforms: sharedTransforms,
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
