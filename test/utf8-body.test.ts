import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { MemoryStore } from '../src/memory.ts';
import { startLocalServer } from '../src/transports/local.ts';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const freePort = () => new Promise<number>((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });

/** 본문을 여러 바이트 글자 한가운데에서 잘라 두 조각으로 보낸다(망을 건너온 긴 글처럼) */
function postSplit(port: number, path: string, body: object): Promise<number> {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  // 가운뎃점(·, 2바이트) 첫 바이트 바로 뒤에서 자른다
  const cut = buf.indexOf(Buffer.from('·', 'utf8')) + 1;
  assert.ok(cut > 0);
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': buf.length } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); });
    req.on('error', fail);
    req.write(buf.subarray(0, cut));
    setTimeout(() => req.end(buf.subarray(cut)), 30); // 서버가 앞 조각을 따로 받게
  });
}

test('긴 한글 본문이 조각 경계에서 잘려 와도 글자가 그대로(기억 맞추기 · 작업에 보내기)', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub utf8 '));
  mkdirSync(join(base, 'ws'));
  const memory = new MemoryStore(join(base, 'data', 'memory.json'));
  const sessions = new SessionManager({ workspaceRoot: join(base, 'ws'), dataDir: join(base, 'data') });
  const port = await freePort();
  const server = await startLocalServer({ port, uiDir: ui, sessions, memory, info: {} });
  t.after(async () => { sessions.stopAll(); server.closeAllConnections(); await new Promise((ok) => server.close(() => ok(null))); });

  const text = `${'가나다라마바사 '.repeat(30)}앞·뒤 첫째·둘째·셋째`; // 300자 안(기억 한 줄 한도)
  assert.equal(await postSplit(port, '/memory', { action: 'replaceShared', guide: '', items: [text], by: '시험' }), 200);
  const got = memory.public().items[0].text;
  assert.doesNotMatch(got, /�/);
  assert.equal(got, text.replace(/\s+/g, ' ').trim());
  const short = '범위·수량·금액·기간을 다시 읽는다';
  assert.equal(await postSplit(port, '/memory', { action: 'add', text: short }), 200);
  assert.ok(memory.public().items.some((x) => x.text === short));
});
