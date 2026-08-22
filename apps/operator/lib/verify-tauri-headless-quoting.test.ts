/**
 * EI-20207763368144905 — quote-safe HUD assertions for verify-tauri-headless.
 *
 * A nested `bash -c` can silently concatenate adjacent double-quoted shell
 * fragments. The command still exits successfully, but tauri-agent-tools sees
 * `to: /settings/p2p` instead of the quoted JS string, so the run is invalid.
 * Keep the documented outer-double/single-JS-quote recipe executable here.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const COUNT_SURFACES_SCRIPT = resolve(
  __dirname,
  '../../../scripts/verify-count-surfaces-tauri.sh',
);
const countSurfacesSrc = readFileSync(COUNT_SURFACES_SCRIPT, 'utf8');
const EXPRESSION = 'window.__TSR_ROUTER__?.navigate({ to: "/settings/p2p" })';

function fakeCommandDir() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-quoting-'));
  const evalCapture = join(dir, 'eval.txt');
  const pollCapture = join(dir, 'poll.txt');
  const fakeTool = join(dir, 'tauri-agent-tools');
  const fakePoll = join(dir, 'poll-dom.sh');
  writeFileSync(
    fakeTool,
    `#!/usr/bin/env bash
set -u
[ "$1" = eval ] || exit 20
[ "$2" = --pid ] || exit 21
[ "$3" = 4242 ] || exit 22
printf '%s' "$4" > "$VERIFY_TAURI_EVAL_CAPTURE"
`,
  );
  writeFileSync(
    fakePoll,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$@" > "$VERIFY_TAURI_POLL_CAPTURE"
`,
  );
  chmodSync(fakeTool, 0o755);
  chmodSync(fakePoll, 0o755);
  return { dir, evalCapture, pollCapture, fakePoll };
}

describe('EI-20207763368144905 — nested HUD assertion quoting', () => {
  it('documents the safe outer-double/single-JS-quote recipe', () => {
    expect(src).toContain(`'${EXPRESSION.replaceAll('"', '\\"')}'`);
    expect(src).not.toContain(`"${EXPRESSION}"`);
  });

  it('preserves the JS route and poll arguments through bash -c', () => {
    const { dir, evalCapture, pollCapture, fakePoll } = fakeCommandDir();
    const recipe = [
      'tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" \\',
      `  '${EXPRESSION}'`,
      '"$VERIFY_TAURI_POLL" --selector body --text Peer --no-errors',
    ].join('\n');
    const result = spawnSync('bash', ['-c', recipe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_POLL: fakePoll,
        VERIFY_TAURI_EVAL_CAPTURE: evalCapture,
        VERIFY_TAURI_POLL_CAPTURE: pollCapture,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(evalCapture, 'utf8')).toBe(EXPRESSION);
    expect(readFileSync(pollCapture, 'utf8')).toBe(
      '--selector\nbody\n--text\nPeer\n--no-errors\n',
    );
  });
});

describe('P-014 corpus-count Tauri acceptance recipe', () => {
  it('pins every required route and decisive selector without a placeholder', () => {
    expect(countSurfacesSrc).not.toContain('<exit-coded assertion command>');
    expect(countSurfacesSrc).toContain('tab: "harnesses", slug: "papercusp"');
    expect(countSurfacesSrc).toContain('tab: "learning", lview: "observations"');
    expect(countSurfacesSrc).toContain('tab: "learning", lview: "improvements"');
    expect(countSurfacesSrc).toContain('tab: "learning", lview: "learnings"');
    expect(countSurfacesSrc).toContain('tab: "git", slug: "papercusp"');
    expect(countSurfacesSrc).toContain('to: "/coord", search: { panel: "history" }');
    expect(countSurfacesSrc).toContain('to: "/cupboard"');
    expect(countSurfacesSrc).toContain('[data-testid=wi-count]');
    expect(countSurfacesSrc).toContain('[data-testid=observations-count]');
    expect(countSurfacesSrc).toContain(
      '.pc-learning__inlinetools .pc-learning__matchcount',
    );
    expect(countSurfacesSrc).not.toContain(
      'document.querySelector(".pc-learning__matchcount")',
    );
    expect(countSurfacesSrc).not.toContain('"$P014_TAURI_TOOL" wait');
    expect(countSurfacesSrc.match(/"\$P014_TAURI_POLL" \\\n  --eval/g)).toHaveLength(3);
    expect(countSurfacesSrc).toContain('.pc-learning__retained .pc-advpanel__count');
    expect(countSurfacesSrc).toContain('.pc-adv-gitgrid__count');
    expect(countSurfacesSrc).toContain('Filter option counts cover latest 300 events.');
    expect(countSurfacesSrc).toContain('latest matches · up to 200');
    expect(countSurfacesSrc).toContain('[data-testid=cupboard-pagination]');
  });

  it('makes population mismatches, console errors, and missing provenance fail closed', () => {
    expect(countSurfacesSrc).toContain('set -euo pipefail');
    expect(countSurfacesSrc).toContain('missing PAPERCUSP_SID provenance');
    expect(countSurfacesSrc).toContain('--no-errors');
    expect(countSurfacesSrc).toContain('/loaded/i.test');
    expect(countSurfacesSrc).toContain('facets.reduce((a, b) => a + b, 0) === total');
  });

  it('writes route-specific captures and one unambiguous terminal marker', () => {
    for (const capture of [
      'p014_capture work-items',
      'p014_capture learning-observations',
      'p014_capture learning-improve',
      'p014_capture learning-retain',
      'p014_capture git-history',
      'p014_capture logs',
      'p014_capture coordination-history',
      'p014_capture cupboard',
    ]) {
      expect(countSurfacesSrc).toContain(capture);
    }
    expect(countSurfacesSrc).toContain('P014_TAURI_ACCEPTANCE_OK');
  });
});
