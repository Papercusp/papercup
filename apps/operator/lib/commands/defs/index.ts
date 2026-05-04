/**
 * Action registry def loader.
 *
 * Importing this module side-effect-imports every def file in a stable
 * order. Each def file calls `register()` at top level; the import
 * order doesn't matter for correctness (defs don't depend on each other)
 * but a stable order makes registry-snapshot tests deterministic.
 *
 * To add a new def file: create it in this directory and add the import
 * here. Don't import from defs/* anywhere else — call `list()` /
 * `get()` from the registry instead.
 */

import './panel';
