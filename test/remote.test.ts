import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { startLocalServer } from '../src/transports/local.ts';
import { RemoteAccess, isPrivateAddress } from '../src/remote.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, '..', 'ui');
const freePort = () => new Promise<number>((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });

test('사설 주소만 받는다', () => {
  for (const a of ['192.168.0.12', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.1', '127.0.0.1', '::1', '::ffff:192.168.1.5', 'fe80::1', 'fd12::3']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.5', '2001:db8::1', '', undefined]) assert.ok(!isPrivateAddress(a as any), String(a));
});

test('원격 비밀번호: 8자 이상, 없으면 못 켬, 5번 틀리면 1분 막힘, 바꾸면 모두 다시 로그인', () => {
  const r = new RemoteAccess(join(mkdtempSync(join(tmpdir(), 'agent hub remote ')), 'remote.json'), 4319);
  assert.throws(() => r.set({ enabled: true }), /비밀번호를 먼저/);
  assert.throws(() => r.set({ password: 'short' }), /8자 이상/);
  r.set({ password: 'office-pass-1', enabled: true });
  const token = r.login('office-pass-1', '김범무', '192.168.0.20');
  assert.equal(r.who(`ahs=${token}`)?.name, '김범무');
  for (let i = 0; i < 5; i++) assert.throws(() => r.login('wrong', '', '192.168.0.99'), /맞지 않음/);
  assert.throws(() => r.login('office-pass-1', '', '192.168.0.99'), /잠시 막힘/); // 맞아도 잠긴 동안은 안 된다
  assert.ok(r.login('office-pass-1', '', '192.168.0.21')); // 다른 주소는 그대로
  r.set({ password: 'office-pass-2' });
  assert.equal(r.who(`ahs=${token}`), undefined);
  // 파일에는 해시만
  const again = new RemoteAccess((r as any).file, 4319);
  assert.equal(again.enabled, true);
  assert.ok(again.login('office-pass-2', '', '10.0.0.5'));
});

test('원격 서버: 로그인해야 들어오고, 작업은 되지만 설정은 PC 앞에서만, 끄면 닫힌다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub lan '));
  mkdirSync(join(base, 'ws', 'proj'), { recursive: true });
  const port = await freePort();
  const lanPort = await freePort();
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const remote = new RemoteAccess(join(base, 'data', 'remote.json'), lanPort);
  const server = await startLocalServer({ port, uiDir: ui, sessions, info: { workspaceRoot: join(base, 'ws') }, remote });
  const local = (path: string, body?: object) => fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const lan = (path: string, opts: { body?: object; cookie?: string; origin?: string } = {}) => fetch(`http://127.0.0.1:${lanPort}${path}`, {
    method: opts.body ? 'POST' : 'GET',
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  // 꺼져 있으면 원격 포트는 닫혀 있다
  await assert.rejects(lan('/'));
  assert.equal((await local('/remote', { enabled: true })).status, 400); // 비밀번호 먼저
  await local('/remote', { password: 'office-pass-1' });
  const on = await (await local('/remote', { enabled: true })).json();
  assert.equal(on.enabled, true);
  assert.equal(on.error, null);

  // 로그인 전: 첫 화면은 로그인 창, 나머지는 401
  const page = await lan('/');
  assert.match(await page.text(), /비밀번호/);
  assert.equal((await lan('/info')).status, 401);
  assert.equal((await lan('/login', { body: { password: 'nope' } })).status, 401);
  const login = await lan('/login', { body: { password: 'office-pass-1', name: '홍길동' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  // 들어온 뒤: 정보·작업하기는 되고, 원격 표시
  const info = await (await lan('/info', { cookie })).json();
  assert.equal(info.remote, true);
  assert.equal(info.user, '홍길동');
  assert.equal((await lan('/cmd', { cookie, body: { type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' } })).status, 202);
  const created = (await waitFor(events, (e) => e.type === 'session.created')).session;
  assert.equal(created.via, 'dashboard');
  assert.equal(created.requestedBy, '홍길동(원격)');

  // 설정·키·폴더 창·원격 설정 자체·MCP 는 PC 앞에서만
  for (const [path, body] of [['/auth', { agent: 'claude', mode: 'apikey' }], ['/remote', { enabled: false }], ['/autostart', { enabled: true }], ['/presets', { name: 'x' }], ['/pick-folder', {}], ['/shared', { action: 'pull' }]] as const) {
    assert.equal((await lan(path, { cookie, body })).status, 403, path);
  }
  assert.equal((await lan('/browse', { cookie })).status, 403);
  // 다른 사이트에서 보낸 요청(Origin 이 다름)은 막는다
  assert.equal((await lan('/info', { cookie, origin: 'http://evil.example' })).status, 403);

  // 기본: 권한 묻지 않기 켜기는 원격에서 안 된다
  await lan('/cmd', { cookie, body: { type: 'session.configure', sessionId: created.id, autoApprove: true } });
  await waitFor(events, (e) => e.type === 'error' && e.sessionId === created.id && /PC 앞에서만/.test(e.message));
  assert.ok(!sessions.info(created.id)?.autoApprove);

  // "PC 앞과 같은 권한"을 켜면: 권한 묻지 않기, 폴더 찾아보기가 된다(설정은 여전히 PC 앞에서만)
  const full = await (await local('/remote', { full: true })).json();
  assert.equal(full.full, true);
  assert.equal((await (await lan('/info', { cookie })).json()).full, true);
  assert.equal((await lan('/browse', { cookie })).status, 200);
  await lan('/cmd', { cookie, body: { type: 'session.configure', sessionId: created.id, autoApprove: true } });
  await waitFor(events, () => sessions.info(created.id)?.autoApprove === true);
  assert.equal((await lan('/auth', { cookie, body: { agent: 'claude', mode: 'apikey' } })).status, 403);
  await local('/remote', { full: false });
  assert.equal((await lan('/browse', { cookie })).status, 403);

  // 끄면 원격 포트가 닫히고, 이 PC 화면은 그대로
  await local('/remote', { enabled: false });
  await assert.rejects(lan('/info', { cookie }));
  assert.equal((await local('/info')).status, 200);
  sessions.stopAll();
  await new Promise((ok) => server.close(() => ok(null)));
});
