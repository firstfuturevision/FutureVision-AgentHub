#!/usr/bin/env python3
# Agent Hub 화면 도우미(리눅스 X11) — Python 3 표준 라이브러리(ctypes)와 X11 기본 라이브러리만 쓴다. 따로 설치할 것 없음.
# 명령·응답 형식은 screen-helper.cs 와 같다. 다만 프레임은 JPEG 대신 날 픽셀(R)로 보내고 허브(Node)가 줄여 PNG 로 만든다.
#   R 내용: <IIIii> 너비, 높이, 한 줄 바이트, 커서 x, 커서 y(모니터 기준, 밖이면 -1) + BGRX 픽셀
# 필요한 것: libX11, libXtst(입력), libXrandr(모니터 여러 대, 없으면 화면 전체 하나). Wayland 세션에서는 안 된다.
import ctypes
import ctypes.util
import base64
import json
import struct
import sys
import time
from ctypes import c_int, c_uint, c_ulong, c_long, c_char_p, c_void_p, POINTER, byref, Structure

def lib(name, required=True):
    path = ctypes.util.find_library(name)
    if not path:
        if required:
            raise SystemExit('lib%s 없음' % name)
        return None
    return ctypes.CDLL(path)

X = lib('X11')
Xtst = lib('Xtst', False)
Xrr = lib('Xrandr', False)

class XImage(Structure):
    _fields_ = [('width', c_int), ('height', c_int), ('xoffset', c_int), ('format', c_int), ('data', c_void_p),
                ('byte_order', c_int), ('bitmap_unit', c_int), ('bitmap_bit_order', c_int), ('bitmap_pad', c_int),
                ('depth', c_int), ('bytes_per_line', c_int), ('bits_per_pixel', c_int),
                ('red_mask', c_ulong), ('green_mask', c_ulong), ('blue_mask', c_ulong), ('obdata', c_void_p)]

class XRRMonitorInfo(Structure):
    _fields_ = [('name', c_ulong), ('primary', c_int), ('automatic', c_int), ('noutput', c_int),
                ('x', c_int), ('y', c_int), ('width', c_int), ('height', c_int),
                ('mwidth', c_int), ('mheight', c_int), ('outputs', c_void_p)]

class XSetWindowAttributes(Structure):
    _fields_ = [('background_pixmap', c_ulong), ('background_pixel', c_ulong), ('border_pixmap', c_ulong), ('border_pixel', c_ulong),
                ('bit_gravity', c_int), ('win_gravity', c_int), ('backing_store', c_int), ('backing_planes', c_ulong),
                ('backing_pixel', c_ulong), ('save_under', c_int), ('event_mask', c_long), ('do_not_propagate_mask', c_long),
                ('override_redirect', c_int), ('colormap', c_ulong), ('cursor', c_ulong)]

X.XOpenDisplay.restype = c_void_p
X.XOpenDisplay.argtypes = [c_char_p]
X.XDefaultRootWindow.restype = c_ulong
X.XDefaultRootWindow.argtypes = [c_void_p]
X.XDefaultScreen.argtypes = [c_void_p]
X.XDisplayWidth.argtypes = [c_void_p, c_int]
X.XDisplayHeight.argtypes = [c_void_p, c_int]
X.XGetImage.restype = POINTER(XImage)
X.XGetImage.argtypes = [c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_ulong, c_int]
X.XFree.argtypes = [c_void_p]
X.XQueryPointer.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong), POINTER(c_int), POINTER(c_int), POINTER(c_int), POINTER(c_int), POINTER(c_uint)]
X.XKeysymToKeycode.restype = ctypes.c_ubyte
X.XKeysymToKeycode.argtypes = [c_void_p, c_ulong]
X.XFlush.argtypes = [c_void_p]
X.XSync.argtypes = [c_void_p, c_int]
X.XDisplayKeycodes.argtypes = [c_void_p, POINTER(c_int), POINTER(c_int)]
X.XGetKeyboardMapping.restype = POINTER(c_ulong)
X.XGetKeyboardMapping.argtypes = [c_void_p, ctypes.c_ubyte, c_int, POINTER(c_int)]
X.XChangeKeyboardMapping.argtypes = [c_void_p, c_int, c_int, POINTER(c_ulong), c_int]
X.XCreateSimpleWindow.restype = c_ulong
X.XCreateSimpleWindow.argtypes = [c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
X.XChangeWindowAttributes.argtypes = [c_void_p, c_ulong, c_ulong, POINTER(XSetWindowAttributes)]
X.XMapRaised.argtypes = [c_void_p, c_ulong]
X.XUnmapWindow.argtypes = [c_void_p, c_ulong]
X.XRaiseWindow.argtypes = [c_void_p, c_ulong]
X.XDefaultGC.restype = c_void_p
X.XDefaultGC.argtypes = [c_void_p, c_int]
X.XSetForeground.argtypes = [c_void_p, c_void_p, c_ulong]
X.XDrawString.argtypes = [c_void_p, c_ulong, c_void_p, c_int, c_int, c_char_p, c_int]
X.XStoreName.argtypes = [c_void_p, c_ulong, c_char_p]
if Xtst:
    Xtst.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
    Xtst.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
    Xtst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
if Xrr:
    try:
        Xrr.XRRGetMonitors.restype = POINTER(XRRMonitorInfo)
        Xrr.XRRGetMonitors.argtypes = [c_void_p, c_ulong, c_int, POINTER(c_int)]
        Xrr.XRRFreeMonitors.argtypes = [POINTER(XRRMonitorInfo)]
    except AttributeError:
        Xrr = None  # Xrandr 1.5 전

dpy = X.XOpenDisplay(None)
if not dpy:
    raise SystemExit('X 화면에 연결하지 못함(DISPLAY 확인)')
root = X.XDefaultRootWindow(dpy)
scr = X.XDefaultScreen(dpy)
out = sys.stdout.buffer
ZPixmap = 2
AllPlanes = 0xFFFFFFFF

def write(t, data=b''):
    out.write(t.encode() + struct.pack('<i', len(data)) + data)
    out.flush()

def monitors():
    mons = []
    if Xrr:
        n = c_int(0)
        p = Xrr.XRRGetMonitors(dpy, root, 1, byref(n))
        if p:
            for i in range(n.value):
                m = p[i]
                mons.append({'x': m.x, 'y': m.y, 'w': m.width, 'h': m.height, 'primary': bool(m.primary)})
            Xrr.XRRFreeMonitors(p)
    if not mons:
        mons.append({'x': 0, 'y': 0, 'w': X.XDisplayWidth(dpy, scr), 'h': X.XDisplayHeight(dpy, scr), 'primary': True})
    return mons

mons = monitors()

def mon(s):
    try:
        i = int(s)
    except ValueError:
        i = 0
    return mons[i] if 0 <= i < len(mons) else mons[0]

def at(m, xs, ys):
    x = min(1.0, max(0.0, float(xs)))
    y = min(1.0, max(0.0, float(ys)))
    return m['x'] + int(round(x * (m['w'] - 1))), m['y'] + int(round(y * (m['h'] - 1)))

def pointer():
    r, c = c_ulong(), c_ulong()
    rx, ry, wx, wy, mask = c_int(), c_int(), c_int(), c_int(), c_uint()
    X.XQueryPointer(dpy, root, byref(r), byref(c), byref(rx), byref(ry), byref(wx), byref(wy), byref(mask))
    return rx.value, ry.value

def frame(m):
    img = X.XGetImage(dpy, root, m['x'], m['y'], m['w'], m['h'], AllPlanes, ZPixmap)
    if not img:
        write('E', 'XGetImage 실패'.encode())
        return
    try:
        im = img.contents
        if im.bits_per_pixel != 32:
            write('E', ('%d비트 화면은 아직 안 됨' % im.bits_per_pixel).encode())
            return
        px, py = pointer()
        cx, cy = px - m['x'], py - m['y']
        if not (0 <= cx < m['w'] and 0 <= cy < m['h']):
            cx = cy = -1
        data = ctypes.string_at(im.data, im.bytes_per_line * im.height)
        write('R', struct.pack('<IIIii', im.width, im.height, im.bytes_per_line, cx, cy) + data)
    finally:
        X.XFree(ctypes.c_void_p(img.contents.data))
        X.XFree(img)

def need_xtst():
    if not Xtst:
        raise RuntimeError('libXtst 없음 — 보기만 됨')

def move(x, y):
    need_xtst()
    Xtst.XTestFakeMotionEvent(dpy, -1, x, y, 0)

BUTTON = {0: 1, 1: 3, 2: 2}  # 왼·오른·가운데 → X 버튼

# 윈도우 가상 키 코드 → X keysym
VK = {8: 0xff08, 9: 0xff09, 13: 0xff0d, 16: 0xffe1, 17: 0xffe3, 18: 0xffe9, 19: 0xff13, 20: 0xffe5, 21: 0xff31, 25: 0xff34, 27: 0xff1b,
      32: 0x20, 33: 0xff55, 34: 0xff56, 35: 0xff57, 36: 0xff50, 37: 0xff51, 38: 0xff52, 39: 0xff53, 40: 0xff54, 44: 0xff61, 45: 0xff63, 46: 0xffff,
      91: 0xffeb, 92: 0xffec, 93: 0xff67, 106: 0xffaa, 107: 0xffab, 109: 0xffad, 110: 0xffae, 111: 0xffaf, 144: 0xff7f, 145: 0xff14,
      160: 0xffe1, 161: 0xffe2, 162: 0xffe3, 163: 0xffe4, 164: 0xffe9, 165: 0xffea,
      186: 0x3b, 187: 0x3d, 188: 0x2c, 189: 0x2d, 190: 0x2e, 191: 0x2f, 192: 0x60, 219: 0x5b, 220: 0x5c, 221: 0x5d, 222: 0x27}
for i in range(26):
    VK[65 + i] = 0x61 + i
for i in range(10):
    VK[48 + i] = 0x30 + i
    VK[96 + i] = 0xffb0 + i
for i in range(24):
    VK[112 + i] = 0xffbe + i

def key(down, vk):
    need_xtst()
    ks = VK.get(vk)
    if not ks:
        return
    kc = X.XKeysymToKeycode(dpy, ks)
    if kc:
        Xtst.XTestFakeKeyEvent(dpy, kc, 1 if down else 0, 0)

# 글자 그대로 넣기: 쓰지 않는 키 하나를 그 글자로 바꿔 누른다(xdotool 방식)
spare = None
def find_spare():
    lo, hi = c_int(), c_int()
    X.XDisplayKeycodes(dpy, byref(lo), byref(hi))
    per = c_int()
    count = hi.value - lo.value + 1
    km = X.XGetKeyboardMapping(dpy, lo.value, count, byref(per))
    found = None
    for i in range(count - 1, -1, -1):
        if all(km[i * per.value + j] == 0 for j in range(per.value)):
            found = lo.value + i
            break
    X.XFree(km)
    return found

def text(s):
    global spare
    need_xtst()
    if spare is None:
        spare = find_spare() or 0
    for ch in s:
        if ch == '\r':
            continue
        cp = ord(ch)
        ks = 0xff0d if ch == '\n' else (cp if 0x20 <= cp <= 0x7e or 0xa0 <= cp <= 0xff else 0x01000000 | cp)
        kc = 0
        if ch == '\n' or (0x30 <= cp <= 0x39) or (0x61 <= cp <= 0x7a) or ch == ' ':
            kc = X.XKeysymToKeycode(dpy, ks)
        if not kc:
            if not spare:
                continue
            arr = (c_ulong * 2)(ks, ks)
            X.XChangeKeyboardMapping(dpy, spare, 2, arr, 1)
            X.XSync(dpy, 0)
            time.sleep(0.012)  # 앱이 바뀐 자판을 읽을 틈
            kc = spare
        Xtst.XTestFakeKeyEvent(dpy, kc, 1, 0)
        Xtst.XTestFakeKeyEvent(dpy, kc, 0, 0)
        X.XSync(dpy, 0)

# 이 PC 화면 위 가운데 작은 띠(창 관리자를 거치지 않는 맨 위 창)
bar = None
bar_on = False
def indicator(on):
    global bar, bar_on
    if on and not bar:
        m = mons[0]
        for x in mons:
            if x['primary']:
                m = x
        w, h = 150, 20
        bar = X.XCreateSimpleWindow(dpy, root, m['x'] + (m['w'] - w) // 2, m['y'], w, h, 0, 0, 0xC96442)
        a = XSetWindowAttributes()
        a.override_redirect = 1
        X.XChangeWindowAttributes(dpy, bar, 1 << 9, byref(a))  # CWOverrideRedirect
        X.XStoreName(dpy, bar, b'Agent Hub')
    if not bar:
        return
    if on:
        X.XMapRaised(dpy, bar)
        draw_bar()
    else:
        X.XUnmapWindow(dpy, bar)
    bar_on = on
    X.XFlush(dpy)

def draw_bar():
    if bar:
        gc = X.XDefaultGC(dpy, scr)
        X.XSetForeground(dpy, gc, 0xFFFFFF)
        label = b'REMOTE VIEW'
        X.XDrawString(dpy, bar, gc, 42, 14, label, len(label))

def handle(a):
    global mons
    c = a[0]
    if c == 'info':
        mons = monitors()
        write('J', json.dumps({'monitors': mons}).encode())
    elif c == 'frame':
        if bar_on:
            X.XRaiseWindow(dpy, bar)
            draw_bar()
        frame(mon(a[1]))
    elif c == 'move':
        move(*at(mon(a[1]), a[2], a[3]))
    elif c in ('down', 'up'):
        b = int(a[4])
        if b not in BUTTON:
            return
        move(*at(mon(a[1]), a[2], a[3]))
        Xtst.XTestFakeButtonEvent(dpy, BUTTON[b], 1 if c == 'down' else 0, 0)
    elif c == 'wheel':
        move(*at(mon(a[1]), a[2], a[3]))
        dy = int(a[4])
        btn = 4 if dy > 0 else 5
        for _ in range(min(10, max(1, abs(dy) // 120 or 1))):
            Xtst.XTestFakeButtonEvent(dpy, btn, 1, 0)
            Xtst.XTestFakeButtonEvent(dpy, btn, 0, 0)
    elif c == 'key':
        vk = int(a[2])
        if 0 < vk < 255:
            key(a[1] == 'd', vk)
    elif c == 'text':
        text(base64.b64decode(a[1]).decode('utf-8', 'replace'))
    elif c == 'indicator':
        indicator(a[1] == '1')
    X.XFlush(dpy)

for line in sys.stdin.buffer:
    parts = line.decode('ascii', 'replace').strip().split(' ')
    if not parts or not parts[0]:
        continue
    try:
        handle(parts)
    except Exception as e:  # 한 명령이 틀려도 도우미는 계속. 답을 기다리는 명령(info·frame)만 E, 나머지는 L(기록만)
        write('E' if parts[0] in ('info', 'frame') else 'L', str(e).encode())
