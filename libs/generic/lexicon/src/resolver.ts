/**
 * Pure resolution: given a pack (or pack id) and a term key, return the
 * display label with the requested form + casing. No host state, no flags —
 * the caller supplies the pack. Framework-agnostic so both the React hook and
 * the server twin build on it.
 */
import { BRAND_PACKS, DEFAULT_PACK_ID } from './packs';
import type {
  BrandPack,
  BrandPackId,
  TermKey,
  TermOptions,
} from './types';

/** Resolve a pack id to its {@link BrandPack}, falling back to the default. */
export function getPack(id: BrandPackId | undefined): BrandPack {
  return BRAND_PACKS[id ?? DEFAULT_PACK_ID] ?? BRAND_PACKS[DEFAULT_PACK_ID];
}

function applyCase(label: string, lower: boolean | undefined): string {
  return lower ? label.toLowerCase() : label;
}

function pickForm(
  forms: { one: string; other: string },
  opts: TermOptions | undefined,
): string {
  if (opts?.count !== undefined) {
    return Math.abs(opts.count) === 1 ? forms.one : forms.other;
  }
  return opts?.plural ? forms.other : forms.one;
}

/**
 * Resolve `key` against an explicit pack. The pack may be a {@link BrandPack}
 * or a {@link BrandPackId}.
 */
export function resolveTerm(
  pack: BrandPack | BrandPackId,
  key: TermKey,
  opts?: TermOptions,
): string {
  const resolved = typeof pack === 'string' ? getPack(pack) : pack;
  const forms = resolved.terms[key];
  return applyCase(pickForm(forms, opts), opts?.lower);
}

/** A resolver bound to one pack — `t('pot')` style ergonomics. */
export type BoundLexicon = (key: TermKey, opts?: TermOptions) => string;

/** Build a resolver bound to a single pack id. */
export function lexiconFor(packId: BrandPackId): BoundLexicon {
  const pack = getPack(packId);
  return (key, opts) => resolveTerm(pack, key, opts);
}
