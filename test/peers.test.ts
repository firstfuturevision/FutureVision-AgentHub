import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Peers, peerUrl } from '../src/peers.ts';
import { isPrivateAddress } from '../src/remote.ts';

test('peerUrl: 사설 IPv4 + 포트만', () => {
  assert.equal(peerUrl('192.168.0.5:4319'), 'http://192.168.0.5:4319');
  assert.equal(peerUrl('http://10.1.2.3:4319/'), 'http://10.1.2.3:4319');
  assert.equal(peerUrl('http://8.8.8.8:4319'), null); // 공인
  assert.equal(peerUrl('http://127.0.0.1:4319'), null); // 루프백
  assert.equal(peerUrl('http://169.254.1.1:4319'), null);
  assert.equal(peerUrl('http://example.com:4319'), null);
  assert.equal(peerUrl('http://192.168.0.5:80'), null); // 낮은 포트
  assert.equal(peerUrl('http://192.168.0.5:4319/x'), null);
  assert.equal(peerUrl('http://192.168.0.300:4319'), null);
});

/** 이 PC 의 사설 주소(없으면 시험을 건너뛴다 — Peers 는 루프백을 받지 않는다) */
const lanIp = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal && isPrivateAddress(n.address))?.address;

test('Peers: 손으로 더한 PC 의 요약을 읽고 "PC/작업"으로 보낸다', { skip: !lanIp && '사설 주소 없음' }, async () => {
  const got: any[] = [];
  const srv = createServer((req, res) => {
    if (req.url === '/peer/summary') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: 'pc2', tasks: [{ name: '영업', id: 'abcdef12-0000-0000-0000-000000000000', status: '대기', schedules: 2 }] }));
    }
    if (req.url === '/cmd' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { got.push(JSON.parse(b)); res.statusCode = 202; res.end('ok'); });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => srv.listen(0, '0.0.0.0', ok));
  const port = (srv.address() as any).port;
  try {
    const peers = new Peers(join(mkdtempSync(join(tmpdir(), 'peers-')), 'peers.json'));
    const url = peers.add(`${lanIp}:${port}`);
    const [v] = await peers.all(true);
    assert.equal(v.url, url);
    assert.equal(v.ok, true);
    assert.equal(v.name, 'pc2');
    assert.equal(v.summary!.tasks[0].name, '영업');
    assert.equal(await peers.send('pc2', '영업', '안녕', '본부'), 'pc2 의 영업 에 보냄');
    assert.equal(got[0].type, 'user.message');
    assert.equal(got[0].sessionId, 'abcdef12-0000-0000-0000-000000000000');
    assert.equal(got[0].via.label, '작업 본부');
    await assert.rejects(peers.send('pc2', '없는작업', 'x', 'a'), /없는 작업/);
    await assert.rejects(peers.send('pc9', '영업', 'x', 'a'), /연결된 PC 가 아님/);
    // 사람이 화면에서: 그 PC 에 있는 작업에만, 보낸 곳은 "사람"
    assert.equal(await peers.sendIds(url, ['abcdef12-0000-0000-0000-000000000000', '없는-id'], '모두 확인'), 1);
    assert.equal(got.at(-1).text, '모두 확인');
    assert.equal(got.at(-1).via.label, '사람');
    peers.remove(url);
    assert.deepEqual(peers.urls(), []);
  } finally {
    srv.close();
  }
});

test('역할 한 줄: 비었으면 "비어 있음", 있으면 줄바꿈 없이 한 줄', async () => {
  const { aboutNote } = await import('../src/sessions.ts');
  assert.equal(aboutNote(), '[이 작업 역할: 비어 있음]');
  assert.equal(aboutNote('영업 담당.\n고객 문의'), '[이 작업 역할: 영업 담당. 고객 문의]');
});

test('Peers: 그 PC 의 공통 지침·회사 기억 읽기(개인 기억은 빼고)와 입력 세션 모델', { skip: !lanIp && '사설 주소 없음' }, async () => {
  const mem = { guide: '', items: [{ id: 'x', text: '그 PC 것' }] as { id: string; text: string }[] };
  let model = 'opus';
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/peer/summary') return res.end(JSON.stringify({ name: 'pc3', tasks: [] }));
      if (req.url === '/intake') { if (req.method === 'POST') model = JSON.parse(b).model; return res.end(JSON.stringify({ model })); }
      if (req.url === '/memory') {
        if (req.method === 'POST') {
          const x = JSON.parse(b);
          if (x.action === 'guide') mem.guide = x.text;
          if (x.action === 'add') mem.items.push({ id: String(mem.items.length), text: x.text });
        }
        return res.end(JSON.stringify(mem));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '0.0.0.0', ok));
  try {
    const peers = new Peers(join(mkdtempSync(join(tmpdir(), 'peers-')), 'peers.json'));
    const url = peers.add(`${lanIp}:${(srv.address() as any).port}`);
    const [v] = await peers.all(true);
    assert.deepEqual(v.intake, { model: 'opus' });
    assert.deepEqual(v.memory, { items: 1, guide: false });
    mem.items.push({ id: 'c', text: '회사 규칙', scope: 'company' } as any);
    assert.deepEqual(await peers.shared(url), { guide: '', items: [{ text: '회사 규칙', at: '' }] }); // 개인 기억은 빼고
    await peers.post(url, '/intake', { model: 'sonnet' });
    assert.equal(model, 'sonnet');
  } finally {
    srv.close();
  }
});

test('양방향 연결: 상대가 알려 오면 요청 IP + 알려 준 원격 포트로 목록에 더하고, 빼면 뺀다(한 번만)', () => {
  const peers = new Peers(join(mkdtempSync(join(tmpdir(), 'peers-')), 'peers.json'));
  assert.equal(peers.greeted('::ffff:192.168.0.9', 4319), 'http://192.168.0.9:4319');
  assert.equal(peers.greeted('192.168.0.9', 4319), null); // 이미 있음
  assert.deepEqual(peers.urls(), ['http://192.168.0.9:4319']);
  assert.equal(peers.greeted('8.8.8.8', 4319), null); // 공인 주소는 안 받음
  assert.equal(peers.greeted('127.0.0.1', 4319), null);
  assert.equal(peers.greeted('192.168.0.9', 4319, true), 'http://192.168.0.9:4319');
  assert.deepEqual(peers.urls(), []);
});

test('다른 PC 작업에 첨부: 이 PC 호스트가 그 PC 의 /attach 로 넘기고 그 PC 가 저장한 첨부 정보를 돌려준다', async (t) => {
  const lanIp = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal && isPrivateAddress(n.address))?.address;
  if (!lanIp) return t.skip('사설 IPv4 없음');
  const got: { url: string; name: string; type: string; body: Buffer }[] = [];
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/attach') && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const name = decodeURIComponent(String(req.headers['x-file-name']));
        got.push({ url: req.url!, name, type: String(req.headers['content-type']), body: Buffer.concat(chunks) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ path: `첨부/${name}`, name, mime: req.headers['content-type'], size: Buffer.concat(chunks).length }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => srv.listen(0, '0.0.0.0', ok));
  const { startLocalServer } = await import('../src/transports/local.ts');
  const { SessionManager } = await import('../src/sessions.ts');
  const { createServer: netServer } = await import('node:net');
  const port = await new Promise<number>((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
  const base = mkdtempSync(join(tmpdir(), 'peers-attach-'));
  const peers = new Peers(join(base, 'peers.json'));
  const url = peers.add(`${lanIp}:${(srv.address() as any).port}`);
  const sessions = new SessionManager({ workspaceRoot: base, dataDir: join(base, 'data') });
  const hub = await startLocalServer({ port, uiDir: join(base, 'ui'), sessions, peers, info: {} });
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await fetch(`http://127.0.0.1:${port}/peers/attach?url=${encodeURIComponent(url)}&sessionId=abc-123`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('붙여넣은-이미지.png') }, body: png });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { path: '첨부/붙여넣은-이미지.png', name: '붙여넣은-이미지.png', mime: 'image/png', size: 7 });
    assert.equal(got[0].url, '/attach?sessionId=abc-123');
    assert.equal(got[0].type, 'image/png');
    assert.deepEqual(got[0].body, png);
    // 연결하지 않은 PC 로는 넘기지 않는다
    const bad = await fetch(`http://127.0.0.1:${port}/peers/attach?url=${encodeURIComponent('http://10.9.9.9:4319')}&sessionId=x`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'a.png' }, body: png });
    assert.equal(bad.status, 400);
  } finally {
    sessions.stopAll();
    hub.closeAllConnections();
    await new Promise((ok) => hub.close(() => ok(null)));
    srv.close();
  }
});

test('다른 PC 작업에 합치기: 한 일 · 그림을 그 PC 작업에 보내고, 아래 작업은 그 작업 아래로, 이 작업은 보관(받는 쪽은 다음 지시에 함께)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { SessionManager } = await import('../src/sessions.ts');
  const { ClaudeAdapter } = await import('../src/adapters/claude.ts');
  const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const make = (name: string) => {
    const base = mkdtempSync(join(tmpdir(), `agent hub merge ${name} `));
    mkdirSync(join(base, 'ws', 'proj'), { recursive: true });
    const events: any[] = [];
    const sessions = new SessionManager({ workspaceRoot: join(base, 'ws'), dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
    sessions.subscribe((e) => events.push(e));
    return { sessions, events };
  };
  const a = make('a');
  const b = make('b');
  const local = { via: 'local' as const, user: 'local' };
  const create = async (w: any) => { const n = w.events.length; await w.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj' }, local); return w.events.slice(n).find((e: any) => e.type === 'session.created').session.id; };
  const src = await create(a);
  const dst = await create(b);
  await a.sessions.handle({ type: 'user.message', sessionId: src, text: '해양 장면 정리' }, local);
  await new Promise<void>((r) => { const t = setInterval(() => { if (a.events.some((e: any) => e.type === 'turn.done' && e.sessionId === src)) { clearInterval(t); r(); } }, 50); });
  writeFileSync(join(a.sessions.info(src)!.workdir, 'scene.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await a.sessions.showImage(src, { path: 'scene.png' });
  await a.sessions.handle({ type: 'session.split', sessionId: src }, local);
  const kid = await new Promise<string>((r) => { const t = setInterval(() => { const c = a.events.find((e: any) => e.type === 'session.created' && e.session.splitFrom === src); if (c) { clearInterval(t); r(c.session.id); } }, 50); });
  // 가짜 연결: 그 PC 로 보내는 것을 b 가 받는다
  const URL = 'http://192.168.0.9:4319';
  (a.sessions as any).peers = {
    summary: () => ({ name: 'pcA', tasks: [] }),
    all: async () => [{ url: URL, ok: true, name: 'pcB', summary: { name: 'pcB', tasks: [{ id: dst, name: '해양VR', status: '대기' }] } }],
    myUrl: () => 'http://192.168.0.5:4319',
    post: async (_u: string, path: string, body: any) => {
      if (path === '/peer/image') { b.sessions.receiveRemoteImage(body.to, body.fromPc, body.title, body); return { ok: true }; }
      assert.equal(path, '/peer/share');
      assert.equal(body.images, undefined, '그림은 따로 한 장씩');
      b.sessions.receiveRemoteShare(body.to, body.fromPc, body.fromId, body.title, body.text, body.images, body.merge); return { ok: true };
    },
  };
  await a.sessions.handle({ type: 'session.mergeIntoPeer', sessionId: src, url: URL, targetId: dst } as any, local);
  const merged = b.events.find((e: any) => e.type === 'session.merged' && e.sessionId === dst);
  assert.ok(merged && /해양 장면 정리/.test(merged.text), '한 일이 그 PC 작업으로');
  assert.ok(b.events.some((e: any) => e.type === 'agent.image' && e.sessionId === dst), '그림도');
  assert.ok(b.events.some((e: any) => e.type === 'notice' && e.sessionId === dst && /합침/.test(e.message)), '받는 쪽에 알림');
  assert.equal(a.sessions.info(src)!.archived, true, '이 작업은 보관(지우지 않음)');
  assert.deepEqual(a.sessions.info(kid)!.remoteParent, { url: URL, id: dst, pc: 'pcB' }, '아래 작업은 그 PC 작업 아래로');
  // 받는 PC 가 옛 버전(그림 받는 길이 없음)이면 그림은 이 PC 주소로 적어 보내고 합치기는 끝낸다
  const src3 = await create(a);
  await a.sessions.showImage(src3, { path: '../proj/scene.png' }).catch(() => {});
  writeFileSync(join(a.sessions.info(src3)!.workdir, 'scene2.png'), Buffer.from('89504e470d0a1a0b', 'hex'));
  await a.sessions.showImage(src3, { path: 'scene2.png' });
  await a.sessions.handle({ type: 'user.message', sessionId: src3, text: '두 번째 작업' }, local);
  await new Promise<void>((r) => { const t = setInterval(() => { if (a.events.some((e: any) => e.type === 'turn.done' && e.sessionId === src3)) { clearInterval(t); r(); } }, 50); });
  const realPost = (a.sessions as any).peers.post;
  (a.sessions as any).peers.post = async (u: string, path: string, body: any) => { if (path === '/peer/image') throw new Error('그 PC 의 Agent Hub 가 옛 버전(업데이트 필요)'); return realPost(u, path, body); };
  await a.sessions.handle({ type: 'session.mergeIntoPeer', sessionId: src3, url: URL, targetId: dst } as any, local);
  const m3 = b.events.filter((e: any) => e.type === 'session.merged' && e.sessionId === dst).at(-1);
  assert.match(m3.text, /그림 \d+장 — 이 PC 가 옛 버전이라 함께 못 보냄/);
  assert.match(m3.text, /http:\/\/192\.168\.0\.5:4319\/images\//);
  assert.equal(a.sessions.info(src3)!.archived, true);
  // 그림을 보내다 끊기면 이 작업은 그대로(보관 안 함)
  const src4 = await create(a);
  writeFileSync(join(a.sessions.info(src4)!.workdir, 'scene4.png'), Buffer.from('89504e470d0a1a0c', 'hex'));
  await a.sessions.showImage(src4, { path: 'scene4.png' });
  (a.sessions as any).peers.post = async (u: string, path: string, body: any) => { if (path === '/peer/image') throw new Error('fetch failed'); return realPost(u, path, body); };
  await a.sessions.handle({ type: 'session.mergeIntoPeer', sessionId: src4, url: URL, targetId: dst } as any, local);
  assert.ok(!a.sessions.info(src4)!.archived);
  assert.ok(a.events.some((e: any) => e.type === 'error' && e.sessionId === src4 && /끊김/.test(e.message)));
  (a.sessions as any).peers.post = realPost;
  // 연결이 끊긴 PC 면 아무것도 바꾸지 않고 알린다
  const src2 = await create(a);
  (a.sessions as any).peers.all = async () => [{ url: URL, ok: false, error: '응답 없음' }];
  await a.sessions.handle({ type: 'session.mergeIntoPeer', sessionId: src2, url: URL, targetId: dst } as any, local);
  assert.ok(!a.sessions.info(src2)!.archived);
  assert.ok(a.events.some((e: any) => e.type === 'error' && e.sessionId === src2 && /끊김/.test(e.message)));
  a.sessions.stopAll(); b.sessions.stopAll();
});
