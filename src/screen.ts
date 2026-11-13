import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';
import { Clipboard } from './clipboard.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { deflate, crc32 } from 'node:zlib';
import { ByteQueue } from './bytes.ts';
import { encodeJpeg } from './jpeg.ts';

/**
 * 화면 제어 — 같은 사무실 네트워크의 PC·폰에서 이 PC 화면을 보고 마우스·키보드로 조작한다.
 *  - 원격 접속과 따로 켜고 끈다(기본 꺼짐). 원격 접속처럼 비밀번호·권한 구분은 없다.
 *  - Windows: src/screen-helper.cs 를 csc.exe(.NET Framework 4, Windows 기본)로 컴파일해 띄운다. 프레임 = JPEG.
 *  - 리눅스(X11): src/screen-helper-x11.py 를 python3 로 띄운다(ctypes + libX11·libXtst). 프레임 = 날 픽셀 → 여기서 줄여 PNG.
 *  - 리눅스(GNOME Wayland): src/screen-helper-grd.ts — GNOME 자체 원격 데스크톱(gnome-remote-desktop)의 RDP 를 grdctl 로 켜고(sudo 없음)
 *    직접 짠 RDP 클라이언트(src/rdp)로 127.0.0.1 에 붙는다. 허용 창 없음. 아이디·비밀번호는 data/screen-rdp.json.
 *    (GNOME 50 의 원격 데스크톱에는 VNC 가 없고 RDP 만 있다 — 2026-11-12 확인)
 *    GNOME 46+ 는 화면 공유를 포털(사람이 허용 창을 누름)과 GNOME 원격 데스크톱만 쓰게 막아서, 허용 창 없이 하는 길은 이것뿐이다.
 *  - 리눅스(그 밖의 Wayland: KDE 등): 아직 없음(허용 창 없이 들어가는 길이 없어 넣지 않았다).
 *  - 모두 따로 설치할 것 없음. 도우미는 같은 줄 명령·프레임 형식만 지키면 바꿔 끼울 수 있다.
 *  - Windows 관리자 확인 창(보안 데스크톱)·잠금 화면은 관리자 권한 없이 찍지도 누르지도 못한다 → 프레임 대신 'secure'.
 *  - 누가 보고 있으면(최근 3초 안에 프레임 요청) 이 PC 화면 위에 "원격으로 화면 보는 중" 띠를 띄운다.
 */
export interface Monitor { x: number; y: number; w: number; h: number; primary: boolean }
export type Frame = { kind: 'image'; type: 'image/jpeg' | 'image/png'; data: Buffer } | { kind: 'secure'; message?: string };

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const VIEW_WINDOW = 3000; // 이 시간 안에 프레임을 받아 간 화면 = 보고 있는 사람
const IDLE_EXIT = 60_000; // 아무도 안 보면 도우미를 끈다(Agent Hub 가 푼 화면 잠금도 이때 다시 잠근다)
const ASK_TIMEOUT = 20_000; // 도우미 답을 기다리는 최대 시간
const NO_ANSWER = '화면 도우미가 답하지 않음';
const execAsync = promisify(execFile);
const deflateAsync = promisify(deflate);
const NO_DESKTOP = '데스크톱 화면이 없는 곳에서 켠 Agent Hub. 데스크톱에 로그인한 뒤 그 안에서 켜세요';

/** 이 PC 에서 화면 제어를 쓸 수 있는가 — 안 되면 그 까닭 */
function hasGrdRdp(): boolean {
  const r = spawnSync('grdctl', ['--help'], { timeout: 5000 });
  return !r.error && /\brdp\b/i.test(String(r.stdout) + String(r.stderr));
}

function platformCheck(winSource: string, x11Source: string, grdSource: string): { kind: Kind; reason: string | null } {
  if (process.platform === 'win32') {
    if (!existsSync(CSC) || !existsSync(winSource)) return { kind: null, reason: '이 PC 에서 C# 컴파일러(.NET Framework 4)를 찾지 못함' };
    return { kind: 'win', reason: null };
  }
  if (process.platform === 'linux') {
    // Wayland(또는 DISPLAY 없이 데스크톱 세션 버스만 있는 경우): GNOME 원격 데스크톱(RDP)
    const wayland = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
    const sessionBus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS) || (process.env.XDG_RUNTIME_DIR ? existsSync(join(process.env.XDG_RUNTIME_DIR, 'bus')) : false);
    if (wayland || (!process.env.DISPLAY && sessionBus)) {
      if (!sessionBus) return { kind: null, reason: NO_DESKTOP };
      if (!hasGrdRdp()) return { kind: null, reason: 'GNOME 원격 데스크톱(gnome-remote-desktop)이 없음. GNOME 이 아닌 Wayland 는 아직 안 됨' };
      if (!existsSync(grdSource)) return { kind: null, reason: '화면 도우미 파일 없음' };
      return { kind: 'grd', reason: null }; // 허용 창 없이
    }
    if (!process.env.DISPLAY) return { kind: null, reason: NO_DESKTOP };
    const r = spawnSync('python3', ['-c', 'import ctypes.util as u,sys;sys.exit(0 if u.find_library("X11") else 1)'], { timeout: 5000 });
    if (r.error || r.status !== 0) return { kind: null, reason: r.error ? 'python3 를 찾지 못함' : 'libX11 을 찾지 못함' };
    if (!existsSync(x11Source)) return { kind: null, reason: '화면 도우미 파일 없음' };
    return { kind: 'x11', reason: null };
  }
  return { kind: null, reason: '이 운영체제에서는 아직 안 됨(Windows·리눅스만)' };
}
type Kind = 'win' | 'x11' | 'grd' | null;

export class ScreenControl {
  private file: string;
  private exe: string;
  private source: string;
  private x11Source: string;
  private grdSource: string;
  private rdpFile: string;
  private kind: Kind;
  private reason: string | null;
  private helperCommand?: string[];
  private s: { enabled: boolean };
  private child: ChildProcess | null = null;
  private stderr = '';
  private buf = new ByteQueue();
  private cache = new Map<string, Frame>(); // 화면이 안 바뀌었을 때(U) 다시 보낼 마지막 그림(모니터·너비·화질별)
  private waiting: { resolve: (r: { t: string; data: Buffer }) => void; reject: (e: Error) => void }[] = [];
  private building: Promise<void> | null = null;
  private viewers = new Map<string, number>();
  private indicatorOn = false;
  private lastUse = 0;
  private timer: NodeJS.Timeout | null = null;
  private loginctl: (args: string[]) => Promise<string>;
  private unlockedByHub = false; // Agent Hub 가 잠금을 풀었으면 다 보고 나서 다시 잠근다
  private unlockTried = 0;
  readonly supported: boolean;
  /** 원격으로 보는 사람과 이 PC 사이 클립보드 글 주고받기 */
  readonly clipboard: Clipboard;
  error: string | null = null;

  /**
   * source: screen-helper.cs, x11Source: screen-helper-x11.py(기본 = 같은 폴더).
   * 시험용: helperCommand = 이 명령을 도우미로 띄운다, loginctl = 잠금 풀기·잠그기 명령 대신
   */
  constructor(opts: { file: string; binDir: string; source: string; x11Source?: string; helperCommand?: string[]; loginctl?: (args: string[]) => Promise<string> }) {
    this.loginctl = opts.loginctl ?? (async (args) => String((await execAsync('loginctl', args, { timeout: 8000 })).stdout));
    this.file = opts.file;
    this.exe = join(opts.binDir, 'screen-helper.exe');
    this.source = opts.source;
    this.x11Source = opts.x11Source ?? join(dirname(opts.source), 'screen-helper-x11.py');
    this.grdSource = join(dirname(opts.source), 'screen-helper-grd.ts');
    this.rdpFile = join(dirname(opts.file), 'screen-rdp.json');
    this.clipboard = new Clipboard({ script: join(dirname(opts.source), 'clipboard-x11.py') });
    this.helperCommand = opts.helperCommand;
    const c = opts.helperCommand ? { kind: null, reason: null } : platformCheck(this.source, this.x11Source, this.grdSource);
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
    if (!v.enabled) {
      this.stop();
      // GNOME 원격 데스크톱의 RDP 도 닫는다 — Agent Hub 가 켠 경우만(사람이 원래 켜 두었으면 그대로)
      if (this.kind === 'grd') {
        let byHub = false;
        try { byHub = JSON.parse(readFileSync(this.rdpFile, 'utf8')).enabledByHub === true; } catch {}
        if (byHub) execFile('grdctl', ['rdp', 'disable'], { timeout: 15000 }, () => {});
      }
    }
  }

  /** 모니터 목록. timeoutMs 안에 답이 없으면 빈 목록(도우미가 연결을 기다리는 동안 상태 확인까지 멈추지 않게) */
  async monitors(timeoutMs = ASK_TIMEOUT): Promise<Monitor[]> {
    let r;
    try {
      r = await this.ask('info', timeoutMs);
    } catch (err) {
      if ((err as Error).message === NO_ANSWER) return [];
      throw err;
    }
    if (r.t !== 'J') throw new Error(r.data.toString('utf8'));
    return JSON.parse(r.data.toString('utf8')).monitors;
  }

  /** 한 장. viewer = 화면마다 정한 임의 id(보고 있는 사람 수·표시 띠) */
  async frame(monitor: number, width: number, quality: number, viewer: string): Promise<Frame> {
    this.viewers.set(viewer.slice(0, 40) || '?', Date.now());
    this.syncIndicator();
    const w = int(width, 160, 7680), m = int(monitor, 0, 15), q = int(quality, 20, 95);
    const key = `${m}:${w}:${q}`;
    let r = await this.ask(`frame ${m} ${w} ${q}`);
    // U = 지난번과 같은 화면(리눅스 GNOME) — 만들어 둔 그림을 다시 쓴다. 없으면(다른 너비) 새로 받는다
    if (r.t === 'U') {
      const hit = this.cache.get(key);
      if (hit) return hit;
      r = await this.ask(`frame ${m} ${w} ${q} force`);
    }
    if (r.t === 'F') return { kind: 'image', type: 'image/jpeg', data: r.data };
    if (r.t === 'R') {
      const f: Frame = { kind: 'image', type: 'image/jpeg', data: rawToJpeg(r.data, w, q) };
      if (this.cache.size > 8) this.cache.clear();
      this.cache.set(key, f);
      return f;
    }
    if (r.t === 'S') return { kind: 'secure', message: r.data.toString('utf8') || undefined };
    if (r.t === 'K') return { kind: 'secure', message: await this.unlockForView() };
    throw new Error(r.data.toString('utf8') || '화면을 찍지 못함');
  }

  /**
   * 화면이 잠겨 있다(리눅스 GNOME — 잠금 화면에서는 원격 연결이 막힌다): 이 계정의 세션 잠금을 푼다(loginctl, sudo 없음).
   * 푼 것은 다 보고 나서(1분 동안 아무도 안 보면·화면 제어를 끄면) 다시 잠근다. 10초에 한 번만 시도.
   */
  private async unlockForView(): Promise<string> {
    if (Date.now() - this.unlockTried < 10_000) return '화면 잠금을 푸는 중';
    this.unlockTried = Date.now();
    if (await this.sessions('unlock-session')) {
      this.unlockedByHub = true;
      return '화면 잠금을 푸는 중';
    }
    return '화면이 잠겨 있고 풀지 못함 — PC 앞에서 풀어 주세요';
  }

  /** Agent Hub 가 푼 잠금이면 다시 잠근다 */
  private relock() {
    if (!this.unlockedByHub) return;
    this.unlockedByHub = false;
    void this.sessions('lock-session');
  }

  /** 이 계정의 그래픽 세션(wayland·x11)에 loginctl 명령. 하나라도 되면 true */
  private async sessions(verb: 'unlock-session' | 'lock-session'): Promise<boolean> {
    let ok = false;
    try {
      const me = userInfo().username;
      for (const line of (await this.loginctl(['list-sessions', '--no-legend'])).split('\n')) {
        const [id, , user] = line.trim().split(/\s+/);
        if (!id || user !== me) continue;
        const type = (await this.loginctl(['show-session', id, '-p', 'Type', '--value']).catch(() => '')).trim();
        if (type !== 'wayland' && type !== 'x11') continue;
        try { await this.loginctl([verb, id]); ok = true; } catch {}
      }
    } catch {}
    return ok;
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
    this.relock();
    this.indicatorOn = false;
    this.viewers.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin?.end(); } catch {} setTimeout(() => { try { c.kill(); } catch {} }, 1000).unref(); }
    this.fail(new Error('화면 제어를 끔'));
  }

  // ── 도우미 ──
  /**
   * 도우미에게 묻고 답을 기다린다(최대 timeoutMs). 시간이 지나도 줄 순서는 지켜야 해서 대기 자리는 남겨 두고,
   * 늦게 온 답은 그 자리가 받아 버린다.
   */
  private async ask(line: string, timeoutMs = ASK_TIMEOUT): Promise<{ t: string; data: Buffer }> {
    if (!this.enabled) throw new Error('화면 제어가 꺼져 있음');
    await this.ensure();
    this.lastUse = Date.now();
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) return reject(new Error(this.error ?? '화면 도우미가 끝남'));
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(NO_ANSWER)); } }, timeoutMs);
      this.waiting.push({
        resolve: (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } },
        reject: (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
      });
      this.child.stdin.write(line + '\n');
    });
  }

  private async ensure() {
    if (!this.enabled) throw new Error('화면 제어가 꺼져 있음');
    if (this.child) return;
    let cmd = this.helperCommand;
    if (!cmd && this.kind === 'x11') cmd = ['python3', this.x11Source];
    if (!cmd && this.kind === 'grd') cmd = [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', this.grdSource, this.rdpFile];
    if (!cmd) {
      await this.build();
      cmd = [this.exe];
    }
    if (this.child) return;
    const c = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = c;
    this.buf.clear();
    this.cache.clear();
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
    this.buf.push(d);
    for (;;) {
      const head = this.buf.peek(5);
      if (!head) break;
      const n = head.readInt32LE(1);
      if (this.buf.length < 5 + n) break;
      const t = String.fromCharCode(head[0]);
      this.buf.take(5);
      const data = this.buf.take(n)!;
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
      this.relock();
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

/** 날 픽셀 → JPEG(리눅스 화면 제어가 쓰는 것 — PNG 보다 5~10배 작다) */
export function rawToJpeg(raw: Buffer, maxW: number, quality: number): Buffer {
  const { rgb, tw, th } = scaleRaw(raw, maxW);
  return encodeJpeg(rgb, tw, th, quality);
}

/** 날 픽셀 → PNG(손실 없음, 시험·비교용) */
export async function rawToPng(raw: Buffer, maxW: number): Promise<Buffer> {
  const { rgb, tw, th } = scaleRaw(raw, maxW);
  return encodePng(rgb, tw, th);
}

/** 내용: <IIIii> 너비, 높이, 한 줄 바이트, 커서 x, 커서 y(밖이면 -1) + BGRX → 화면 너비로 줄이고 커서를 그린 RGB */
function scaleRaw(raw: Buffer, maxW: number): { rgb: Buffer; tw: number; th: number } {
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
  return { rgb, tw, th };
}

async function encodePng(rgb: Buffer, tw: number, th: number): Promise<Buffer> {
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
