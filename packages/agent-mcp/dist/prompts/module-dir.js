"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.moduleDir = moduleDir;
/**
 * Directory of the calling module, across the runtimes this package actually
 * runs under. `import.meta.dirname` exists in real ESM (Node ≥20.11, vitest)
 * — but the operator Hono host runs these files through tsx's CJS transform
 * (apps/operator has no `"type": "module"`), where `dirname` is undefined and
 * a bare `resolve(import.meta.dirname, …)` throws `paths[0] must be of type
 * string`. There `import.meta.url` IS shimmed, so derive from that. Returns
 * null only when neither is available; callers must treat the result as one
 * candidate among several, not a certainty.
 */
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
function moduleDir(meta) {
    if (meta.dirname)
        return meta.dirname;
    if (meta.url) {
        try {
            return (0, node_path_1.dirname)((0, node_url_1.fileURLToPath)(meta.url));
        }
        catch {
            return null;
        }
    }
    return null;
}
