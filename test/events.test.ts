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
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, '..', 'ui');
const freePort = () => new Promise<number>((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });

/** /events 를 열어 replay.done 까지(그리고 그 뒤 more 개 더) 받은 이벤트 */
async function readEvents(port: number, more = 0, onReplayed?: () => void): Promise<any[]> {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const out: any[] = [];
  let buf = '';
  let after = -1;
  while (after < more) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const ev = JSON.parse(chunk.slice(6));
      out.push(ev);
      if (after >= 0) after++;
      if (ev.type === 'replay.done') { after = 0; onReplayed?.(); }
    }
  }
  await reader.cancel().catch(() => {});
  ac.abort();
  return out;
}

test('화면 이벤트: 기록을 다시 보낸 뒤 replay.done, 이벤트마다 일어난 시각', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub events '));
  mkdirSync(join(base, 'ws', 'proj'), { recursive: true });
  const port = await freePort();
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const server = await startLocalServer({ port, uiDir: ui, sessions, info: { workspaceRoot: join(base, 'ws') } });
  t.after(async () => {
    sessions.stopAll();
    server.closeAllConnections();
    await new Promise((ok) => server.close(() => ok(null)));
  });
  const cmd = (body: object) => fetch(`http://127.0.0.1:${port}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const t0 = Date.now();
  assert.equal((await cmd({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' })).status, 202);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;

  // 이미 있던 작업은 replay.done 앞에, 시각과 함께
  const first = await readEvents(port);
  const done = first.findIndex((e) => e.type === 'replay.done');
  const created = first.findIndex((e) => e.type === 'session.created' && e.session.id === id);
  assert.ok(created >= 0 && created < done, '기록이 replay.done 보다 먼저');
  assert.equal(done, first.length - 1);
  assert.ok(first[created].at >= t0 - 1000 && first[created].at <= Date.now(), '일어난 시각(ms)');

  // replay.done 뒤에 오는 것은 새 소식
  const next = await readEvents(port, 1, () => void cmd({ type: 'user.message', sessionId: id, text: '안녕' }));
  const live = next.slice(next.findIndex((e) => e.type === 'replay.done') + 1);
  assert.equal(live[0].type, 'user.message');
  assert.equal(typeof live[0].at, 'number');
});
