import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


script = Path(__file__).with_name('pack-server.py')
spec = importlib.util.spec_from_file_location('psu_acp_packer', script)
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)


class RenderedPlanningRuleTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sidecar = self.root / 'source'
        self.prompts = Path('harness/blueprints/base/prompts')
        (self.sidecar / self.prompts).mkdir(parents=True)
        self.blueprints = script.resolve().parents[5] / 'libs/papercusp/packages' / self.prompts

    def seed(self, persona, kernel):
        for name, text in [('su.md', persona), ('su.kernel.md', kernel)]:
            (self.sidecar / self.prompts / name).write_text(text)

    def test_current_staging_blueprints_pack_without_rewriting(self):
        self.seed((self.blueprints / 'su.md').read_text(),
                  (self.blueprints / 'su.kernel.md').read_text())
        self.assertEqual(packer.staged_prompts(self.sidecar, self.root), self.sidecar)

    def test_legacy_rule_is_projected_into_a_copy(self):
        old = '- **Plan before non-trivial work.** File a local plan for a split.'
        rule = old + ' Work carrying `external_plan_ref` may use a `claimKinds` fleet.'
        tail = '\n- **Next rule.**\n'
        self.seed(old + tail, rule + tail)
        staged = packer.staged_prompts(self.sidecar, self.root)
        self.assertEqual((staged / self.prompts / 'su.md').read_text(), rule + tail)
        self.assertEqual((self.sidecar / self.prompts / 'su.md').read_text(), old + tail)

    def test_missing_outside_plan_rule_is_rejected(self):
        text = '- **Plan before non-trivial work.** File a local plan.\n- **Next rule.**\n'
        self.seed(text, text)
        with self.assertRaisesRegex(ValueError, 'Missing external'):
            packer.staged_prompts(self.sidecar, self.root)


if __name__ == '__main__':
    unittest.main()
