// Agent Hub 화면 도우미(리눅스 GNOME Wayland) — GNOME 자체 원격 데스크톱(gnome-remote-desktop)의 RDP 를 켜고 그 화면에 붙는다.
// GNOME 46+ 는 화면 공유를 포털(사람이 허용 창을 누름)이나 GNOME 원격 데스크톱만 쓰게 막아 두어서, 허용 창 없이 하려면 이 길뿐이다.
// GNOME 50 의 원격 데스크톱에는 VNC 가 없고 RDP 만 있다(2026-11-12 확인) → 직접 짠 RDP 클라이언트(src/rdp)로 붙는다.
//  - 켜기: grdctl(sudo 없음, 사용자 세션의 데스크톱 공유)로 TLS 인증서·아이디·비밀번호·조작 허용을 정하고 RDP 를 켠 뒤 서비스를 띄운다.
//    이미 사람이 원격 데스크톱을 켜 두었으면 그 아이디·비밀번호를 그대로 쓴다(바꾸면 그 사람의 접속이 깨진다).
//  - 명령·응답 형식은 screen-helper.cs 와 같다. 프레임은 날 픽셀(R) → 허브가 PNG. 커서는 마지막 마우스 자리에 허브가 그린다.
//  - 화면이 잠겨 있으면 GNOME 이 원격 연결을 막는다 → 붙지 않고 K(잠김)로 바로 알린다. 잠금 풀기·다시 잠그기는 허브(ScreenControl)가 loginctl 로.
// argv[2] = 설정 파일(data/screen-rdp.json): { user, password, enabledByHub }
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { RdpClient, SCANCODE } from './rdp/client.ts';

const run = promisify(execFile);
const file = process.argv[2] ?? 'screen-rdp.json';
let rdp: RdpClient | null = null;
let connecting: Promise<RdpClient> | null = null;
let last = { x: -1, y: -1 };
let lastSent = ''; // 마지막으로 보낸 화면의 판(바뀌지 않았으면 U)

interface Saved { user?: string; password?: string; enabledByHub?: boolean }

function write(t: string, data: Buffer = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.write(t, 0, 'ascii');
  head.writeInt32LE(data.length, 1);
  process.stdout.write(Buffer.concat([head, data]));
}

function load(): Saved {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (/^\(.*\)$/.test(v.user ?? '') || /^\(.*\)$/.test(v.password ?? '')) return { enabledByHub: v.enabledByHub }; // 예전에 잘못 저장한 "(null)"
    return v;
  } catch { return {}; }
}
function save(v: Saved) {
  writeFileSync(`${file}.tmp`, JSON.stringify(v));
  try { chmodSync(`${file}.tmp`, 0o600); } catch {}
  renameSync(`${file}.tmp`, file);
}

async function grdctl(...args: string[]) {
  try {
    const r = await run('grdctl', args, { timeout: 20000 });
    return String(r.stdout) + String(r.stderr);
  } catch (err: any) {
    const msg = String(err.stderr || err.message || err).split('\n').filter((l) => l && !/TPM/.test(l)).pop() ?? '';
    if (/secret|keyring|collection|locked/i.test(msg)) throw new Error('GNOME 키링이 잠겨 있어 원격 데스크톱 비밀번호를 저장하지 못함(자동 로그인이면 키링을 한 번 잠금 해제)');
    throw new Error(`grdctl ${args[0]} ${args[1] ?? ''} 실패: ${msg}`);
  }
}

/** grdctl status --show-credentials 의 RDP 부분 */
async function status() {
  const out = await grdctl('status', '--show-credentials');
  const rdpPart = out.slice(out.search(/RDP:/i));
  // 비어 있으면 "(empty)"·"(null)", 가려지면 "(hidden)" 으로 나온다 → 빈 값으로
  const val = (k: string) => { const v = rdpPart.match(new RegExp(`${k}:\\s*(.*)`, 'i'))?.[1]?.trim() ?? ''; return /^\((empty|hidden|null)\)$/i.test(v) ? '' : v; };
  return {
    enabled: /^enabled/i.test(val('Status')),
    port: Number(val('Port')) || 3389,
    cert: val('TLS certificate'),
    user: val('Username'),
    password: val('Password'),
    viewOnly: /^yes/i.test(val('View-only')),
  };
}

/** TLS 인증서(없으면 openssl 로 만든다 — 우분투 데스크톱에 기본으로 있다) */
async function ensureCert(st: { cert: string }) {
  if (st.cert && existsSync(st.cert)) return false;
  const dir = join(homedir(), '.local', 'share', 'gnome-remote-desktop');
  mkdirSync(dir, { recursive: true });
  const crt = join(dir, 'rdp-tls.crt'), key = join(dir, 'rdp-tls.key');
  if (!existsSync(crt) || !existsSync(key)) {
    try {
      await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', '/CN=GNOME', '-keyout', key, '-out', crt], { timeout: 30000 });
    } catch (e) {
      throw new Error(`원격 데스크톱 인증서를 만들지 못함(openssl): ${(e as Error).message}`);
    }
  }
  await grdctl('rdp', 'set-tls-cert', crt);
  await grdctl('rdp', 'set-tls-key', key);
  return true;
}

/** GNOME 원격 데스크톱 RDP 켜기. 바꾼 것이 있으면 서비스를 다시 띄운다 */
async function setup(): Promise<{ user: string; password: string; port: number }> {
  const saved = load();
  let st = await status();
  let changed = await ensureCert(st);
  let user = st.user, password = st.password;
  if (!user || !password) {
    // 아무도 정하지 않았으면 Agent Hub 가 정한다(비밀번호 = 임의 20자)
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    user = saved.user ?? 'agenthub';
    password = saved.password ?? Array.from({ length: 20 }, () => abc[randomInt(abc.length)]).join('');
    await grdctl('rdp', 'set-credentials', user, password);
    changed = true;
  }
  if (st.viewOnly) { await grdctl('rdp', 'disable-view-only'); changed = true; }
  const enabledByHub = saved.enabledByHub || !st.enabled;
  if (!st.enabled) {
    await grdctl('rdp', 'enable').catch(() => '');
    // systemd 사용자 서비스가 없으면 grdctl 이 켜기 도중 실패한다 → 설정값만 직접 켠다
    if (!(await status()).enabled) await run('gsettings', ['set', 'org.gnome.desktop.remote-desktop.rdp', 'enable', 'true'], { timeout: 10000 }).catch(() => {});
    changed = true;
  }
  save({ user, password, enabledByHub });
  try {
    await run('systemctl', ['--user', 'enable', 'gnome-remote-desktop.service'], { timeout: 15000 }).catch(() => {});
    await run('systemctl', ['--user', changed ? 'restart' : 'start', 'gnome-remote-desktop.service'], { timeout: 15000 });
  } catch {
    // systemd 사용자 서비스가 없는 곳: 직접 띄운다
    const daemon = ['/usr/libexec/gnome-remote-desktop-daemon', '/usr/lib/gnome-remote-desktop/gnome-remote-desktop-daemon'].find((p) => existsSync(p));
    if (!daemon) throw new Error('gnome-remote-desktop 서비스를 띄우지 못함');
    spawn(daemon, [], { detached: true, stdio: 'ignore' }).unref();
  }
  st = await status();
  return { user, password, port: st.port };
}

async function tryConnect(user: string, password: string, port: number): Promise<RdpClient> {
  const c = new RdpClient();
  c.onClose = () => { if (rdp === c) rdp = null; };
  lastSent = ''; // 새 연결의 첫 화면은 꼭 보낸다
  await c.connect('127.0.0.1', port, user, password, { timeoutMs: 10000 });
  return c;
}

async function ensure(): Promise<RdpClient> {
  if (rdp && !rdp.closed) return rdp;
  if (!connecting) {
    connecting = (async () => {
      const s = load();
      if (s.user && s.password) {
        try { return await tryConnect(s.user, s.password, (await status()).port); } catch {}
      }
      const { user, password, port } = await setup();
      let err: unknown;
      for (let i = 0; i < 20; i++) { // 서비스가 뜰 때까지(최대 10초)
        await new Promise((ok) => setTimeout(ok, 500));
        try { return await tryConnect(user, password, port); } catch (e) { err = e; }
      }
      throw new Error(`GNOME 원격 데스크톱에 붙지 못함: ${(err as Error)?.message ?? ''}`);
    })().then((c) => { rdp = c; return c; }).finally(() => { connecting = null; });
  }
  return connecting;
}

/** 화면이 잠겨 있는가 — 잠금 화면에서는 GNOME 이 원격 연결을 막는다("Session creation inhibited"). 1초 동안 기억 */
let lockSeen = { at: 0, locked: false };
async function locked(): Promise<boolean> {
  if (Date.now() - lockSeen.at < 1000) return lockSeen.locked;
  let v = false;
  try {
    const r = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'], { timeout: 3000 });
    v = /true/.test(String(r.stdout));
  } catch {}
  lockSeen = { at: Date.now(), locked: v };
  return v;
}
const LOCKED = '화면이 잠겨 있음';

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const at = (c: RdpClient, xs: string, ys: string) => ({ x: clamp(Number(xs)) * (c.width - 1), y: clamp(Number(ys)) * (c.height - 1) });

async function handle(a: string[]) {
  const c = a[0];
  try {
    if (c === 'indicator') return; // GNOME 이 화면 공유 중이면 위쪽 표시줄에 스스로 표시한다
    if (c === 'disable') { // Agent Hub 가 켠 RDP 만 끈다
      rdp?.close();
      if (load().enabledByHub) await grdctl('rdp', 'disable').catch(() => '');
      return;
    }
    // 잠겨 있으면 붙어 보지 않고 바로 알린다(K) — 허브가 잠금을 풀고 다시 묻는다
    if ((!rdp || rdp.closed) && (c === 'info' || c === 'frame') && (await locked())) {
      if (c === 'info') write('J', Buffer.from(JSON.stringify({ monitors: [] })));
      else write('K', Buffer.from(LOCKED));
      return;
    }
    if ((!rdp || rdp.closed) && c !== 'info' && c !== 'frame' && (await locked())) return; // 잠긴 동안 입력은 버린다
    const v = await ensure();
    if (c === 'info') {
      write('J', Buffer.from(JSON.stringify({ monitors: [{ x: 0, y: 0, w: v.width, h: v.height, primary: true }] })));
    } else if (c === 'frame') {
      // 지난번에 보낸 뒤로 화면(갱신 수·크기)도 커서도 그대로면 U — 허브가 만들어 둔 그림을 다시 쓴다(8MB 를 다시 넘기고 압축하지 않게)
      const version = `${v.frames}:${v.width}x${v.height}:${last.x},${last.y}`;
      if (a[4] !== 'force' && version === lastSent) { write('U'); return; }
      lastSent = version;
      const head = Buffer.alloc(20);
      head.writeUInt32LE(v.width, 0); head.writeUInt32LE(v.height, 4); head.writeUInt32LE(v.width * 4, 8);
      head.writeInt32LE(last.x, 12); head.writeInt32LE(last.y, 16);
      write('R', Buffer.concat([head, v.fb]));
    } else if (c === 'move') {
      const p = at(v, a[2], a[3]);
      last = { x: Math.round(p.x), y: Math.round(p.y) };
      v.pointer(p.x, p.y);
    } else if (c === 'down' || c === 'up') {
      const p = at(v, a[2], a[3]);
      last = { x: Math.round(p.x), y: Math.round(p.y) };
      const b = Number(a[4]);
      if (b >= 0 && b <= 2) v.button(p.x, p.y, b, c === 'down');
    } else if (c === 'wheel') {
      const p = at(v, a[2], a[3]);
      v.wheel(p.x, p.y, Number(a[4]));
    } else if (c === 'key') {
      const sc = SCANCODE[Number(a[2])];
      if (sc) v.scancode(sc[0], sc[1], a[1] === 'd');
    } else if (c === 'text') {
      v.typeText(Buffer.from(a[1], 'base64').toString('utf8'));
    }
  } catch (err) {
    write(c === 'info' || c === 'frame' ? 'E' : 'L', Buffer.from((err as Error).message));
  }
}

// 명령은 차례대로(앞 명령이 연결을 기다리는 동안 뒤 명령이 앞서지 않게)
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  const a = line.trim().split(' ');
  if (a[0]) chain = chain.then(() => handle(a));
}).on('close', () => { void chain.then(() => { rdp?.close(); process.exit(0); }); });
