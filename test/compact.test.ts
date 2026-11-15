import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager, isCompactRequest } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { AcpAdapter } from '../src/adapters/acp.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('컨텍스트 정리 부탁: 글 전체가 그 말일 때만', () => {
  for (const t of ['컨텍스트 정리해줘', '컨텍스트 정리해 줘.', '대화 정리', '대화 기록 정리해 주세요', '/compact', '/컨텍스트 정리', 'compact the context']) assert.ok(isCompactRequest(t), t);
  for (const t of ['컨텍스트 정리해줘 그리고 테스트 돌려', '대화 정리해서 보고서로 써줘', '정리해줘', '이 폴더 정리해줘']) assert.equal(isCompactRequest(t), false, t);
});

function world(kind: 'claude' | 'acp') {
  const base = mkdtempSync(join(tmpdir(), 'agent hub compact '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: ws, dataDir: join(base, 'data'), claudeHome: join(base, 'home'),
    makeAdapter: () => kind === 'claude'
      ? new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' })
      : new AcpAdapter({ label: 'Gemini', command: process.execPath, args: [join(here, 'fake-acp.mjs'), 'normal'] }),
  });
  sessions.subscribe((e) => events.push(e));
  const local = { via: 'local' as const, user: 'local' };
  const say = async (id: string, text: string) => {
    const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
    await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
    await waitFor(events, () => events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length > n);
    return (events.filter((e) => e.type === 'agent.text' && e.sessionId === id && !(e as any).partial).at(-1) as any).text as string;
  };
  return { sessions, events, local, say };
}

test('컨텍스트 정리 · Claude: 보통 지시로 보내지 않고 /compact(남길 것 붙여) → 앞뒤 토큰, 기록은 남고 다음 지시는 같은 대화', async () => {
  const { sessions, events, local, say } = world('claude');
  try {
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '정리' }, local);
    const id = (await waitFor(events, (e) => e.type === 'session.created') as any).session.id as string;
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    await say(id, '첫 지시');
    const cli = sessions.info(id)!.cliSessionId;
    await sessions.handle({ type: 'user.message', sessionId: id, text: '컨텍스트 정리해 줘' }, local);
    const done = await waitFor(events, (e) => e.type === 'session.compacted' && e.sessionId === id) as any;
    assert.deepEqual([done.mode, done.before, done.after, done.unit], ['cli', 28661, 12583, 'tokens']);
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    assert.match(await say(id, '정리할 때 받은 것?'), /정리 지시: 정리본에 꼭 남길 것: 이 작업의 역할, 진행 중이던 일과 남은 할 일/);
    assert.equal(sessions.info(id)!.cliSessionId, cli);
    assert.ok(events.some((e) => e.type === 'user.message' && e.sessionId === id && e.text === '첫 지시'), '정리 전 기록은 남는다');
    // 일하는 중에 부탁하면 그 차례가 끝난 뒤에 정리한다
    await sessions.handle({ type: 'user.message', sessionId: id, text: 'stream 20' }, local);
    await waitFor(events, () => sessions.info(id)?.status === 'working');
    await sessions.handle({ type: 'user.message', sessionId: id, text: '/compact' }, local);
    assert.ok(events.some((e) => e.type === 'session.compacting' && e.sessionId === id && (e as any).queued));
    const n = events.filter((e) => e.type === 'session.compacted' && e.sessionId === id).length;
    await waitFor(events, () => events.filter((e) => e.type === 'session.compacted' && e.sessionId === id).length > n);
    const order = events.filter((e) => e.sessionId === id && (e.type === 'turn.done' || e.type === 'session.compacted')).slice(-3).map((e) => e.type);
    assert.deepEqual(order.slice(0, 2), ['turn.done', 'session.compacted']);
  } finally {
    sessions.stopAll();
  }
});

test('컨텍스트 정리 · 정리 기능을 쓰지 않는 AI(ACP): 에이전트가 쓴 정리본으로 새 대화 — 다음 지시엔 정리본 + 그 뒤 대화만 붙는다', async () => {
  const { sessions, events, local, say } = world('acp');
  try {
    await sessions.handle({ type: 'session.create', agent: 'gemini', role: 'main', title: '정리' }, local);
    const id = (await waitFor(events, (e) => e.type === 'session.created') as any).session.id as string;
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    await say(id, '바나나 라는 말을 기억해');
    await sessions.handle({ type: 'session.compact', sessionId: id }, local);
    const done = await waitFor(events, (e) => e.type === 'session.compacted' && e.sessionId === id) as any;
    assert.equal(done.mode, 'summary');
    assert.equal(done.error, undefined);
    assert.match(done.summary, /컨텍스트 정리/);
    assert.ok(done.before > 0 && done.after > 0);
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    const r = await say(id, '이어서');
    assert.match(r, /\[앞 대화 정리본\]/);
    assert.equal(r.includes('사람(local): 바나나'), false, '정리 전 대화 원문은 다시 붙지 않는다');
  } finally {
    sessions.stopAll();
  }
});
