import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { inflateSync } from 'node:zlib';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { startLocalServer } from '../src/transports/local.ts';
import { ScreenControl, rawToPng, toLine } from '../src/screen.ts';
import { ByteQueue } from '../src/bytes.ts';
import { encodeJpeg } from '../src/jpeg.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, '..', 'ui');
const src = join(here, '..', 'src');
const freePort = () => new Promise<number>((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('시간 초과'); await new Promise((ok) => setTimeout(ok, 20)); } };

async function hub(mode?: string, loginctl?: (args: string[]) => Promise<string>) {
  const base = mkdtempSync(join(tmpdir(), 'agent hub screen '));
  mkdirSync(join(base, 'ws'), { recursive: true });
  const log = join(base, 'input.log');
  const port = await freePort();
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  const screen = new ScreenControl({ file: join(base, 'data', 'screen.json'), binDir: join(base, 'data', 'bin'), source: join(src, 'screen-helper.cs'), helperCommand: [process.execPath, join(here, 'fake-screen.mjs'), log, mode ?? ''], loginctl });
  const server = await startLocalServer({ port, uiDir: ui, sessions, info: {}, screen });
  const url = `http://127.0.0.1:${port}`;
  const post = (path: string, body: object) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { base, url, post, lines, screen, server, close: () => new Promise((ok) => { screen.stop(); server.close(() => ok(null)); }) };
}

test('화면 제어: 기본 꺼짐, 켜면 모니터·프레임·입력, 다시 켜도 그대로, 끄면 막힘', async () => {
  const h = await hub();
  try {
    let st = await (await fetch(h.url + '/screen')).json();
    assert.equal(st.enabled, false);
    assert.equal(st.supported, true);
    assert.equal((await fetch(h.url + '/screen.js')).status, 200); // 화면 파일은 화면 제어 경로가 아니다
    assert.equal((await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a')).status, 403);

    st = await (await h.post('/screen', { enabled: true })).json();
    assert.equal(st.enabled, true);
    assert.equal(st.monitors.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(h.base, 'data', 'screen.json'), 'utf8')), { enabled: true });

    // 프레임: 너비·화질은 범위 안으로
    const r = await fetch(h.url + '/screen/frame?m=1&w=99999&q=5&v=viewer1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(await r.text(), 'jpeg 1 7680 20');
    assert.equal(h.screen.viewerCount(), 1);
    // 보는 사람이 있으면 이 PC 화면에 표시 띠
    await until(() => h.lines().includes('indicator 1'));

    // 입력: 형식이 맞는 것만 한 줄씩, 좌표는 0..1 로
    const sent = await (await h.post('/screen/input', { m: 1, events: [
      { t: 'move', x: 0.5, y: 2 },
      { t: 'down', x: 0.1, y: 0.2, b: 1 },
      { t: 'wheel', x: 0, y: 0, dy: 99999 },
      { t: 'key', d: true, vk: 65 },
      { t: 'text', s: '안녕\n' },
      { t: 'rm -rf', x: 0, y: 0 },
      { t: 'move', x: 'a', y: 0 },
    ] })).json();
    assert.equal(sent.sent, 5);
    await until(() => h.lines().length >= 6);
    assert.deepEqual(h.lines().filter((l) => !l.startsWith('indicator')), [
      'move 1 0.50000 1.00000',
      'down 1 0.10000 0.20000 1',
      'wheel 1 0.00000 0.00000 1200',
      'key d 65',
      `text ${Buffer.from('안녕\n').toString('base64')}`,
    ]);
    // 다른 사이트의 단순 폼 전송은 받지 않는다
    assert.equal((await fetch(h.url + '/screen/input', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);

    // 끄면 막히고 설정에 남는다
    st = await (await h.post('/screen', { enabled: false })).json();
    assert.equal(st.enabled, false);
    assert.equal((await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a')).status, 403);
    assert.equal((await h.post('/screen/input', { m: 0, events: [] })).status, 403);
    assert.equal(new ScreenControl({ file: join(h.base, 'data', 'screen.json'), binDir: h.base, source: join(src, 'screen-helper.cs'), helperCommand: ['x'] }).enabled, false);
  } finally {
    await h.close();
  }
});

test('화면 제어: 관리자 확인 창이면 423, 답 없는 명령의 실패(L)는 다음 답과 섞이지 않는다', async () => {
  const h = await hub('secure');
  try {
    await h.post('/screen', { enabled: true });
    const r = await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a');
    assert.equal(r.status, 423);
    assert.match(await r.text(), /PC 앞에서/);
    (h.screen as any).child.stdin.write('bad\n');
    assert.equal((await (await fetch(h.url + '/screen')).json()).monitors.length, 2);
  } finally {
    await h.close();
  }
});

test('리눅스 프레임: 날 픽셀을 JPEG 로(줄이기·커서), 안 바뀐 화면은 만들어 둔 것을 다시', async () => {
  const h = await hub('rawU');
  try {
    await h.post('/screen', { enabled: true });
    const r = await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a');
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    const jpg = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...jpg.subarray(-2)], [0xff, 0xd9]);
    const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
    assert.equal(jpg.readUInt16BE(sof + 5), 2); // 높이
    assert.equal(jpg.readUInt16BE(sof + 7), 4); // 너비
    // 같은 화면(U): 같은 그림을 그대로
    const again = Buffer.from(await (await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a')).arrayBuffer());
    assert.ok(again.equals(jpg));
    // 다른 너비로 처음 보는 사람: 만들어 둔 것이 없으니 force 로 다시 받는다
    assert.equal((await fetch(h.url + '/screen/frame?m=0&w=640&q=60&v=b')).status, 200);
    assert.ok(h.lines().includes('U'));
  } finally {
    await h.close();
  }

  // 8×4 회색(200) → 너비 4: 크기 반, 색 그대로, 커서 자리(0,0)는 테두리(검정)
  const head = Buffer.alloc(20);
  head.writeUInt32LE(8, 0); head.writeUInt32LE(4, 4); head.writeUInt32LE(32, 8); head.writeInt32LE(0, 12); head.writeInt32LE(0, 16);
  const png = await rawToPng(Buffer.concat([head, Buffer.alloc(128, 200)]), 4);
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 2);
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
  const rows = inflateSync(idat);
  // 줄 = 필터 1바이트 + 4칸×3. Sub 필터를 풀어 본다
  const row1 = rows.subarray(13 + 1, 26);
  const un = Buffer.from(row1);
  for (let i = 3; i < un.length; i++) un[i] = (un[i] + un[i - 3]) & 255;
  assert.deepEqual([...un.subarray(9, 12)], [200, 200, 200]);
  const row0 = Buffer.from(rows.subarray(1, 13));
  assert.deepEqual([...row0.subarray(0, 3)], [0, 0, 0]);
});

test('화면 잠김(리눅스 GNOME): 이 계정의 그래픽 세션만 풀고, 다 보고 나면(끄면) 다시 잠근다', async () => {
  const calls: string[] = [];
  const me = userInfo().username;
  const loginctl = async (args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === 'list-sessions') return [`  3 1000 ${me} seat0 tty2`, '  7 1001 남 seat0 tty3', ` c1 1000 ${me} - -`, ''].join('\n');
    if (args[0] === 'show-session') return args[1] === 'c1' ? 'tty\n' : 'wayland\n';
    return '';
  };
  const h = await hub('locked', loginctl);
  try {
    await h.post('/screen', { enabled: true });
    const r = await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a');
    assert.equal(r.status, 423);
    assert.match(await r.text(), /잠금을 푸는 중/);
    assert.ok(calls.includes('unlock-session 3'));
    assert.ok(!calls.some((c) => c.startsWith('unlock-session 7') || c.startsWith('unlock-session c1'))); // 남의 세션·그래픽 아닌 세션은 건드리지 않는다
    assert.equal((await fetch(h.url + '/screen/frame?m=0&w=800&q=60&v=a')).status, 200); // 풀린 뒤엔 화면
    await h.post('/screen', { enabled: false });
    assert.ok(calls.includes('lock-session 3'));
  } finally {
    await h.close();
  }
  // 풀지 못하면 PC 앞에서 풀라고
  const h2 = await hub('locked', async (args) => { if (args[0] === 'list-sessions') return ''; return ''; });
  try {
    await h2.post('/screen', { enabled: true });
    const r = await fetch(h2.url + '/screen/frame?m=0&w=800&q=60&v=a');
    assert.equal(r.status, 423);
    assert.match(await r.text(), /PC 앞에서/);
  } finally {
    await h2.close();
  }
});

test('도우미가 답하지 않아도 상태 확인(GET /screen)은 금방 돌아온다', async () => {
  const h = await hub('hang');
  try {
    await h.post('/screen', { enabled: true }).catch(() => {});
    const t0 = Date.now();
    const st = await (await fetch(h.url + '/screen')).json();
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(st.enabled, true);
    assert.deepEqual(st.monitors, []);
  } finally {
    await h.close();
  }
});

test('받은 조각 줄(ByteQueue): 조각이 어떻게 나뉘어 와도 같은 바이트를 꺼낸다', () => {
  const q = new ByteQueue();
  const all = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 255));
  for (let o = 0; o < all.length; o += 37) q.push(all.subarray(o, o + 37));
  assert.equal(q.length, 1000);
  assert.deepEqual([...q.peek(5)!], [0, 1, 2, 3, 4]);
  assert.ok(q.take(100)!.equals(all.subarray(0, 100)));
  assert.ok(q.peek(300)!.equals(all.subarray(100, 400)));
  assert.ok(q.take(899)!.equals(all.subarray(100, 999)));
  assert.equal(q.take(2), null);
  assert.equal(q.take(1)![0], 999 & 255);
  assert.equal(q.length, 0);
});

test('JPEG: 다른 프로그램이 읽는 정상 파일(크기·표지)', () => {
  const w = 37, h = 21, rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) & 255;
  const j = encodeJpeg(rgb, w, h, 70);
  assert.deepEqual([...j.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...j.subarray(-2)], [0xff, 0xd9]);
  const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(j.readUInt16BE(sof + 5), h);
  assert.equal(j.readUInt16BE(sof + 7), w);
  // 데이터 안의 0xFF 는 모두 0x00 을 붙여 둔다(끝 표지 앞까지)
  const sos = j.indexOf(Buffer.from([0xff, 0xda]));
  const data = j.subarray(sos + 14, j.length - 2);
  for (let i = 0; i < data.length; i++) if (data[i] === 0xff) assert.equal(data[i + 1], 0);
});

test('입력 줄 형식', () => {
  assert.equal(toLine(0, { t: 'key', d: false, vk: 999 }), 'key u 254');
  assert.equal(toLine(0, { t: 'text', s: '' }), null);
  assert.equal(toLine(0, null), null);
  assert.equal(toLine(2, { t: 'up', x: -1, y: 0.25, b: 7 }), 'up 2 0.00000 0.25000 2');
});

test('Windows 실제 도우미: 컴파일하고 모니터·한 장(입력은 보내지 않음)', { skip: process.platform !== 'win32' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub screen real '));
  const s = new ScreenControl({ file: join(base, 'screen.json'), binDir: join(base, 'bin'), source: join(src, 'screen-helper.cs') });
  assert.equal(s.supported, true);
  s.set({ enabled: true });
  try {
    const mons = await s.monitors();
    assert.ok(mons.length >= 1 && mons[0].w > 0);
    const f = await s.frame(0, 640, 50, 'test');
    if (f.kind === 'image') {
      assert.equal(f.type, 'image/jpeg');
      assert.equal(f.data[0], 0xff);
      assert.equal(f.data[1], 0xd8);
    }
  } finally {
    s.stop();
  }
});
