import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const local = { via: 'local' as const, user: 'local' };

function world() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub perm '));
  mkdirSync(join(base, 'ws', 'proj'), { recursive: true });
  const make = () => {
    const events: HostEvent[] = [];
    const sessions = new SessionManager({
      workspaceRoot: join(base, 'ws'),
      dataDir: join(base, 'data'),
      makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
    });
    sessions.subscribe((e) => events.push(e));
    return { sessions, events };
  };
  return { make };
}

test('권한 묻지 않기(모든 작업): 켜면 기다리던 요청도 허용, 새 요청은 바로 허용, 다시 켜도 그대로', async () => {
  const { make } = world();
  const a = make();
  await a.sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const sid = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;

  // 꺼져 있으면 묻는다
  await a.sessions.handle({ type: 'user.message', sessionId: sid, text: 'perm 하나' }, local);
  const req = await waitFor(a.events, (e) => e.type === 'permission.request');
  assert.ok(!a.events.some((e) => e.type === 'permission.resolved'));

  // 켜면 기다리던 요청을 바로 허용
  a.sessions.setAutoApproveAll(true);
  const res = await waitFor(a.events, (e) => e.type === 'permission.resolved' && e.requestId === (req as any).requestId);
  assert.equal((res as any).allow, true);
  assert.equal((res as any).by, '자동 허용');
  await waitFor(a.events, (e) => e.type === 'agent.tool_result' && /읽음/.test(e.summary));
  await waitFor(a.events, (e) => e.type === 'turn.done');

  // 새 요청: 묻지 않고 허용
  const before = a.events.length;
  await a.sessions.handle({ type: 'user.message', sessionId: sid, text: 'perm 둘' }, local);
  await waitFor(a.events, (e) => a.events.indexOf(e) >= before && e.type === 'agent.tool_result' && /읽음/.test(e.summary));
  const fresh = a.events.slice(before);
  assert.ok(fresh.some((e) => e.type === 'permission.resolved' && e.by === '자동 허용'));
  // 자동 허용할 요청은 표시가 붙어 화면에 카드로 올라가지 않고, 번호는 앞 요청과 겹치지 않는다
  const req2 = fresh.find((e) => e.type === 'permission.request') as any;
  assert.equal(req2.auto, true);
  assert.equal((req as any).auto, undefined);
  assert.notEqual(req2.requestId, (req as any).requestId);
  a.sessions.stopAll();

  // 다시 켜도(호스트 재시작) 켜진 채로
  const b = make();
  assert.equal(b.sessions.autoApproveAll, true);
  b.sessions.setAutoApproveAll(false);
  assert.equal(make().sessions.autoApproveAll, false);
});
