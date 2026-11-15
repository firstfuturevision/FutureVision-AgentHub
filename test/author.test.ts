import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorOf } from '../src/transports/local.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const req = (headers: Record<string, string>, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } }) as any;
const key = 'k'.repeat(64);

test('쓴 사람: 중계 키가 맞을 때만 넘긴 이름을 믿고, 아니면 들어온 길만', () => {
  const name = encodeURIComponent('홍길동');
  assert.deepEqual(authorOf(req({ 'x-agent-hub-relay': key, 'x-agent-hub-user': name, 'x-agent-hub-via': encodeURIComponent('업무 웹') }), true, key), { name: '홍길동', path: '업무 웹' });
  assert.deepEqual(authorOf(req({ 'x-agent-hub-relay': key, 'x-agent-hub-user': name }), false, key), { name: '홍길동', path: '원격 연결' });
  // 키가 틀리거나 없으면 이름을 받지 않는다
  assert.deepEqual(authorOf(req({ 'x-agent-hub-relay': 'x'.repeat(64), 'x-agent-hub-user': name }), true, key), { path: '원격 연결' });
  assert.deepEqual(authorOf(req({ 'x-agent-hub-user': name }, '192.168.0.50'), true, key), { path: '원격 접속 · 192.168.0.50' });
  assert.deepEqual(authorOf(req({ 'x-agent-hub-relay': key, 'x-agent-hub-user': name }), true, undefined), { path: '원격 연결' });
  assert.deepEqual(authorOf(req({}), false, key), { path: '이 PC' });
  // 제어 문자는 빼고 길이는 자른다
  assert.equal(authorOf(req({ 'x-agent-hub-relay': key, 'x-agent-hub-user': encodeURIComponent('a\nb') + 'c'.repeat(100) }), true, key).name!.length, 60);
});

test('쓴 사람은 기록(user.message author)에만 남고 AI 에게 가는 글은 그대로', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub author '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.subscribe((e) => events.push(e));
  try {
    const origin = { via: 'local' as const, user: 'local', author: { name: '홍길동', path: '원격 연결' } };
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: 't' }, origin);
    const id = (await waitFor(events, (e) => e.type === 'session.created') as any).session.id;
    await sessions.handle({ type: 'user.message', sessionId: id, text: '되풀이: 안녕' }, origin);
    const m = await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === id) as any;
    assert.deepEqual(m.author, { name: '홍길동', path: '원격 연결' });
    await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === id);
    const said = events.filter((e) => e.type === 'agent.text' && e.sessionId === id && !(e as any).partial).map((e: any) => e.text).join('\n');
    assert.doesNotMatch(said, /홍길동/);
    // 원격 접속 앱(via)이 보낸 글은 그 연결 이름이 출처라 author 를 붙이지 않는다
    await sessions.handle({ type: 'user.message', sessionId: id, text: 'x', via: { app: '대시보드', label: '채팅' } }, origin);
    const v = events.filter((e) => e.type === 'user.message' && e.sessionId === id).at(-1) as any;
    assert.equal(v.author, undefined);
  } finally {
    sessions.stopAll();
  }
});
