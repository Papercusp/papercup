import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  init: vi.fn(), release: vi.fn(), attr: vi.fn(), arch: vi.fn(), resolve: vi.fn(), add: vi.fn(), load: vi.fn(), prctl: vi.fn(), library: vi.fn(), fds: vi.fn(), fdTarget: vi.fn(), close: vi.fn(), write: vi.fn(), exportBpf: vi.fn(), memfd: vi.fn(), seal: vi.fn(), seek: vi.fn(),
}));
vi.mock('node:fs', () => ({ closeSync: native.close, readdirSync: native.fds, readlinkSync: native.fdTarget, writeFileSync: native.write }));
vi.mock('koffi', () => ({ default: {
  struct: () => ({}), pointer: () => ({}), load: native.library,
} }));
import { createHandlerBootstrapFilter, createHandlerReadonlyFile, HandlerProcessRestrictionError, loadAfterHandlerProcessRestrictions } from './handler-seccomp';
import { createHash } from 'node:crypto';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('UV_USE_IO_URING', '0');
  native.fds.mockReturnValue(['0', '1', '2']);
  native.fdTarget.mockReturnValue('pipe:[1234]');
  native.init.mockReturnValue({ context: true });
  native.attr.mockReturnValue(0);
  native.arch.mockReturnValue(process.arch === 'x64' ? 0xc000003e : 0xc00000b7);
  native.resolve.mockReturnValue(42);
  native.add.mockReturnValue(0);
  native.load.mockReturnValue(0);
  native.exportBpf.mockReturnValue(0);
  native.memfd.mockReturnValue(77);
  native.seal.mockReturnValue(0);
  native.seek.mockReturnValue(0);
  native.prctl.mockImplementation((op: number) => op === 39 ? 1 : op === 21 ? 2 : 0);
  native.library.mockImplementation(() => ({ func: (name: string) => ({
    seccomp_init: native.init, seccomp_release: native.release, seccomp_attr_set: native.attr,
    seccomp_arch_native: native.arch, seccomp_syscall_resolve_name: native.resolve,
    seccomp_rule_add_array: native.add, seccomp_load: native.load, prctl: native.prctl,
    seccomp_export_bpf: native.exportBpf, memfd_create: native.memfd, fcntl: native.seal, lseek: native.seek,
  })[name] }));
});
afterEach(() => vi.unstubAllEnvs());

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('trusted handler restriction phase refusal', () => {
  it('refuses changed runtime-file bytes before allocation and closes an unsealed file', () => {
    const bytes = Buffer.from('trusted runtime input');
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(() => createHandlerReadonlyFile(bytes, '0'.repeat(64))).toThrow('digest mismatch');
    expect(native.memfd).not.toHaveBeenCalled();
    native.seal.mockReturnValue(-1);
    expect(() => createHandlerReadonlyFile(bytes, hash)).toThrow('cannot seal');
    expect(native.write).toHaveBeenCalledWith(77, bytes);
    expect(native.close).toHaveBeenCalledWith(77);
  });

  it('requires actual seal readback before publishing a runtime-file descriptor', () => {
    const bytes = Buffer.from('trusted runtime input');
    const hash = createHash('sha256').update(bytes).digest('hex');
    native.seal.mockImplementation((_fd, op) => op === 1034 ? 7 : 0);
    expect(() => createHandlerReadonlyFile(bytes, hash)).toThrow('cannot seal');
    expect(native.close).toHaveBeenCalledWith(77);
  });

  it('closes an incomplete bootstrap descriptor and refuses launch if filter sealing fails', () => {
    native.seal.mockReturnValue(-1);
    expect(() => createHandlerBootstrapFilter()).toThrow(HandlerProcessRestrictionError);
    expect(native.close).toHaveBeenCalledWith(77);
    expect(native.release).toHaveBeenCalledOnce();
    expect(native.load).not.toHaveBeenCalled();
  });

  it.each([
    ['unsafe runtime startup', () => vi.stubEnv('UV_USE_IO_URING', '')],
    ['pre-existing io_uring', () => native.fdTarget.mockReturnValue('anon_inode:[io_uring]')],
    ['unreadable descriptor census', () => native.fds.mockImplementation(() => { throw new Error('cannot inspect'); })],
    ['unreadable descriptor', () => native.fdTarget.mockImplementation(() => { throw Object.assign(new Error('cannot inspect'), { code: 'EACCES' }); })],
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

  it('tolerates a concurrently closed descriptor while inspecting the runtime', async () => {
    native.fdTarget.mockImplementation(() => { throw Object.assign(new Error('closed'), { code: 'ENOENT' }); });
    await expect(loadAfterHandlerProcessRestrictions(async () => 'loaded')).resolves.toBe('loaded');
  });
});
