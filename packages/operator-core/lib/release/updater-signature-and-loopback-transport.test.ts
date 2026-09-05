/**
 * Guard: the desktop updater's SIGNATURE check is the only thing left holding, so the
 * conditions that make that acceptable must not drift.
 *
 * security-boundary-remediation-and-usability-2026-09-04 P-007 / WI-2144851 — the
 * "verify signed updates and rollback failure cases" half.
 *
 * WHAT IS ACTUALLY BEING GUARDED
 *
 * `papercusp-desktop/src-tauri/tauri.conf.json` ships the updater with
 * `dangerousInsecureTransportProtocol: true`. Read cold that looks like a finding, and it
 * is not: the desktop has no static `endpoints` entry at all (P-052). Both endpoints are
 * built at runtime in `main.rs` and point at the operator sidecar on
 * `http://127.0.0.1:<port>`, whose port is only known after boot — a baked
 * `https://127.0.0.1:3055/...` could never work, because the packaged sidecar speaks plain
 * HTTP on a port it picks itself. The flag exists to let a LOOPBACK http URL past the
 * plugin's release-build https validation. There is no transport exposure in that shape.
 *
 * But the flag is not scoped to loopback — it disables https validation for EVERY endpoint
 * the updater is handed. So the safety of the current configuration is not a property of
 * the flag; it is a property of three separate things staying true at once:
 *
 *   1. `pubkey` remains present, so artifacts are still signature-verified. With the
 *      transport check already off, this is the ONLY remaining barrier between the app and
 *      an arbitrary installer. Dropping it turns a deliberate loopback convenience into
 *      unauthenticated code execution, and nothing else in the tree would notice.
 *   2. No static `endpoints` entry reappears in the conf — one would be fetched over
 *      whatever scheme it names, with validation disabled.
 *   3. Every runtime endpoint builder keeps emitting a loopback URL, and every
 *      `.endpoints(...)` call site keeps getting its URL from one of those builders.
 *
 * None of the three is enforced anywhere, and each fails SILENTLY: a non-loopback http
 * endpoint does not error, it just works — which is the whole hazard. This is also exactly
 * where a rollback failure case lives: `resolve_rollback_endpoint` feeds the same updater
 * machinery, so a downgrade fetched over a tampered plaintext channel is the same defect
 * wearing different clothes.
 *
 * The analysis is a pure function over the two files' text, so the deliberately-broken
 * controls below run the same code as the real-tree case (CLAUDE.md's fixture tier — no
 * mutation of the shared checkout to prove falsifiability).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CONF_PATH = path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri', 'tauri.conf.json');
const MAIN_RS_PATH = path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri', 'src', 'main.rs');

/** A URL literal the updater may be handed without the https check catching it. */
const LOOPBACK_PREFIXES = ['http://127.0.0.1:', 'http://[::1]:', 'http://localhost:'];

type EndpointAnalysis = {
  /** Every `fn resolve_*_endpoint`, with the URL literals it formats. */
  builders: { name: string; urls: string[]; nonLoopback: string[] }[];
  /** Every `.endpoints(` call site, and whether a builder call precedes it in scope. */
  callSites: { line: number; viaBuilder: string | null }[];
};

/**
 * Extract the updater endpoint surface from Rust source.
 *
 * Deliberately text-level rather than a Rust parse: the property is "no non-loopback URL
 * literal can reach `.endpoints(`", and a literal is a textual thing. A builder that
 * computed its host dynamically would show up here as a builder with NO url literals, which
 * the assertions treat as a failure rather than as a pass — an unreadable measurement is
 * never a clean bill.
 */
export function analyzeUpdaterEndpoints(rust: string): EndpointAnalysis {
  const lines = rust.split('\n');
  const builders: EndpointAnalysis['builders'] = [];
  const callSites: EndpointAnalysis['callSites'] = [];

  let current: { name: string; urls: string[] } | null = null;
  let lastBuilderCall: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fnMatch = /^\s*(?:pub\s+)?fn\s+(resolve_\w*endpoint)\s*\(/.exec(line);
    if (fnMatch) {
      if (current) builders.push(finishBuilder(current));
      current = { name: fnMatch[1], urls: [] };
    } else if (current && /^\s*(?:pub\s+)?(?:async\s+)?fn\s+/.test(line)) {
      builders.push(finishBuilder(current));
      current = null;
    }

    if (current) {
      for (const m of line.matchAll(/"(https?:\/\/[^"]*)"/g)) current.urls.push(m[1]);
    }

    // A `.endpoints(` site is attributed to the most recent builder call seen; any Rust
    // `fn` boundary clears the attribution so a call cannot borrow a distant function's.
    const builderCall = /\b(resolve_\w*endpoint)\s*\(/.exec(line);
    if (builderCall && !fnMatch) lastBuilderCall = builderCall[1];
    if (/^\s*(?:pub\s+)?(?:async\s+)?fn\s+/.test(line)) lastBuilderCall = null;
    if (line.includes('.endpoints(')) {
      callSites.push({ line: i + 1, viaBuilder: lastBuilderCall });
    }
  }
  if (current) builders.push(finishBuilder(current));

  return { builders, callSites };
}

function finishBuilder(b: { name: string; urls: string[] }): EndpointAnalysis['builders'][number] {
  return {
    name: b.name,
    urls: b.urls,
    nonLoopback: b.urls.filter((u) => !LOOPBACK_PREFIXES.some((p) => u.startsWith(p))),
  };
}

describe('desktop updater: the signature check must survive, because the transport check is off', () => {
  const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8'));
  const updater = conf?.plugins?.updater ?? {};

  it('keeps a minisign pubkey — the last barrier once https validation is disabled', () => {
    // Asserted unconditionally, not gated on the dangerous flag: a pubkey is required for a
    // signed updater either way, and gating it would make this guard evaporate at exactly
    // the moment someone turns the flag back on.
    expect(typeof updater.pubkey).toBe('string');
    const decoded = Buffer.from(String(updater.pubkey), 'base64').toString('utf8');
    expect(decoded).toMatch(/minisign public key/i);
    // A minisign public key line is a fixed-width base64 blob; a truncated or placeholder
    // value would still decode to *something*, so check the key line, not just the comment.
    expect(decoded.trim().split('\n').at(-1)?.length ?? 0).toBeGreaterThan(40);
  });

  it('ships NO static updater endpoint (P-052) — a static one would be fetched unvalidated', () => {
    expect(updater.endpoints).toBeUndefined();
  });

  it('leaves the updater active, so this configuration is the one that actually runs', () => {
    expect(updater.active).toBe(true);
  });
});

describe('desktop updater: every endpoint the plugin is handed is loopback', () => {
  const rust = readFileSync(MAIN_RS_PATH, 'utf8');
  const analysis = analyzeUpdaterEndpoints(rust);

  it('finds the builders and call sites at all — a zero here is a broken probe, not a pass', () => {
    // The failure mode this test exists to refuse: main.rs is refactored, the regexes match
    // nothing, and the two assertions below pass over an empty set while reporting green.
    expect(analysis.builders.length).toBeGreaterThan(0);
    expect(analysis.callSites.length).toBeGreaterThan(0);
  });

  it('formats only loopback URLs in every resolve_*_endpoint builder', () => {
    const offenders = analysis.builders.filter((b) => b.nonLoopback.length > 0 || b.urls.length === 0);
    expect(
      offenders.map((b) => ({ builder: b.name, urls: b.nonLoopback.length ? b.nonLoopback : b.urls })),
      'an updater endpoint builder emits a URL that is not loopback (or emits no literal at ' +
        'all, so it cannot be read). tauri.conf.json sets dangerousInsecureTransportProtocol, ' +
        'which disables the https check for EVERY endpoint — the loopback shape is the only ' +
        'thing that makes that acceptable. Either keep the URL on 127.0.0.1 or turn the flag ' +
        'off and use https.',
    ).toEqual([]);
  });

  it('feeds every .endpoints() call site from one of those builders', () => {
    const unattributed = analysis.callSites.filter((s) => s.viaBuilder === null);
    expect(
      unattributed.map((s) => s.line),
      'a .endpoints() call site does not take its URL from a resolve_*_endpoint builder, so ' +
        'the loopback guarantee above does not cover it.',
    ).toEqual([]);
  });
});

describe('desktop updater: the endpoint analysis is falsifiable', () => {
  // Permanent controls. Without these, the three assertions above are indistinguishable
  // from a probe that silently matches nothing on the real tree.
  const LOOPBACK_SRC = [
    'fn resolve_update_endpoint(app: &AppHandle) -> Result<String, String> {',
    '    Ok(format!("http://127.0.0.1:{}/api/updates/manifest", port))',
    '}',
    'async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {',
    '    let endpoint = resolve_update_endpoint(&app)?;',
    '    let updater = app.updater_builder().endpoints(vec![url])?;',
    '}',
  ].join('\n');

  it('CONTROL: does not fire on the loopback shape the real tree uses', () => {
    const a = analyzeUpdaterEndpoints(LOOPBACK_SRC);
    expect(a.builders.map((b) => b.nonLoopback)).toEqual([[]]);
    expect(a.callSites.map((s) => s.viaBuilder)).toEqual(['resolve_update_endpoint']);
  });

  it('CONTROL: catches a builder that reaches a real host over plaintext http', () => {
    const a = analyzeUpdaterEndpoints(
      LOOPBACK_SRC.replace('http://127.0.0.1:{}', 'http://updates.example.com:{}'),
    );
    expect(a.builders[0].nonLoopback).toEqual(['http://updates.example.com:{}/api/updates/manifest']);
  });

  it('CONTROL: catches a builder with no readable URL literal', () => {
    const a = analyzeUpdaterEndpoints(
      LOOPBACK_SRC.replace('Ok(format!("http://127.0.0.1:{}/api/updates/manifest", port))', 'Ok(host)'),
    );
    expect(a.builders[0].urls).toEqual([]);
  });

  it('CONTROL: catches an .endpoints() call site that bypasses the builders', () => {
    const a = analyzeUpdaterEndpoints(
      [
        'async fn rogue(app: AppHandle) {',
        '    let url = Url::parse("http://updates.example.com/x").unwrap();',
        '    app.updater_builder().endpoints(vec![url]);',
        '}',
      ].join('\n'),
    );
    expect(a.callSites.map((s) => s.viaBuilder)).toEqual([null]);
  });
});
