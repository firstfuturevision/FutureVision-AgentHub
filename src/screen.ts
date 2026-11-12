import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { deflate, crc32 } from 'node:zlib';

/**
 * 화면 제어 — 같은 사무실 네트워크의 PC·폰에서 이 PC 화면을 보고 마우스·키보드로 조작한다.
 *  - 원격 접속과 따로 켜고 끈다(기본 꺼짐). 원격 접속처럼 비밀번호·권한 구분은 없다.
 *  - Windows: src/screen-helper.cs 를 csc.exe(.NET Framework 4, Windows 기본)로 컴파일해 띄운다. 프레임 = JPEG.
 *  - 리눅스(X11): src/screen-helper-x11.py 를 python3 로 띄운다(ctypes + libX11·libXtst). 프레임 = 날 픽셀 → 여기서 줄여 PNG.
 *    Wayland 세션은 화면을 찍을 수 없어 안 된다(로그인 화면에서 Xorg 세션).
 *  - 둘 다 따로 설치할 것 없음. 도우미는 같은 줄 명령·프레임 형식만 지키면 바꿔 끼울 수 있다.
 *  - Windows 관리자 확인 창(보안 데스크톱)·잠금 화면은 관리자 권한 없이 찍지도 누르지도 못한다 → 프레임 대신 'secure'.
 *  - 누가 보고 있으면(최근 3초 안에 프레임 요청) 이 PC 화면 위에 "원격으로 화면 보는 중" 띠를 띄운다.
 */
export interface Monitor { x: number; y: number; w: number; h: number; primary: boolean }
export type Frame = { kind: 'image'; type: 'image/jpeg' | 'image/png'; data: Buffer } | { kind: 'secure' };

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const VIEW_WINDOW = 3000; // 이 시간 안에 프레임을 받아 간 화면 = 보고 있는 사람
const IDLE_EXIT = 60_000; // 아무도 안 보면 도우미를 끈다
const deflateAsync = promisify(deflate);
const WAYLAND = 'Wayland 세션은 안 됨. 로그인 화면에서 Xorg 세션을 고르세요';

/** 이 PC 에서 화면 제어를 쓸 수 있는가 — 안 되면 그 까닭 */
function platformCheck(winSource: string, x11Source: string): { kind: 'win' | 'x11' | null; reason: string | null } {
  if (process.platform === 'win32') {
    if (!existsSync(CSC) || !existsSync(winSource)) return { kind: null, reason: '이 PC 에서 C# 컴파일러(.NET Framework 4)를 찾지 못함' };
    return { kind: 'win', reason: null };
  }
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY) return { kind: null, reason: process.env.WAYLAND_DISPLAY ? WAYLAND : '데스크톱 화면(DISPLAY)이 없는 곳에서 켠 Agent Hub. 데스크톱에 로그인해서 켜세요' };
    if (process.env.XDG_SESSION_TYPE === 'wayland') return { kind: null, reason: WAYLAND };
    const r = spawnSync('python3', ['-c', 'import ctypes.util as u,sys;sys.exit(0 if u.find_library("X11") else 1)'], { timeout: 5000 });
    if (r.error || r.status !== 0) return { kind: null, reason: r.error ? 'python3 를 찾지 못함' : 'libX11 을 찾지 못함' };
    if (!existsSync(x11Source)) return { kind: null, reason: '화면 도우미 파일 없음' };
    return { kind: 'x11', reason: null };
  }
  return { kind: null, reason: '이 운영체제에서는 아직 안 됨(Windows·리눅스만)' };
}

export class ScreenControl {
  private file: string;
  private exe: string;
  private source: string;
  private x11Source: string;
  private kind: 'win' | 'x11' | null;
  private reason: string | null;
  private helperCommand?: string[];
  private s: { enabled: boolean };
  private child: ChildProcess | null = null;
  private stderr = '';
  private buf = Buffer.alloc(0);
  private waiting: { resolve: (r: { t: string; data: Buffer }) => void; reject: (e: Error) => void }[] = [];
  private building: Promise<void> | null = null;
  private viewers = new Map<string, number>();
  private indicatorOn = false;
  private lastUse = 0;
  private timer: NodeJS.Timeout | null = null;
  readonly supported: boolean;
  error: string | null = null;

  /** source: screen-helper.cs, x11Source: screen-helper-x11.py(기본 = 같은 폴더). helperCommand: 시험용 — 이 명령을 도우미로 띄운다 */
  constructor(opts: { file: string; binDir: string; source: string; x11Source?: string; helperCommand?: string[] }) {
    this.file = opts.file;
    this.exe = join(opts.binDir, 'screen-helper.exe');
    this.source = opts.source;
    this.x11Source = opts.x11Source ?? join(dirname(opts.source), 'screen-helper-x11.py');
    this.helperCommand = opts.helperCommand;
    const c = opts.helperCommand ? { kind: null, reason: null } : platformCheck(this.source, this.x11Source);
    this.kind = c.kind;
    this.reason = c.reason;
    this.supported = Boolean(opts.helperCommand) || c.kind !== null;
    let v: any = {};
    try { if (existsSync(this.file)) v = JSON.parse(readFileSync(this.file, 'utf8')); } catch {}
    this.s = { enabled: v.enabled === true };
  }

  get enabled() { return this.s.enabled && this.supported; }

  /** 화면에 보낼 상태 */
  public() {
    return { supported: this.supported, reason: this.reason, enabled: this.enabled, viewers: this.viewerCount(), error: this.error };
  }

  set(v: { enabled?: unknown }) {
    if (typeof v.enabled !== 'boolean') throw new Error('enabled 는 true/false');
    if (v.enabled && !this.supported) throw new Error(this.reason ?? '이 PC 에서는 안 됨');
    this.s.enabled = v.enabled;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    if (!v.enabled) this.stop();
  }

  async monitors(): Promise<Monitor[]> {
    const r = await this.ask('info');
    if (r.t !== 'J') throw new Error(r.data.toString('utf8'));
    return JSON.parse(r.data.toString('utf8')).monitors;
  }

  /** 한 장. viewer = 화면마다 정한 임의 id(보고 있는 사람 수·표시 띠) */
  async frame(monitor: number, width: number, quality: number, viewer: string): Promise<Frame> {
    this.viewers.set(viewer.slice(0, 40) || '?', Date.now());
    this.syncIndicator();
    const w = int(width, 160, 7680);
    const r = await this.ask(`frame ${int(monitor, 0, 15)} ${w} ${int(quality, 20, 95)}`);
    if (r.t === 'F') return { kind: 'image', type: 'image/jpeg', data: r.data };
    if (r.t === 'R') return { kind: 'image', type: 'image/png', data: await rawToPng(r.data, w) };
    if (r.t === 'S') return { kind: 'secure' };
    throw new Error(r.data.toString('utf8') || '화면을 찍지 못함');
  }

  /** 마우스·키보드. 좌표는 그 모니터 안 0..1 */
  async input(monitor: number, events: unknown): Promise<number> {
    if (!Array.isArray(events)) throw new Error('events 는 배열');
    await this.ensure();
    const m = int(monitor, 0, 15);
    const lines: string[] = [];
    for (const e of events.slice(0, 200)) {
      const line = toLine(m, e);
      if (line) lines.push(line);
    }
    if (lines.length) this.child?.stdin?.write(lines.join('\n') + '\n');
    this.lastUse = Date.now();
    return lines.length;
  }

  viewerCount() {
    const now = Date.now();
    for (const [k, t] of this.viewers) if (now - t > VIEW_WINDOW) this.viewers.delete(k);
    return this.viewers.size;
  }

  stop() {
    this.indicatorOn = false;
    this.viewers.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin?.end(); } catch {} setTimeout(() => { try { c.kill(); } catch {} }, 1000).unref(); }
    this.fail(new Error('화면 제어를 끔'));
  }

  // ── 도우미 ──
  private async ask(line: string): Promise<{ t: string; data: Buffer }> {
    if (!this.enabled) throw new Error('화면 제어가 꺼져 있음');
    await this.ensure();
    this.lastUse = Date.now();
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) return reject(new Error(this.error ?? '화면 도우미가 끝남'));
      this.waiting.push({ resolve, reject });
      this.child.stdin.write(line + '\n');
    });
  }

  private async ensure() {
    if (!this.enabled) throw new Error('화면 제어가 꺼져 있음');
    if (this.child) return;
    let cmd = this.helperCommand;
    if (!cmd && this.kind === 'x11') cmd = ['python3', this.x11Source];
    if (!cmd) {
      await this.build();
      cmd = [this.exe];
    }
    if (this.child) return;
    const c = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = c;
    this.buf = Buffer.alloc(0);
    this.stderr = '';
    this.error = null;
    c.stdout!.on('data', (d: Buffer) => this.read(d));
    c.stderr!.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-600); });
    c.stdin!.on('error', () => {});
    c.on('error', (err) => { this.error = `화면 도우미를 띄우지 못함: ${err.message}`; });
    c.on('exit', () => {
      if (this.child === c) { this.child = null; this.indicatorOn = false; }
      const why = this.stderr.trim().split('\n').pop();
      if (why) this.error = `화면 도우미가 끝남: ${why}`;
      this.fail(new Error(this.error ?? '화면 도우미가 끝남'));
    });
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  }

  /** 소스가 바뀌었거나 exe 가 없으면 컴파일(Windows) */
  private build(): Promise<void> {
    const fresh = existsSync(this.exe) && statSync(this.exe).mtimeMs >= statSync(this.source).mtimeMs;
    if (fresh) return Promise.resolve();
    if (!this.building) {
      mkdirSync(dirname(this.exe), { recursive: true });
      const tmp = `${this.exe}.${process.pid}.tmp.exe`;
      this.building = new Promise<void>((ok, fail) => {
        execFile(CSC, ['-nologo', '-codepage:65001', '-platform:x64', '-target:winexe', '-optimize+', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', `-out:${tmp}`, this.source], { windowsHide: true }, (err, stdout) => {
          if (err) { this.error = `화면 도우미 컴파일 실패: ${String(stdout).trim().split('\n').slice(-3).join(' ')}`; return fail(new Error(this.error)); }
          try { renameSync(tmp, this.exe); } catch (e) { return fail(e as Error); }
          ok();
        });
      }).finally(() => { this.building = null; });
    }
    return this.building;
  }

  private read(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const n = this.buf.readInt32LE(1);
      if (this.buf.length < 5 + n) break;
      const t = String.fromCharCode(this.buf[0]);
      const data = Buffer.from(this.buf.subarray(5, 5 + n));
      this.buf = this.buf.subarray(5 + n);
      if (t === 'L') continue; // 답을 기다리지 않은 명령의 실패(기록만)
      this.waiting.shift()?.resolve({ t, data });
    }
  }

  private fail(err: Error) {
    for (const w of this.waiting.splice(0)) w.reject(err);
  }

  private syncIndicator() {
    const on = this.viewerCount() > 0;
    if (on === this.indicatorOn || !this.child) return;
    this.indicatorOn = on;
    this.child.stdin?.write(`indicator ${on ? 1 : 0}\n`);
  }

  private tick() {
    this.syncIndicator();
    if (this.child && !this.indicatorOn && Date.now() - this.lastUse > IDLE_EXIT && !this.waiting.length) {
      const c = this.child;
      this.child = null;
      c.stdin?.end();
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  }
}

function int(v: unknown, lo: number, hi: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function unit(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)).toFixed(5) : null;
}

/** 화면에서 온 입력 하나 → 도우미 명령 한 줄(형식이 틀리면 버림) */
export function toLine(m: number, e: any): string | null {
  if (!e || typeof e !== 'object') return null;
  if (e.t === 'key') return `key ${e.d ? 'd' : 'u'} ${int(e.vk, 1, 254)}`;
  if (e.t === 'text') {
    if (typeof e.s !== 'string' || !e.s) return null;
    return `text ${Buffer.from(e.s.slice(0, 2000), 'utf8').toString('base64')}`;
  }
  const x = unit(e.x), y = unit(e.y);
  if (x === null || y === null) return null;
  if (e.t === 'move') return `move ${m} ${x} ${y}`;
  if (e.t === 'down' || e.t === 'up') return `${e.t} ${m} ${x} ${y} ${int(e.b, 0, 2)}`;
  if (e.t === 'wheel') return `wheel ${m} ${x} ${y} ${int(e.dy, -1200, 1200)}`;
  return null;
}

// ── 리눅스 프레임: 날 픽셀(BGRX) → 화면 너비로 줄이고 커서를 그려 PNG ──
// 커서: # 테두리, . 안
const ARROW = [
  '#', '##', '#.#', '#..#', '#...#', '#....#', '#.....#', '#......#', '#.......#', '#........#', '#.....#####', '#..#..#', '#.# #..#', '##  #..#', '#    #..#', '      ##',
];

/** 내용: <IIIii> 너비, 높이, 한 줄 바이트, 커서 x, 커서 y(밖이면 -1) + BGRX */
export async function rawToPng(raw: Buffer, maxW: number): Promise<Buffer> {
  const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4), stride = raw.readUInt32LE(8);
  const cx = raw.readInt32LE(12), cy = raw.readInt32LE(16);
  const px = raw.subarray(20);
  const tw = Math.max(1, Math.min(w, maxW));
  const th = Math.max(1, Math.round((h * tw) / w));
  const rgb = Buffer.alloc(tw * th * 3);
  // 넓이 평균(글자가 깨지지 않게): 대상 한 칸에 들어가는 원본 칸들의 평균
  const xs = new Int32Array(tw + 1);
  for (let x = 0; x <= tw; x++) xs[x] = Math.min(w, Math.floor((x * w) / tw));
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * h) / th), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = xs[x], x1 = Math.max(x0 + 1, xs[x + 1]);
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let o = yy * stride + x0 * 4;
        for (let xx = x0; xx < x1; xx++, o += 4) { b += px[o]; g += px[o + 1]; r += px[o + 2]; }
      }
      const n = (y1 - y0) * (x1 - x0), d = (y * tw + x) * 3;
      rgb[d] = r / n; rgb[d + 1] = g / n; rgb[d + 2] = b / n;
    }
  }
  if (cx >= 0 && cy >= 0) {
    const ox = Math.round((cx * tw) / w), oy = Math.round((cy * th) / h);
    ARROW.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx], X = ox + rx, Y = oy + ry;
        if (ch === ' ' || X >= tw || Y >= th) continue;
        const v = ch === '#' ? 0 : 255, d = (Y * tw + X) * 3;
        rgb[d] = rgb[d + 1] = rgb[d + 2] = v;
      }
    });
  }
  // PNG: 줄마다 Sub 필터(왼쪽 칸과의 차) → deflate
  const line = tw * 3;
  const filtered = Buffer.alloc((line + 1) * th);
  for (let y = 0; y < th; y++) {
    const o = y * (line + 1), s = y * line;
    filtered[o] = 1;
    for (let i = 0; i < line; i++) filtered[o + 1 + i] = (rgb[s + i] - (i >= 3 ? rgb[s + i - 3] : 0)) & 255;
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tw, 0);
  ihdr.writeUInt32BE(th, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8비트 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflateAsync(filtered, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
