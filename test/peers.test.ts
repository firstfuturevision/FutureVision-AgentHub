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
