import type { SnapshotPlugin } from '@papercusp/export-state';

/**
 * Read versionPin from a plugin manifest, accepting both v2 `versionPin`
 * (preferred) and the deprecated v1 `pluginVersionPinned: bool` form.
 * Returns undefined when neither is present so callers can apply their
 * own default at write time.
 */
export function readVersionPin(m: {
  versionPin?: unknown;
  pluginVersionPinned?: unknown;
}): SnapshotPlugin['versionPin'] | undefined {
  const v = m.versionPin;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as { mode?: unknown; allowOverride?: unknown };
    if (obj.mode === 'exact' || obj.mode === 'semver' || obj.mode === 'hash') {
      const out: SnapshotPlugin['versionPin'] = { mode: obj.mode };
      if (obj.allowOverride === 'security-patch' || obj.allowOverride === 'always' || obj.allowOverride === 'never') {
        out!.allowOverride = obj.allowOverride;
      }
      return out;
    }
  }
  if (m.pluginVersionPinned === true) return { mode: 'exact' };
  if (m.pluginVersionPinned === false) return { mode: 'semver' };
  return undefined;
}
