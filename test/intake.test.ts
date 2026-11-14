import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { IntakeStore } from '../src/intake.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const local = { via: 'local' as const, user: 'local' };

test('입력 거치기: 사람 지시는 입력 세션이 먼저 받고, 정리본+원문으로 작업에 넘기거나 그 작업 화면에 묻는다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub intake '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.intake = new IntakeStore(join(base, 'data', 'intake.json'));
  sessions.subscribe((e) => events.push(e));
  try {
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '영업' }, local);
    const task = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
    await sessions.handle({ type: 'session.rename', sessionId: task, title: '영업' }, local);
    await sessions.handle({ type: 'session.setIntake', sessionId: task, on: true }, local);
    assert.equal(sessions.info(task)?.viaIntake, true);

    await sessions.handle({ type: 'user.message', sessionId: task, text: '위시켓 공고 지원해 줘' }, local);
    const intakeId = sessions.intake.sessionId!;
    assert.ok(intakeId && intakeId !== task);
    assert.equal(sessions.info(intakeId)?.customTitle, '입력');
    const req = (await waitFor(events, (e) => e.type === 'session.intake' && e.state === 'pending')) as any;
    assert.equal(req.sessionId, task);
    const toIntake = (await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === intakeId)) as any;
    assert.match(toIntake.text, /\[입력 요청 r\w+\] 작업 "영업"/);
    assert.match(toIntake.text, /\[사람 원문\]\n위시켓 공고 지원해 줘/);
    assert.equal(sessions.info(task)?.status === 'working', false); // 작업 AI 로는 아직 안 감

    // 입력 세션만 도구를 쓴다
    await assert.rejects(sessions.intakeForwardByMain(task, req.request, 'x'), /입력 세션만/);
    // 묻기 → 사람 답은 다시 입력 세션으로(앞 원문과 함께)
    sessions.intakeAskByMain(intakeId, req.request, '어느 공고요?');
    assert.ok(events.some((e) => e.type === 'session.intake' && e.state === 'asked' && e.text === '어느 공고요?'));
    await sessions.handle({ type: 'user.message', sessionId: task, text: '농업 체험 게임' }, local);
    const second = events.filter((e) => e.type === 'user.message' && e.sessionId === intakeId).at(-1) as any;
    assert.match(second.text, /어느 공고요\?/);
    assert.match(second.text, /위시켓 공고 지원해 줘/);
    const req2 = events.filter((e) => e.type === 'session.intake' && e.state === 'pending').at(-1) as any;

    // 넘기기: 작업은 정리본과 원문을 함께 받는다
    assert.match(await sessions.intakeForwardByMain(intakeId, req2.request, '위시켓 농업 체험 게임 공고에 지원서 초안을 쓴다. 제출 전 확인'), /영업 에 넘김/);
    const fwd = (await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === task && (e as any).from === '입력')) as any;
    assert.match(fwd.text, /^\[입력 세션이 정리한 지시\]\n위시켓 농업 체험/);
    assert.match(fwd.text, /\[사람 원문\]\n위시켓 공고 지원해 줘/);
    await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === task); // 이번엔 작업 AI 가 받아 일함
    await assert.rejects(sessions.intakeForwardByMain(intakeId, req2.request, 'x'), /없는 요청/); // 한 번만
    // / 명령은 그대로 작업으로
    const before = events.filter((e) => e.type === 'session.intake').length;
    await sessions.handle({ type: 'user.message', sessionId: task, text: '/compact' }, local);
    assert.equal(events.filter((e) => e.type === 'session.intake').length, before);
  } finally {
    sessions.stopAll();
  }
});
