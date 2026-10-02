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
import gdb, json
native_pid = None
native_signal = None
native_continued = False
native_exited = False

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
