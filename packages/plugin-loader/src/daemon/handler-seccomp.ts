/**
 * Trusted Linux guest bootstrap phase, BEFORE importing a handler or its dependencies.
 * This is one component of the handler boundary: the supervisor must separately
 * establish immutable filesystem mounts, private namespaces, clean descriptors and
 * a scrubbed startup environment. Never call this in the operator process.
 *
 * libseccomp compiles the filter; Koffi supplies the maintained native bridge.
 * TSYNC covers Node's existing threads, and newly created threads inherit it.
 * There is deliberately no permissive fallback or handler-supplied policy.
 */
import koffi from 'koffi';

const ALLOW = 0x7fff0000;
const KILL_PROCESS = 0x80000000;
const errnoAction = (errno: number) => 0x00050000 | errno;
const EPERM = 1;
const ENOSYS = 38;
const EQ = 4;
const NE = 1;
const MASKED_EQ = 7;
const NNP = 3;
const TSYNC = 4;
const BAD_ARCH = 2;
const PR_SET_DUMPABLE = 4;
const PR_GET_DUMPABLE = 3;
const PR_GET_SECCOMP = 21;
const PR_GET_NO_NEW_PRIVS = 39;

export class HandlerProcessRestrictionError extends Error {
  readonly code = 'handler-process-restriction-unavailable';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HandlerProcessRestrictionError';
  }
}

export interface HandlerProcessRestrictionReceipt {
  profile: 'linux-handler-process-v1';
  arch: 'x64' | 'arm64';
  pid: number;
  noNewPrivileges: true;
  synchronizedThreads: true;
}

/** Irreversible. Only the trusted, dedicated guest may enter this phase. */
export function establishHandlerProcessRestrictions(): HandlerProcessRestrictionReceipt {
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new HandlerProcessRestrictionError(`unsupported handler process profile: ${process.platform}/${process.arch}`);
  }
  try {
    const lib = koffi.load('libseccomp.so.2');
    const libc = koffi.load('libc.so.6');
    const comparison = koffi.struct({ arg: 'unsigned int', op: 'int', datum_a: 'uint64_t', datum_b: 'uint64_t' });
    const init = lib.func('seccomp_init', 'void *', ['uint32_t']);
    const release = lib.func('seccomp_release', 'void', ['void *']);
    const attr = lib.func('seccomp_attr_set', 'int', ['void *', 'int', 'uint32_t']);
    const nativeArch = lib.func('seccomp_arch_native', 'uint32_t', []);
    const resolve = lib.func('seccomp_syscall_resolve_name', 'int', ['str']);
    const add = lib.func('seccomp_rule_add_array', 'int', ['void *', 'uint32_t', 'int', 'unsigned int', koffi.pointer(comparison)]);
    const load = lib.func('seccomp_load', 'int', ['void *']);
    // Fixed prototype avoids C vararg promotion/width ambiguity on either ABI.
    const prctl = libc.func('prctl', 'int', ['int', 'unsigned long', 'unsigned long', 'unsigned long', 'unsigned long']);
    const check = (result: number, stage: string) => {
      // TSYNC can report a positive failing thread ID. Only zero is success.
      if (result !== 0) throw new HandlerProcessRestrictionError(`${stage} returned ${result}`);
    };
    const expectedArch = process.arch === 'x64' ? 0xc000003e : 0xc00000b7;
    if (nativeArch() !== expectedArch) throw new HandlerProcessRestrictionError('libseccomp native architecture mismatch');
    const ctx = init(ALLOW);
    if (ctx === null) throw new HandlerProcessRestrictionError('seccomp_init returned null');
    try {
      check(attr(ctx, BAD_ARCH, KILL_PROCESS), 'bad-architecture action');
      check(attr(ctx, NNP, 1), 'no-new-privileges attribute');
      check(attr(ctx, TSYNC, 1), 'thread synchronization attribute');
      const deny = (name: string, errno = EPERM, comparisons: Array<{ arg: number; op: number; datum_a: number; datum_b: number }> = []) => {
        const syscall = resolve(name);
        if (syscall < 0) throw new HandlerProcessRestrictionError(`unresolved required syscall: ${name}`);
        check(add(ctx, errnoAction(errno), syscall, comparisons.length, comparisons.length ? comparisons : null), `rule ${name}`);
      };
      for (const name of [
        'execve', 'execveat', 'ptrace', 'process_vm_readv', 'process_vm_writev',
        'pidfd_open', 'pidfd_getfd', 'pidfd_send_signal', 'kcmp',
        'unshare', 'setns', 'mount', 'umount2', 'pivot_root', 'chroot',
        'open_tree', 'move_mount', 'fsopen', 'fsconfig', 'fsmount', 'mount_setattr',
        // No direct network OR Unix/abstract sockets. Broker traffic uses stdio.
        'socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4',
        'sendto', 'sendmsg', 'sendmmsg',
        // io_uring operations must not bypass the syscall rules above.
        'io_uring_setup', 'io_uring_enter', 'io_uring_register',
        'kill', 'tkill', 'setsid', 'setpgid',
      ]) deny(name);
      if (process.arch === 'x64') for (const name of ['fork', 'vfork']) deny(name);
      // glibc falls back from clone3 ENOSYS to clone. EPERM would break threads.
      deny('clone3', ENOSYS);
      // clone is allowed only for threads sharing address space and signal handlers.
      for (const bit of [0x00000100, 0x00000800, 0x00010000]) {
        deny('clone', EPERM, [{ arg: 0, op: MASKED_EQ, datum_a: bit, datum_b: 0 }]);
      }
      // A thread must not also request a new namespace (including CLONE_NEWTIME).
      for (const bit of [0x80, 0x20000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000]) {
        deny('clone', EPERM, [{ arg: 0, op: MASKED_EQ, datum_a: bit, datum_b: bit }]);
      }
      // Preserve pthread signalling within this thread group only.
      deny('tgkill', EPERM, [{ arg: 0, op: NE, datum_a: process.pid, datum_b: 0 }]);
      check(prctl(PR_SET_DUMPABLE, 0, 0, 0, 0), 'disable process dumps');
      deny('prctl', EPERM, [{ arg: 0, op: EQ, datum_a: PR_SET_DUMPABLE, datum_b: 0 }]);
      deny('prctl', EPERM, [{ arg: 0, op: EQ, datum_a: 0x59616d61, datum_b: 0 }]); // PR_SET_PTRACER
      check(load(ctx), 'seccomp_load with TSYNC');
      if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) !== 1
        || prctl(PR_GET_SECCOMP, 0, 0, 0, 0) !== 2
        || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) !== 0) {
        throw new HandlerProcessRestrictionError('kernel process restriction readback mismatch');
      }
      return { profile: 'linux-handler-process-v1', arch: process.arch, pid: process.pid, noNewPrivileges: true, synchronizedThreads: true };
    } finally {
      release(ctx);
    }
  } catch (cause) {
    if (cause instanceof HandlerProcessRestrictionError) throw cause;
    throw new HandlerProcessRestrictionError('cannot establish handler process restrictions', { cause });
  }
}

/** Loader failures propagate; restriction failures never execute the loader. */
export async function loadAfterHandlerProcessRestrictions<T>(load: () => Promise<T>): Promise<T> {
  establishHandlerProcessRestrictions();
  return load();
}
