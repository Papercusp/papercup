import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  init: vi.fn(), release: vi.fn(), attr: vi.fn(), arch: vi.fn(), resolve: vi.fn(), add: vi.fn(), load: vi.fn(), prctl: vi.fn(), library: vi.fn(),
}));
vi.mock('koffi', () => ({ default: {
  struct: () => ({}), pointer: () => ({}), load: native.library,
} }));
import { HandlerProcessRestrictionError, loadAfterHandlerProcessRestrictions } from './handler-seccomp';

beforeEach(() => {
  vi.clearAllMocks();
  native.init.mockReturnValue({ context: true });
  native.attr.mockReturnValue(0);
  native.arch.mockReturnValue(process.arch === 'x64' ? 0xc000003e : 0xc00000b7);
  native.resolve.mockReturnValue(42);
  native.add.mockReturnValue(0);
  native.load.mockReturnValue(0);
  native.prctl.mockImplementation((op: number) => op === 39 ? 1 : op === 21 ? 2 : 0);
  native.library.mockImplementation(() => ({ func: (name: string) => ({
    seccomp_init: native.init, seccomp_release: native.release, seccomp_attr_set: native.attr,
    seccomp_arch_native: native.arch, seccomp_syscall_resolve_name: native.resolve,
    seccomp_rule_add_array: native.add, seccomp_load: native.load, prctl: native.prctl,
  })[name] }));
});

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('trusted handler restriction phase refusal', () => {
  it.each([
    ['missing library', () => native.library.mockImplementation(() => { throw new Error('not installed'); })],
    ['wrong ABI', () => native.arch.mockReturnValue(0)],
    ['allocation', () => native.init.mockReturnValue(null)],
    ['attribute failure', () => native.attr.mockReturnValue(-22)],
    ['unresolved syscall', () => native.resolve.mockReturnValue(-1)],
    ['rule failure', () => native.add.mockReturnValue(-22)],
    ['negative load failure', () => native.load.mockReturnValue(-1)],
    ['positive TSYNC failing thread ID', () => native.load.mockReturnValue(1234)],
    ['kernel readback', () => native.prctl.mockReturnValue(0)],
  ] as const)('does not import the handler after %s', async (_stage, fail) => {
    fail();
    const importSentinel = vi.fn(async () => 'executed');
    await expect(loadAfterHandlerProcessRestrictions(importSentinel)).rejects.toBeInstanceOf(HandlerProcessRestrictionError);
    expect(importSentinel).not.toHaveBeenCalled();
  });

  it('executes the authorized loader only after successful filter load and kernel readback', async () => {
    const loader = vi.fn(async () => {
      expect(native.load).toHaveBeenCalledOnce();
      expect(native.prctl).toHaveBeenCalledWith(39, 0, 0, 0, 0);
      expect(native.release).toHaveBeenCalledOnce();
      return 'loaded';
    });
    await expect(loadAfterHandlerProcessRestrictions(loader)).resolves.toBe('loaded');
  });

  it('releases an allocated compiler context after rule refusal', async () => {
    native.add.mockReturnValue(-1);
    await expect(loadAfterHandlerProcessRestrictions(async () => undefined)).rejects.toThrow('rule execve');
    expect(native.release).toHaveBeenCalledOnce();
    expect(native.load).not.toHaveBeenCalled();
  });
});
