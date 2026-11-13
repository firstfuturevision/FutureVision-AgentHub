#!/usr/bin/env python3
# Agent Hub 클립보드 도우미(리눅스) — Python 3 표준 라이브러리(ctypes)와 libX11 만 쓴다. 따로 설치할 것 없음.
# X11 세션, 그리고 GNOME Wayland(XWayland 가 Wayland 클립보드와 이어 준다) 둘 다에서 된다.
#   get   : CLIPBOARD 의 글을 UTF-8 로 표준 출력에 쓴다(비었으면 빈 출력)
#   serve : 표준 입력의 글을 CLIPBOARD 에 올리고 "ok" 한 줄을 쓴 뒤, 다른 프로그램이 클립보드를 가져갈 때까지(최대 1시간)
#           붙여 넣기 요청에 답한다. X 클립보드는 가진 프로그램이 살아 있어야 붙여 넣을 수 있다.
import ctypes
import ctypes.util
import sys
import time
from ctypes import c_int, c_uint, c_ulong, c_long, c_char_p, c_void_p, POINTER, byref, Structure, Union

path = ctypes.util.find_library('X11')
if not path:
    sys.stderr.write('libX11 없음\n')
    sys.exit(2)
X = ctypes.CDLL(path)

Window = Atom = Time = c_ulong
X.XOpenDisplay.restype = c_void_p
X.XOpenDisplay.argtypes = [c_char_p]
X.XDefaultRootWindow.restype = Window
X.XDefaultRootWindow.argtypes = [c_void_p]
X.XCreateSimpleWindow.restype = Window
X.XCreateSimpleWindow.argtypes = [c_void_p, Window, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
X.XInternAtom.restype = Atom
X.XInternAtom.argtypes = [c_void_p, c_char_p, c_int]
X.XConvertSelection.argtypes = [c_void_p, Atom, Atom, Atom, Window, Time]
X.XSetSelectionOwner.argtypes = [c_void_p, Atom, Window, Time]
X.XGetSelectionOwner.restype = Window
X.XGetSelectionOwner.argtypes = [c_void_p, Atom]
X.XPending.argtypes = [c_void_p]
X.XNextEvent.argtypes = [c_void_p, c_void_p]
X.XFlush.argtypes = [c_void_p]
X.XFree.argtypes = [c_void_p]
X.XGetWindowProperty.argtypes = [c_void_p, Window, Atom, c_long, c_long, c_int, Atom,
                                 POINTER(Atom), POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong), POINTER(c_void_p)]
X.XChangeProperty.argtypes = [c_void_p, Window, Atom, Atom, c_int, c_int, c_void_p, c_int]
X.XSendEvent.argtypes = [c_void_p, Window, c_int, c_long, c_void_p]
X.XDeleteProperty.argtypes = [c_void_p, Window, Atom]

SelectionClear, SelectionRequest, SelectionNotify = 29, 30, 31

class XSelectionRequestEvent(Structure):
    _fields_ = [('type', c_int), ('serial', c_ulong), ('send_event', c_int), ('display', c_void_p), ('owner', Window),
                ('requestor', Window), ('selection', Atom), ('target', Atom), ('property', Atom), ('time', Time)]

class XSelectionEvent(Structure):
    _fields_ = [('type', c_int), ('serial', c_ulong), ('send_event', c_int), ('display', c_void_p),
                ('requestor', Window), ('selection', Atom), ('target', Atom), ('property', Atom), ('time', Time)]

class XEvent(Union):
    _fields_ = [('type', c_int), ('xselectionrequest', XSelectionRequestEvent), ('xselection', XSelectionEvent), ('pad', c_long * 24)]

dpy = X.XOpenDisplay(None)
if not dpy:
    sys.stderr.write('X 화면에 연결 못 함(DISPLAY · XAUTHORITY 확인)\n')
    sys.exit(3)
win = X.XCreateSimpleWindow(dpy, X.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0)
atom = lambda n: X.XInternAtom(dpy, n.encode(), 0)
CLIPBOARD, UTF8, STRING, TEXT, TARGETS, INCR, ATOM = (atom(n) for n in ('CLIPBOARD', 'UTF8_STRING', 'STRING', 'TEXT', 'TARGETS', 'INCR', 'ATOM'))
PROP = atom('AGENT_HUB_CLIP')

def wait(kind, seconds):
    ev = XEvent()
    end = time.time() + seconds
    while time.time() < end:
        while X.XPending(dpy):
            X.XNextEvent(dpy, byref(ev))
            if ev.type == kind:
                return ev
        time.sleep(0.01)
    return None

def get():
    if not X.XGetSelectionOwner(dpy, CLIPBOARD):
        return b''
    X.XConvertSelection(dpy, CLIPBOARD, UTF8, PROP, win, 0)
    X.XFlush(dpy)
    ev = wait(SelectionNotify, 3)
    if ev is None:
        raise SystemExit('클립보드가 답하지 않음')
    if ev.xselection.property == 0:
        return b''  # 글이 아닌 것(그림 등)만 있음
    t, f, n, after, data = Atom(), c_int(), c_ulong(), c_ulong(), c_void_p()
    X.XGetWindowProperty(dpy, win, PROP, 0, 1 << 22, 1, 0, byref(t), byref(f), byref(n), byref(after), byref(data))
    try:
        if t.value == INCR:
            raise SystemExit('클립보드 글이 너무 김')
        return ctypes.string_at(data, n.value) if data and f.value == 8 else b''
    finally:
        if data:
            X.XFree(data)

def serve(text):
    X.XSetSelectionOwner(dpy, CLIPBOARD, win, 0)
    X.XFlush(dpy)
    if X.XGetSelectionOwner(dpy, CLIPBOARD) != win:
        raise SystemExit('클립보드를 가져오지 못함')
    sys.stdout.write('ok\n')
    sys.stdout.flush()
    targets = (Atom * 4)(TARGETS, UTF8, STRING, TEXT)
    ev = XEvent()
    end = time.time() + 3600
    while time.time() < end:
        if not X.XPending(dpy):
            time.sleep(0.05)
            continue
        X.XNextEvent(dpy, byref(ev))
        if ev.type == SelectionClear:
            return  # 다른 프로그램이 클립보드를 가져감
        if ev.type != SelectionRequest:
            continue
        r = ev.xselectionrequest
        prop = r.property or r.target
        if r.target == TARGETS:
            X.XChangeProperty(dpy, r.requestor, prop, ATOM, 32, 0, targets, 4)
        elif r.target in (UTF8, STRING, TEXT):
            X.XChangeProperty(dpy, r.requestor, prop, UTF8 if r.target != STRING else STRING, 8, 0, text, len(text))
        else:
            prop = 0  # 모르는 형식
        reply = XEvent()
        reply.xselection.type = SelectionNotify
        reply.xselection.requestor = r.requestor
        reply.xselection.selection = r.selection
        reply.xselection.target = r.target
        reply.xselection.property = prop
        reply.xselection.time = r.time
        X.XSendEvent(dpy, r.requestor, 0, 0, byref(reply))
        X.XFlush(dpy)

mode = sys.argv[1] if len(sys.argv) > 1 else ''
if mode == 'get':
    sys.stdout.buffer.write(get())
elif mode == 'serve':
    serve(sys.stdin.buffer.read())
else:
    sys.stderr.write('쓰는 법: clipboard-x11.py get | serve\n')
    sys.exit(1)
