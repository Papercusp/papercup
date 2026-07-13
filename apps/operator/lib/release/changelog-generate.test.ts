import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildChangelogPrompt,
  fallbackChangelog,
  generateChangelog,
  lintChangelogClaims,
  sanitizeChangelog,
  type ChangelogInput,
} from './changelog-generate';
import type { ShippedItem, ShippedPlan } from './release-registry';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function item(id: string, title: string, planSlug: string | null = null): ShippedItem {
  return { id, title, planSlug };
}
function plan(slug: string, title: string, itemCount: number): ShippedPlan {
  return { slug, title, status: 'done', content: '', itemCount };
}

const INPUT: ChangelogInput = {
  version: '0.0.9',
  channel: 'alpha',
  previousVersion: '0.0.8',
  items: [
    item('WI-4389', 'Reworked how the desktop checks for updates', 'auto-update-fix'),
    item('WI-4480', 'Global docs-search shortcut: OFF by default + a real disable option', 'shortcuts'),
    item('WI-4419', 'Release bundles no longer ship the whole repo', 'release-hygiene'),
    item('WI-4484', 'Memory settings store-selector fix'),
  ],
  plans: [plan('auto-update-fix', 'Auto-update reliability', 1), plan('shortcuts', 'Keyboard shortcuts', 1)],
  internalCount: 71,
};

describe('buildChangelogPrompt — the safety rules ARE the module; pin them', () => {
  const prompt = buildChangelogPrompt(INPUT);

  it('forbids the "now works / is fixed / verified" class of claim — the lie 0.0.9 nearly shipped', () => {
    // This is the whole reason the module exists: a model handed "the work is done"
    // will write "it works now". If this instruction ever silently disappears, the
    // changelog can lie the way it almost did on 2026-07-13. Fail loudly here first.
    expect(prompt).toMatch(/never claim/i);
    expect(prompt).toMatch(/now works|is fixed|is verified/i);
    expect(prompt).toMatch(/describe the change, not its success/i);
  });

  it('tells the model the audience is beta testers, not engineers', () => {
    expect(prompt).toMatch(/beta tester/i);
  });

  it('bans leaking ids, plan slugs, people, and paths', () => {
    expect(prompt).toMatch(/WI-…|work item id/i);
    expect(prompt).toMatch(/name or email/i);
  });

  it('feeds the model the item titles, grouped under their workstream', () => {
    expect(prompt).toContain('Auto-update reliability');
    expect(prompt).toContain('Reworked how the desktop checks for updates');
    // an unplanned item lands under the one-off bucket, not dropped
    expect(prompt).toContain('Memory settings store-selector fix');
    expect(prompt).toMatch(/Unplanned/);
  });

  it('states the internal-fix count without enumerating it', () => {
    expect(prompt).toContain('71 internal');
    // The COUNT enters the prompt; the individual EI ids never do. ("EI-…" appears
    // only inside the "never mention" ban, so assert no concrete EI-<number>.)
    expect(prompt).not.toMatch(/EI-\d/);
  });
});

describe('sanitizeChangelog', () => {
  it('unwraps a ```markdown fence the model adds despite being told not to', () => {
    expect(sanitizeChangelog('```markdown\n## Highlights\n- a\n```')).toBe('## Highlights\n- a');
  });

  it('drops a "Here are the notes:" preamble before the first heading', () => {
    expect(sanitizeChangelog('Here are the release notes:\n\n## Highlights\n- a')).toBe(
      '## Highlights\n- a',
    );
  });

  it('leaves clean markdown untouched and never empties content that has no heading', () => {
    expect(sanitizeChangelog('- just a bullet, no heading')).toBe('- just a bullet, no heading');
  });
});

describe('fallbackChangelog — dull, deterministic, and TRUE', () => {
  const md = fallbackChangelog(INPUT);
  it('states only registry facts and makes no success claim', () => {
    expect(md).toContain('4 tracked changes');
    expect(md).toContain('since 0.0.8');
    expect(md).toContain('Auto-update reliability');
    expect(md).not.toMatch(/works now|is fixed|verified/i);
  });
});

describe('lintChangelogClaims — spotlight the model\'s reliable mistakes', () => {
  it('flags success claims — the "fixed / now works" lie class', () => {
    const w = lintChangelogClaims('## Highlights\n- Auto-update now works on all platforms\n- Login is fixed');
    expect(w.join('\n')).toMatch(/now works/i);
    expect(w.join('\n')).toMatch(/on all platforms/i);
    expect(w.join('\n')).toMatch(/fixed/i);
  });

  it('flags internal vocabulary a beta tester has no context for', () => {
    // These are the exact leaks the first live run produced despite the prompt ban.
    const w = lintChangelogClaims('- Fixed a fleet-wide memory issue where agents got zero results\n- see WI-4389');
    expect(w.join('\n')).toMatch(/fleet/i);
    expect(w.join('\n')).toMatch(/agent/i);
    expect(w.join('\n')).toMatch(/work-item/i);
  });

  it('stays quiet on clean, change-describing prose', () => {
    expect(lintChangelogClaims('## Highlights\n- Reworked how the app checks for updates')).toEqual([]);
  });
});

describe('generateChangelog — generation and review are separate decisions', () => {
  it('writes the model output to the draft path and reports source=model', async () => {
    const draft = path.join(tmp, 'a', 'changelog.md');
    const res = await generateChangelog(INPUT, draft, {}, {
      complete: async () => '## Highlights\n- Reworked how the app checks for updates',
    });
    expect(res.source).toBe('model');
    expect(fs.readFileSync(draft, 'utf8')).toContain('Reworked how the app checks for updates');
  });

  it('REUSES an existing draft instead of re-rolling — the reviewed bytes are the recorded bytes', async () => {
    const draft = path.join(tmp, 'b', 'changelog.md');
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, '## Highlights\n- a human edited this line', 'utf8');
    let called = false;
    const res = await generateChangelog(INPUT, draft, {}, {
      complete: async () => {
        called = true;
        return '## Highlights\n- a DIFFERENT model roll';
      },
    });
    expect(called).toBe(false);
    expect(res.source).toBe('existing-draft');
    expect(res.md).toContain('a human edited this line');
  });

  it('force re-rolls even when a draft exists', async () => {
    const draft = path.join(tmp, 'c', 'changelog.md');
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, 'old', 'utf8');
    const res = await generateChangelog(INPUT, draft, { force: true }, {
      complete: async () => '## Highlights\n- fresh roll',
    });
    expect(res.source).toBe('model');
    expect(res.md).toContain('fresh roll');
  });

  it('falls back to the deterministic changelog when the model call fails', async () => {
    const draft = path.join(tmp, 'd', 'changelog.md');
    const res = await generateChangelog(INPUT, draft, {}, { complete: async () => null });
    expect(res.source).toBe('fallback');
    expect(res.md).toContain('tracked changes');
    // even a failed generation leaves usable notes on disk
    expect(fs.existsSync(draft)).toBe(true);
  });
});
