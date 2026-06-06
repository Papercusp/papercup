/**
 * Format-dispatching encode/decode + the runtime auto-encoder.
 *
 * `encode(value, format)` renders a JSON value in one of the supported formats;
 * `decode(text, format)` is its inverse where defined. The lossless contract:
 * `decode(encode(v, 'toon'), 'toon')` deep-equals `v` for any JSON value (the
 * round-trip property test enforces this). `json` is trivially lossless. `csv`/
 * `tsv` are LOSSY (every cell stringifies) so their round-trip recovers string-
 * coerced rows; `md` is display-only and not decodable.
 */

import { encode as toonEncode, decode as toonDecode } from '@toon-format/toon';
import { decodeDelimited, encodeDelimited, encodeMarkdownTable } from './csv';
import { ResultEncodeError, type ResultFormat } from './formats';

/** Compact JSON (no whitespace) — the lossless universal serialization. */
function encodeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** Render a JSON value in the given format. Throws `ResultEncodeError` for shapes a format can't hold. */
export function encode(value: unknown, format: ResultFormat): string {
  switch (format) {
    case 'json':
      return encodeJson(value);
    case 'toon':
      return toonEncode(value);
    case 'csv':
      return encodeDelimited(value, ',');
    case 'tsv':
      return encodeDelimited(value, '\t');
    case 'md':
      return encodeMarkdownTable(value);
    default: {
      const never: never = format;
      throw new ResultEncodeError(`unknown format: ${String(never)}`);
    }
  }
}

/** Inverse of `encode` where defined. `md` throws (display-only). csv/tsv recover string rows. */
export function decode(text: string, format: ResultFormat): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(text);
    case 'toon':
      return toonDecode(text);
    case 'csv':
      return decodeDelimited(text, ',');
    case 'tsv':
      return decodeDelimited(text, '\t');
    case 'md':
      throw new ResultEncodeError('markdown-table is a display-only format and cannot be decoded');
    default: {
      const never: never = format;
      throw new ResultEncodeError(`unknown format: ${String(never)}`);
    }
  }
}

/**
 * Encode to TOON only when it round-trips losslessly. `@toon-format/toon` is a
 * JSON-lossless superset in the common case, but has rare edge cases (e.g. an
 * empty-string key wrapping a nested object — `[{"": {":": 0}}]`) where
 * `decode(encode(v)) !== v` or the decoder throws. The lossless-to-JSON
 * guarantee is the encoder's contract, not the dependency's, so we VERIFY the
 * round-trip and report whether it held — callers fall back to JSON when it
 * didn't, rather than hand the model a corrupt compact payload.
 */
export function encodeToonChecked(value: unknown): { text: string; lossless: boolean } {
  let text: string;
  try {
    text = toonEncode(value);
  } catch {
    return { text: '', lossless: false };
  }
  try {
    const back = toonDecode(text);
    return { text, lossless: JSON.stringify(back) === JSON.stringify(value) };
  } catch {
    return { text, lossless: false };
  }
}

/** True when `value` is a non-empty array of plain objects whose every leaf is a scalar (runtime CSV-safe). */
export function isFlatObjectArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const row of value) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
    for (const v of Object.values(row as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') return false;
    }
  }
  return true;
}

/**
 * Runtime auto-encoder for the no-output-schema path (D-002): sniff the value
 * and pick a lossless compact format. Arrays → TOON (tabular when uniform,
 * nested otherwise); single objects / scalars → JSON (TOON's win there is
 * marginal and JSON is the natural default, matching the schema'd non-array
 * rule). Lossless either way, so safe to apply to every unschematized tool.
 */
export function encodeAuto(value: unknown): { format: ResultFormat; text: string } {
  if (Array.isArray(value)) {
    const toon = encodeToonChecked(value);
    if (toon.lossless) return { format: 'toon', text: toon.text };
    // TOON couldn't faithfully represent this array — fall back to lossless JSON.
  }
  return { format: 'json', text: encodeJson(value) };
}
