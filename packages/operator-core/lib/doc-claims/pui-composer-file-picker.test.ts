/**
 * Build-time pin for the PUI composer file-picker claims in PUBLIC_RELEASE_UX.md.
 *
 * The fixture controls are as important as the live assertion: once the product
 * satisfies the prose, a passing live check alone cannot prove the judge would
 * notice a later regression. Each promise therefore has a deliberately broken
 * source shape below that must fail.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { judgeComposerPickerClaims } from './pui-composer-file-picker';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const LIVE = {
  appRs: readFileSync(join(REPO_ROOT, 'apps/tui/src/app.rs'), 'utf8'),
  uiRs: readFileSync(join(REPO_ROOT, 'apps/tui/src/ui.rs'), 'utf8'),
  pickerRs: readFileSync(join(REPO_ROOT, 'apps/tui/src/file_picker.rs'), 'utf8'),
};

const APP = `
impl App {
    fn composer_key(&mut self, code: KeyCode) -> Action {
        match code {
            KeyCode::Char('@') => self.open_file_picker(),
            _ => Action::None,
        }
    }
}
`;

const UI = `
for row in app.attachments.rows() {
    composer_lines.push(Line::from(row));
}
composer_lines.push(Line::from(Span::styled(ctext, composer_style)));
`;

const PICKER = `
use std::path::Path;

pub enum Refusal { OutsideProject }

impl Refusal {
    pub fn reason(&self) -> &'static str { "outside project" }
}

pub fn attach(root: &Path, candidate: &Path) -> Result<(), Refusal> {
    let root = root.canonicalize().map_err(|_| Refusal::OutsideProject)?;
    let candidate = candidate.canonicalize().map_err(|_| Refusal::OutsideProject)?;
    if !candidate.starts_with(&root) { return Err(Refusal::OutsideProject); }
    Ok(())
}

pub struct Attachments { entries: Vec<String> }

impl Attachments {
    pub fn remove(&mut self, reference: &str) {
        self.entries.retain(|entry| entry != reference);
    }
}
`;

function judge(overrides: Partial<typeof LIVE> = {}) {
  return judgeComposerPickerClaims({ ...LIVE, ...overrides });
}

describe('PUI composer file-picker documentation claims', () => {
  describe('fixture controls (the detector must be able to fail)', () => {
    it('rejects prose with no @ key handler wired to the picker', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: APP.replace("KeyCode::Char('@')", "KeyCode::Char('x')"),
        uiRs: UI,
        pickerRs: PICKER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no KeyCode::Char\('@'\) handler/);
    });

    it('rejects a second @ handler that makes the composer-only affordance global', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: `${APP}\nfn global_key(code: KeyCode) { if let KeyCode::Char('@') = code {} }`,
        uiRs: UI,
        pickerRs: PICKER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.atHandlerCount).toBe(2);
      expect(verdict.violations.join('\n')).toMatch(/second one is reachable outside the composer/);
    });

    it('rejects attachment rows rendered after the draft', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: APP,
        uiRs: `composer_lines.push(Line::from(Span::styled(ctext, composer_style)));\napp.attachments.rows();`,
        pickerRs: PICKER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/pushes them after the draft row/);
    });

    it('rejects attachment removal that mutates the selected file', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: APP,
        uiRs: UI,
        pickerRs: PICKER.replace(
          'self.entries.retain(|entry| entry != reference);',
          'std::fs::remove_file(reference).unwrap();\n        self.entries.retain(|entry| entry != reference);',
        ),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/remove_file/);
    });

    it('rejects a lexical boundary check that does not canonicalise paths', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: APP,
        uiRs: UI,
        pickerRs: PICKER.replaceAll('.canonicalize()', '.to_path_buf()'),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/never canonicalises/);
    });

    it('rejects a same-name fallback inside attach()', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: APP,
        uiRs: UI,
        pickerRs: PICKER.replace(
          'let root = root.canonicalize()',
          'let _fallback = std::fs::read_dir(root);\n    let root = root.canonicalize()',
        ),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/name lookup can substitute/);
    });

    it('rejects a refusal type that cannot explain itself', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: APP,
        uiRs: UI,
        pickerRs: PICKER.replace('    pub fn reason(&self) -> &\'static str { "outside project" }\n', ''),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no reason\(\) accessor/);
    });

    it('does not accept implementation shapes that exist only under #[cfg(test)]', () => {
      const verdict = judgeComposerPickerClaims({
        appRs: `fn production() {}\n#[cfg(test)]\n${APP}`,
        uiRs: `fn production() {}\n#[cfg(test)]\n${UI}`,
        pickerRs: `pub enum Refusal {}\n#[cfg(test)]\n${PICKER}`,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.atHandlerCount).toBe(0);
      expect(verdict.violations.join('\n')).toMatch(/no KeyCode::Char\('@'\) handler/);
    });
  });

  describe('live product sources', () => {
    it('keeps every PUBLIC_RELEASE_UX.md composer picker promise wired to code', () => {
      const verdict = judge();
      expect(verdict.violations).toEqual([]);
      expect(verdict.atHandlerCount).toBe(1);
      expect(verdict.ok).toBe(true);
    });
  });
});
