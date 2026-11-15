import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

test('쉬는 작업 내리기: 오래 쉰 CLI 를 내리고 다음 지시에 같은 대화로 이어 띄운다. 이어 갈 수 없거나 아래에 도는 프로세스가 있으면 두고, 한도를 넘으면 오래 쉰 것부터', { skip: process.platform !== 'linux' && process.platform !== 'darwin' && 'Windows 는 내리지 않음' }, async () => {
  const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const base = mkdtempSync(join(tmpdir(), 'agent hub sleep '));
  const ws = join(base, 'ws');
  const home = join(base, 'claude-home');
  mkdirSync(ws);
  mkdirSync(join(home, 'projects', 'p'), { recursive: true });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), claudeHome: home, makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.subscribe((e) => events.push(e));
  const local = { via: 'local' as const, user: 'local' };
  const make = async (title: string) => {
    const n = events.filter((e) => e.type === 'session.created').length;
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title }, local);
    await waitFor(events, () => events.filter((e) => e.type === 'session.created').length > n);
    const id = (events.filter((e) => e.type === 'session.created').at(-1) as any).session.id as string;
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    return id;
  };
  const say = async (id: string, text: string) => {
    const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
    await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
    await waitFor(events, () => events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length > n);
    return (events.filter((e) => e.type === 'agent.text' && e.sessionId === id && !(e as any).partial).at(-1) as any).text as string;
  };
  const transcript = (id: string) => writeFileSync(join(home, 'projects', 'p', `${sessions.info(id)!.cliSessionId}.jsonl`), '{}\n');
  try {
    const a = await make('가');
    const b = await make('나');
    const c = await make('다');
    for (const id of [a, b, c]) await say(id, '안녕');
    transcript(a);
    transcript(c);
    await say(c, '자식 띄움');
    const later = Date.now() + 31 * 60_000;
    assert.deepEqual(sessions.sleepIdle(later), [], '꺼 두면 아무것도 안 함');
    sessions.sleepIdleMinutes = 30;
    assert.deepEqual(sessions.sleepIdle(Date.now()), [], '아직 30분 안 됨');
    // b: Claude 대화 기록이 없어 이어 갈 수 없음 → 둠. c: 아래에 도는 프로세스 → 둠
    assert.deepEqual(sessions.sleepIdle(later), [a]);
    const cli = sessions.info(a)!.cliSessionId;
    assert.equal(sessions.info(a)!.status, 'idle');
    // 다음 지시: 같은 대화(--resume)로 다시 떠서 답한다. 끝남 줄은 남기지 않는다
    assert.match(await say(a, '다시'), /./);
    assert.equal(sessions.info(a)!.cliSessionId, cli);
    assert.equal(events.some((e) => e.type === 'session.ended' && e.sessionId === a), false);
    // 한도: 떠 있는 것이 maxAwake 를 넘으면 1분 넘게 쉰 것 중 오래 쉰 것부터(이어 갈 수 있는 것만)
    sessions.sleepIdleMinutes = 0;
    sessions.maxAwake = 2;
    assert.deepEqual(sessions.sleepIdle(Date.now() + 2 * 60_000), [a]);
  } finally {
    sessions.stopAll();
  }
});
