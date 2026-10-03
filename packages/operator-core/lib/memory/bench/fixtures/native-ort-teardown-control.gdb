# Host abort evidence for the small maintained ORT fixture, never a model benchmark.
set pagination off
set confirm off
set print thread-events off
set debuginfod enabled off
set disable-randomization off
handle SIGPIPE nostop noprint pass
handle SIGUSR1 nostop noprint pass
handle SIGABRT stop print pass
python
import gdb, json, hashlib
native_pid = None
native_signal = None
native_continued = False
native_exited = False

# Opt-in, version-qualified ORT 1.24.3 native ownership observer. Default
# debugger captures keep their original behavior. These breakpoints observe
# calls/returns, not the location of a corrupting write or free.
ownership_symbols = {
    'initializer': '_ZN20InferenceSessionWrap11InitOrtOnceERKN4Napi12CallbackInfoE',
    'singleton-create': '_ZN16OrtSingletonData10OrtObjectsC2Ei',
    'singleton-destroy': '_ZN16OrtSingletonData10OrtObjectsD2Ev',
    'session-dispose': '_ZN20InferenceSessionWrap7DisposeERKN4Napi12CallbackInfoE',
    'session-finalize': '_ZN20InferenceSessionWrapD2Ev',
    'instance-finalize': '_ZZNK4Napi3Env15SetInstanceDataI15OrtInstanceDataXadL_ZNS0_11DefaultFiniIS2_EEvS0_PT_EEEEvS5_ENUlP10napi_env__PvS8_E_4_FUNES7_S8_S8_',
}
ownership_sequence = 0
ownership_call = 0
ownership_pins = {}

def ownership_record(row):
    global ownership_sequence
    ownership_sequence += 1
    print('PC_NATIVE_OWNERSHIP\t' + json.dumps(dict(row, sequence=ownership_sequence)), flush=True)

class OwnershipReturn(gdb.FinishBreakpoint):
    def __init__(self, row):
        super().__init__(gdb.newest_frame(), internal=True)
        self.row = row
    def stop(self):
        ownership_record(dict(self.row, event='return'))
        return False
    def out_of_scope(self):
        ownership_record(dict(self.row, event='unwound'))

class OwnershipEntry(gdb.Breakpoint):
    def __init__(self, operation, symbol):
        super().__init__(symbol, internal=True)
        self.operation = operation
        self.symbol = symbol
    def stop(self):
        global ownership_call
        try:
            pc = gdb.newest_frame().pc()
            path = gdb.solib_name(pc)
            if not path:
                raise RuntimeError('ownership symbol has no native library')
            if path not in ownership_pins:
                with open(path, 'rb') as source:
                    data = source.read()
                ownership_pins[path] = {'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            ownership_call += 1
            row = {'callId': ownership_call, 'processId': gdb.selected_inferior().pid,
                   'nativeThreadId': gdb.selected_thread().ptid[1], 'operation': self.operation,
                   'symbol': self.symbol, 'programCounter': hex(pc), 'binding': ownership_pins[path]}
            ownership_record(dict(row, event='enter'))
            OwnershipReturn(row)
        except Exception as error:
            ownership_record({'event': 'error', 'message': str(error)})
        return False

if gdb.convenience_variable('pc_native_ownership') is not None:
    gdb.execute('set breakpoint pending on')
    for operation, symbol in ownership_symbols.items():
        OwnershipEntry(operation, symbol)

def native_record(row):
    print('PC_NATIVE_DEBUGGER\t' + json.dumps(row), flush=True)

def native_continue(event):
    global native_pid, native_continued
    pid = gdb.selected_inferior().pid
    if native_pid is None and pid > 0:
        native_pid = pid
        native_record({'event': 'start', 'processId': pid})
    native_continued = True

def native_stop(event):
    global native_signal, native_continued
    native_continued = False
    if isinstance(event, gdb.SignalEvent):
        native_signal = event.stop_signal
        native_record({'event': 'signal', 'processId': gdb.selected_inferior().pid, 'signal': native_signal})
        if native_signal == 'SIGABRT':
            print('PC_NATIVE_BACKTRACE_BEGIN', flush=True)
            gdb.execute('thread apply all bt 40')
            gdb.execute('info sharedlibrary')
            print('PC_NATIVE_BACKTRACE_END', flush=True)

def native_exit(event):
    global native_exited
    native_exited = True
    code = getattr(event, 'exit_code', None)
    native_record({'event': 'exit', 'processId': native_pid, 'exitCode': code,
                  'signal': native_signal if code is None else None, 'signalDelivered': native_continued})

gdb.events.cont.connect(native_continue)
gdb.events.stop.connect(native_stop)
gdb.events.exited.connect(native_exit)
try:
    gdb.execute('run')
    for attempt in range(4):
        if native_exited:
            break
        if native_signal != 'SIGABRT':
            raise RuntimeError('unexpected native debugger stop')
        gdb.execute('continue')
    if not native_exited:
        raise RuntimeError('native debugger did not observe process exit')
except Exception as error:
    native_record({'event': 'error', 'message': str(error)})
end
