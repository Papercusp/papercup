"use strict";
/**
 * In-memory tool catalog. Tools self-register via `defineTool`.
 *
 * Importing `tools/**` once at server startup is enough to populate this;
 * after that, `getCatalog()` returns the full catalog and `lookup(name)`
 * fetches a specific tool.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
exports.lookup = lookup;
exports.getCatalog = getCatalog;
exports._resetCatalogForTests = _resetCatalogForTests;
const CATALOG = new Map();
function register(def) {
    if (CATALOG.has(def.name)) {
        const existing = CATALOG.get(def.name);
        if (existing === def)
            return;
        throw new Error(`Tool name collision: "${def.name}" registered twice. ` +
            `First registration's capability=${existing.capability}, second's=${def.capability}.`);
    }
    CATALOG.set(def.name, def);
}
function lookup(name) {
    return CATALOG.get(name);
}
function getCatalog() {
    return [...CATALOG.values()];
}
/** Clears the catalog. Test-only. */
function _resetCatalogForTests() {
    CATALOG.clear();
}
