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
    assert.equal(await peers.send('pc2', '영업', '안녕', 'Future Vision'), 'pc2 의 영업 에 보냄');
    assert.equal(got[0].type, 'user.message');
    assert.equal(got[0].sessionId, 'abcdef12-0000-0000-0000-000000000000');
    assert.equal(got[0].via.label, '작업 Future Vision');
    await assert.rejects(peers.send('pc2', '없는작업', 'x', 'a'), /없는 작업/);
    await assert.rejects(peers.send('pc9', '영업', 'x', 'a'), /연결된 PC 가 아님/);
    peers.remove(url);
    assert.deepEqual(peers.urls(), []);
  } finally {
    srv.close();
  }
});
