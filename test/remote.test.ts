import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { startLocalServer } from '../src/transports/local.ts';
import { RemoteAccess, isOwnHost, isPrivateAddress } from '../src/remote.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, '..', 'ui');
const freePort = () => new Promise<number>((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });

test('사설 주소만 받는다', () => {
  for (const a of ['192.168.0.12', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.1', '127.0.0.1', '::1', '::ffff:192.168.1.5', 'fe80::1', 'fd12::3']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.5', '2001:db8::1', '', undefined]) assert.ok(!isPrivateAddress(a as any), String(a));
});

test('원격 설정: 비밀번호 없이 켜고 끈다, 다시 켜도 그대로, 예전 비밀번호 항목은 버린다', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agent hub remote ')), 'remote.json');
  writeFileSync(file, JSON.stringify({ enabled: true, full: true, port: 4319, salt: 'aa', hash: 'bb' })); // 예전 형식
  const r = new RemoteAccess(file, 4319);
  assert.equal(r.enabled, true);
  r.set({ enabled: false });
  r.set({ enabled: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: true, port: 4319 });
  assert.equal(new RemoteAccess(file, 4319).enabled, true);
});

test('이 PC 를 가리키는 Host 만 받는다(DNS 리바인딩 차단)', () => {
  assert.ok(isOwnHost('127.0.0.1:4319', 4319));
  assert.ok(isOwnHost('localhost:4319', 4319));
  assert.ok(isOwnHost(`${hostname()}:4319`, 4319));
  assert.ok(!isOwnHost('127.0.0.1:4317', 4319)); // 다른 포트
  assert.ok(!isOwnHost('evil.example:4319', 4319));
  assert.ok(!isOwnHost(undefined, 4319));
});

test('원격 서버: 비밀번호 없이 이 PC 와 똑같이 쓰고, 다른 이름·다른 사이트는 막고, 끄면 닫힌다', async () => {
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
  const local = (path: string, body?: object, extra: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...extra, ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const lan = (path: string, opts: { body?: object; origin?: string } = {}) => fetch(`http://127.0.0.1:${lanPort}${path}`, {
    method: opts.body ? 'POST' : 'GET',
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.origin ? { origin: opts.origin } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const withHost = (host: string, path: string) => new Promise<number>((ok, fail) => {
    const r = httpRequest({ host: '127.0.0.1', port: lanPort, path, headers: { host } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
    r.on('error', fail);
    r.end();
  });

  // 꺼져 있으면 원격 포트는 닫혀 있다
  await assert.rejects(lan('/'));
  const on = await (await local('/remote', { enabled: true })).json();
  assert.equal(on.enabled, true);
  assert.equal(on.error, null);

  // 들어오자마자 같은 화면, 같은 권한(설정·폴더 찾아보기·원격 설정까지)
  assert.match(await (await lan('/')).text(), /Agent Hub/);
  assert.equal((await (await lan('/info')).json()).remote, undefined);
  assert.equal((await lan('/cmd', { body: { type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' } })).status, 202);
  const created = (await waitFor(events, (e) => e.type === 'session.created')).session;
  assert.equal(created.via, 'local');
  assert.equal((await lan('/browse')).status, 200);
  assert.equal((await lan('/remote')).status, 200);
  assert.equal((await lan('/claude-code')).status, 200);
  await lan('/cmd', { body: { type: 'session.configure', sessionId: created.id, autoApprove: true } });
  await waitFor(events, () => sessions.info(created.id)?.autoApprove === true);

  // 비밀번호가 없으니 문은 Host·Origin: 다른 이름으로 이 PC 를 가리키거나 다른 사이트에서 보내면 막는다
  assert.equal(await withHost(`evil.example:${lanPort}`, '/info'), 403);
  assert.equal((await lan('/info', { origin: 'http://evil.example' })).status, 403);

  // 켜져 있으면 이 PC 화면(127.0.0.1)은 사무실 주소로 옮겨 간다
  const lanUrl = remote.urls()[0];
  if (lanUrl) {
    const moved = await local('/', undefined, { redirect: 'manual' });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get('location'), `${lanUrl}/`);
    assert.equal((await fetch(`${lanUrl}/info`)).status, 200);
  }

  // 끄면 원격 포트가 닫히고, 이 PC 화면은 그대로
  const off = await (await local('/remote', { enabled: false })).json();
  assert.equal(off.local, `http://127.0.0.1:${port}`);
  await assert.rejects(lan('/info'));
  assert.equal((await local('/', undefined, { redirect: 'manual' })).status, 200);
  sessions.stopAll();
  await new Promise((ok) => server.close(() => ok(null)));
});
