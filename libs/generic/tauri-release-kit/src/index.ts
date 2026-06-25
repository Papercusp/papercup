/**
 * @papercusp/tauri-release-kit
 *
 * Provider-agnostic Tauri desktop build+release orchestration. The pure core
 * (this barrel) is side-effect-free; build target drivers + the gh release
 * driver + the CLI wire real Exec/Fs ports (added in later phases).
 *
 * See README.md and /internal/docs/build-system/tauri-release-kit-proposal.
 */
export * from './types.js';
export * from './tag.js';
export * from './version.js';
export * from './artifacts.js';
export * from './latest-json.js';
