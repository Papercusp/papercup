"""Isolated GNOME/VTE reflow probe; never joins the desktop bus or settings.

Run with /usr/bin/python3. The parent owns Xvfb and a private bus with NO service
activation directories (desktop portals otherwise delay renderer registration).
Only the child touches GSettings, in a temporary keyfile backend. JSON on stdout
is measurement evidence; startup errors are failures, never empty samples.
"""
import argparse
import ctypes as C
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import tempfile
import time


BUS_CONFIG = """<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>
<policy context="default"><allow send_destination="*" eavesdrop="true"/>
<allow eavesdrop="true"/><allow own="*"/></policy></busconfig>"""


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


class Data(C.Union):
    _fields_ = [('b', C.c_char * 20), ('s', C.c_short * 10), ('l', C.c_long * 5)]


class Message(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
               ('display', C.c_void_p), ('window', C.c_ulong),
               ('message_type', C.c_ulong), ('format', C.c_int), ('data', Data)]


class Event(C.Union):
    _fields_ = [('xclient', Message), ('pad', C.c_long * 24)]


class X11:
    def __init__(self):
        self.x = C.CDLL('libX11.so.6')
        for name, rest, args in [
            ('XOpenDisplay', C.c_void_p, [C.c_char_p]),
            ('XDefaultRootWindow', C.c_ulong, [C.c_void_p]),
            ('XInternAtom', C.c_ulong, [C.c_void_p, C.c_char_p, C.c_int]),
            ('XPending', C.c_int, [C.c_void_p]),
            ('XNextEvent', C.c_int, [C.c_void_p, C.POINTER(Event)]),
            ('XSendEvent', C.c_int, [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(Event)]),
            ('XFlush', C.c_int, [C.c_void_p]),
            ('XSelectInput', C.c_int, [C.c_void_p, C.c_ulong, C.c_long]),
            ('XResizeWindow', C.c_int, [C.c_void_p, C.c_ulong, C.c_uint, C.c_uint]),
            ('XConnectionNumber', C.c_int, [C.c_void_p]),
            ('XCloseDisplay', C.c_int, [C.c_void_p]),
        ]:
            f = getattr(self.x, name)
            f.restype, f.argtypes = rest, args
        self.d = self.x.XOpenDisplay(None)
        if not self.d:
            raise RuntimeError('private X display did not open')
        self.root = self.x.XDefaultRootWindow(self.d)
        self.protocol = self.x.XInternAtom(self.d, b'WM_PROTOCOLS', 0)
        self.ping = self.x.XInternAtom(self.d, b'_NET_WM_PING', 0)
        self.x.XSelectInput(self.d, self.root, (1 << 19) | (1 << 20))
        self.x.XFlush(self.d)
        self.token = 0

    def measure(self, wid):
        self.token += 1
        e = Event()
        e.xclient.type, e.xclient.display = 33, self.d
        e.xclient.window, e.xclient.message_type, e.xclient.format = wid, self.protocol, 32
        e.xclient.data.l[0], e.xclient.data.l[1], e.xclient.data.l[2] = self.ping, self.token, wid
        start = time.monotonic()
        self.x.XSendEvent(self.d, wid, 0, 0, C.byref(e))
        self.x.XFlush(self.d)
        while time.monotonic() - start < 10:
            while self.x.XPending(self.d):
                z = Event()
                self.x.XNextEvent(self.d, C.byref(z))
                if (z.xclient.type == 33 and z.xclient.message_type == self.protocol
                        and z.xclient.data.l[0] == self.ping
                        and z.xclient.data.l[1] == self.token
                        and z.xclient.data.l[2] == wid):
                    return round((time.monotonic() - start) * 1000, 3)
            select.select([self.x.XConnectionNumber(self.d)], [], [], .001)
        raise RuntimeError('renderer did not answer matching _NET_WM_PING within 10s')

    def resize(self, wid, width):
        self.x.XResizeWindow(self.d, wid, width, 450)
        self.x.XFlush(self.d)


def window(title, client):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if client.poll() is not None:
            try:
                _, errors = client.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                errors = 'client exited but a descendant kept its stderr open'
            raise RuntimeError('terminal client exited before readiness: ' + errors)
        r = subprocess.run(['xdotool', 'search', '--name', title], capture_output=True, text=True, timeout=2)
        if r.returncode == 0:
            return int(r.stdout.strip().splitlines()[-1])
        time.sleep(.05)
    raise RuntimeError('terminal never reached output sentinel: ' + title)


def run_child(args):
    from gi.repository import Gio, GLib
    x = X11()
    try:
        for unlimited in [False, True]:
            ident = '1be264d5-cf8b-4bbe-a9ef-000000000001'
            profiles = Gio.Settings.new('org.gnome.Terminal.ProfilesList')
            profiles.set_strv('list', [ident])
            profiles.set_string('default', ident)
            p = Gio.Settings.new_with_path('org.gnome.Terminal.Legacy.Profile',
                                          '/org/gnome/terminal/legacy/profiles:/:' + ident + '/')
            p.set_string('visible-name', 'Isolated Reflow Probe')
            p.set_boolean('scrollback-unlimited', unlimited)
            p.set_int('scrollback-lines', args.limit)
            Gio.Settings.sync()
            app = 'org.gnome.Terminal.Reflow' + str(os.getpid()) + ('Unlimited' if unlimited else 'Finite')
            server = subprocess.Popen(['/usr/libexec/gnome-terminal-server', '--app-id', app],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            clients = []
            try:
                bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                start, ready = time.monotonic(), False
                while time.monotonic() - start < 10:
                    ready = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                          'org.freedesktop.DBus', 'NameHasOwner',
                                          GLib.Variant('(s)', (app,)), GLib.VariantType.new('(b)'),
                                          Gio.DBusCallFlags.NONE, 500, None).unpack()[0]
                    if ready:
                        break
                    if server.poll() is not None:
                        raise RuntimeError('renderer exited: ' + server.stderr.read())
                    time.sleep(.05)
                if not ready:
                    raise RuntimeError('renderer did not register on private bus within 10s')

                def launch(script):
                    # Ubuntu's Python wrapper also starts a server for --app-id.
                    # Here the fixture already owns the server; call its client.
                    binary = '/usr/bin/gnome-terminal.real' if Path('/usr/bin/gnome-terminal.real').exists() else 'gnome-terminal'
                    client = subprocess.Popen([binary, '--app-id', app, '--profile', ident, '--wait',
                                               '--geometry=100x25', '--', '/usr/bin/python3', '-u', '-c', script],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                    clients.append(client)
                    return client

                writer = "import os,tty;tty.setraw(0)\nline=(''.join('\\x1b[38;5;'+str(i+30)+'mabcdefghij' for i in range(15))+'\\x1b[0m\\r\\n').encode()\n"
                writer += "for _ in range(" + str(args.lines // 1000) + "):os.write(1,line*1000)\n"
                writer += "os.write(1,b'\\x1b]0;REFLOW_LOADED\\x07')\nwhile True:\n b=os.read(0,1);os.write(1,b)"
                big = window('REFLOW_LOADED', launch(writer))
                sibling = window('REFLOW_SIBLING', launch("import os,tty;tty.setraw(0);os.write(1,b'\\x1b]0;REFLOW_SIBLING\\x07')\nwhile True:\n b=os.read(0,1);os.write(1,b)"))
                history_bytes = 0
                for fd in Path('/proc/' + str(server.pid) + '/fd').iterdir():
                    try:
                        target = os.readlink(fd)
                        info = fd.stat()
                        if stat.S_ISREG(info.st_mode) and target.startswith('/tmp/'):
                            history_bytes += info.st_size
                    except FileNotFoundError:
                        pass
                baseline = [x.measure(sibling) for _ in range(5)]
                resize = []
                for width in [500, 1100, 600, 1100]:
                    x.resize(big, width)
                    samples = []
                    for _ in range(50):
                        samples.append(x.measure(sibling))
                        time.sleep(.005)
                    resize.append(max(samples))
                print(json.dumps({'unlimited': unlimited, 'server_pid': server.pid,
                                  'lines': args.lines, 'limit': args.limit,
                                  'history_bytes': history_bytes,
                                  'baseline_ping_ms': baseline,
                                  'sibling_ping_after_resize_ms': resize}), flush=True)
            finally:
                stop(server)
                server.stderr.close()
                for client in clients:
                    stop(client)
                    client.stderr.close()
    finally:
        x.x.XCloseDisplay(x.d)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lines', type=int, default=600000)
    parser.add_argument('--limit', type=int, default=10000)
    parser.add_argument('--child', action='store_true')
    args = parser.parse_args()
    if args.lines < 1000 or args.lines % 1000 or args.limit < 1:
        parser.error('lines must be a positive multiple of 1000 and limit positive')
    if args.child:
        run_child(args)
        return
    with tempfile.TemporaryDirectory(prefix='gnome-reflow-') as td:
        config = Path(td) / 'bus.conf'
        config.write_text(BUS_CONFIG)
        env = dict(os.environ, XDG_CONFIG_HOME=td, GSETTINGS_BACKEND='keyfile',
                   GDK_BACKEND='x11', GTK_USE_PORTAL='0', GIO_USE_VFS='local', NO_AT_BRIDGE='1')
        for key in ['WAYLAND_DISPLAY', 'GNOME_TERMINAL_SCREEN', 'GNOME_TERMINAL_SERVICE', 'DBUS_SESSION_BUS_ADDRESS']:
            env.pop(key, None)
        result = subprocess.run(['xvfb-run', '-a', 'dbus-run-session', '--config-file=' + str(config),
                                 '--', '/usr/bin/python3', str(Path(__file__).resolve()), '--child',
                                 '--lines=' + str(args.lines), '--limit=' + str(args.limit)],
                                env=env, timeout=150)
        if result.returncode:
            raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
