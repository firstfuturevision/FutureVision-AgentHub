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

    await sessions.handle({ type: 'user.message', sessionId: task, text: '견적 사이트 공고 지원해 줘' }, local);
    const intakeId = sessions.intake.sessionId!;
    assert.ok(intakeId && intakeId !== task);
    assert.equal(sessions.info(intakeId)?.customTitle, '입력');
    assert.deepEqual(sessions.taskList().map((t) => t.name), ['영업']); // 입력 세션은 목록·보내기 대상에 안 보인다
    const req = (await waitFor(events, (e) => e.type === 'session.intake' && e.state === 'pending')) as any;
    assert.equal(req.sessionId, task);
    const toIntake = (await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === intakeId)) as any;
    assert.match(toIntake.text, /\[입력 요청 r\w+\] 작업 "영업"/);
    assert.match(toIntake.text, /\[사람 원문\]\n견적 사이트 공고 지원해 줘/);
    assert.equal(sessions.info(task)?.status === 'working', false); // 작업 AI 로는 아직 안 감

    // 입력 세션만 도구를 쓴다
    await assert.rejects(sessions.intakeForwardByMain(task, req.request, 'x'), /입력 세션만/);
    // 묻기 → 사람 답은 다시 입력 세션으로(앞 원문과 함께)
    sessions.intakeAskByMain(intakeId, req.request, '어느 공고요?');
    assert.ok(events.some((e) => e.type === 'session.intake' && e.state === 'asked' && e.text === '어느 공고요?'));
    await sessions.handle({ type: 'user.message', sessionId: task, text: '농업 체험 게임' }, local);
    const second = events.filter((e) => e.type === 'user.message' && e.sessionId === intakeId).at(-1) as any;
    assert.match(second.text, /어느 공고요\?/);
    assert.match(second.text, /견적 사이트 공고 지원해 줘/);
    const req2 = events.filter((e) => e.type === 'session.intake' && e.state === 'pending').at(-1) as any;

    // 넘기기: 작업은 정리본과 원문을 함께 받는다
    assert.match(await sessions.intakeForwardByMain(intakeId, req2.request, '견적 사이트 농업 체험 게임 공고에 지원서 초안을 쓴다. 제출 전 확인'), /영업 에 넘김/);
    const fwd = (await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === task && (e as any).from === '입력')) as any;
    assert.match(fwd.text, /^\[입력 세션이 정리한 지시\]\n견적 사이트 농업 체험/);
    assert.match(fwd.text, /\[사람 원문\]\n견적 사이트 공고 지원해 줘/);
    await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === task); // 이번엔 작업 AI 가 받아 일함
    await assert.rejects(sessions.intakeForwardByMain(intakeId, req2.request, 'x'), /없는 요청/); // 한 번만
    // 설정 → 입력의 최근 정리: 물음과 넘김이 원문·정리본·작업과 함께 남는다(최근 것 먼저)
    const recent = sessions.intake.public().recent;
    assert.deepEqual(recent.map((x) => x.state), ['forwarded', 'asked']);
    assert.equal(recent[0].target, '영업');
    assert.match(recent[0].text, /농업 체험/);
    assert.match(recent[1].original, /견적 사이트/);
    // 바깥 시스템(업무 웹 채팅 호출)·다른 PC 작업이 보낸 글은 입력 세션을 거치지 않고 바로, 다른 PC 에서 사람이 보낸 글은 거친다
    const n0 = events.filter((e) => e.type === 'session.intake').length;
    await sessions.handle({ type: 'user.message', sessionId: task, text: '[업무 웹 채팅 · #일반 · 보낸 사람: 관리자(admin) · 대표] 태스크 추가해 줘', via: { app: '대시보드', label: '채팅 #일반' } }, local);
    await sessions.handle({ type: 'user.message', sessionId: task, text: '다른 PC 작업이 보냄', via: { app: 'Agent Hub shlee', label: '작업 해양VR' } }, local);
    assert.equal(events.filter((e) => e.type === 'session.intake').length, n0);
    await sessions.handle({ type: 'user.message', sessionId: task, text: '다른 PC 사람이 보냄', via: { app: 'Agent Hub shlee', label: '사람' } }, local);
    assert.equal(events.filter((e) => e.type === 'session.intake').length, n0 + 1);
    // / 명령은 그대로 작업으로
    const before = events.filter((e) => e.type === 'session.intake').length;
    await sessions.handle({ type: 'user.message', sessionId: task, text: '/compact' }, local);
    assert.equal(events.filter((e) => e.type === 'session.intake').length, before);
  } finally {
    sessions.stopAll();
  }
});

test('새 작업 기본 입력 거치기: 켜 두면 이 화면에서 사람이 만든 작업만 켜진 채로, 바깥 시스템·입력 세션 자신은 빼고', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub intake new '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.intake = new IntakeStore(join(base, 'data', 'intake.json'));
  sessions.subscribe((e) => events.push(e));
  const made = async (cmd: any, origin = local) => {
    const n = events.filter((e) => e.type === 'session.created').length;
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', ...cmd }, origin);
    return (events.filter((e) => e.type === 'session.created')[n] as any).session;
  };
  try {
    assert.equal(sessions.intake.newTasksOn, false); // 처음 설치는 꺼짐
    assert.equal((await made({ title: '꺼짐' })).viaIntake, undefined);
    sessions.intake.setNewTasksOn(true);
    const t = await made({ title: '새 작업' });
    assert.equal(t.viaIntake, true);
    assert.equal((await made({ title: '대시보드', via: { app: '대시보드', label: '프로젝트 A' } })).viaIntake, undefined);
    assert.equal((await made({ title: '예약' }, { via: 'local' as const, user: '예약' })).viaIntake, undefined);
    // 첫 지시가 입력 세션을 거치고, 입력 세션 자신은 켜지지 않는다
    await sessions.handle({ type: 'user.message', sessionId: t.id, text: '첫 지시' }, local);
    const intakeId = sessions.intake.sessionId!;
    assert.equal(sessions.info(intakeId)?.viaIntake, undefined);
    const toIntake = (await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === intakeId)) as any;
    assert.match(toIntake.text, /역할: 비어 있음\(새 작업이면/);
    assert.equal(new IntakeStore(join(base, 'data', 'intake.json')).newTasksOn, true); // 다시 켜도 그대로
  } finally {
    sessions.stopAll();
  }
});

test('입력 거치기 모두 켜기: 입력 세션 자신·보관한 작업은 빼고, 켜도 예약·다른 작업·/ 명령·대시보드 글은 바로', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub intake all '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.intake = new IntakeStore(join(base, 'data', 'intake.json'));
  sessions.subscribe((e) => events.push(e));
  const made = async (title: string) => {
    const n = events.filter((e) => e.type === 'session.created').length;
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title }, local);
    const id = (events.filter((e) => e.type === 'session.created')[n] as any).session.id;
    await sessions.handle({ type: 'session.rename', sessionId: id, title }, local);
    return id;
  };
  try {
    const a = await made('영업');
    const b = await made('채팅 담당');
    const c = await made('옛 작업');
    await sessions.handle({ type: 'session.archive', sessionId: c, archived: true }, local);
    const r = sessions.setIntakeMany(true, undefined, true);
    assert.deepEqual(r.changed.sort(), ['영업', '채팅 담당'].sort());
    assert.ok(r.skipped.includes('옛 작업'));
    assert.equal(sessions.info(c)?.viaIntake, undefined);
    // 바로 가야 하는 글: 예약, 다른 작업, / 명령, 대시보드 @에이전트
    const n0 = events.filter((e) => e.type === 'session.intake').length;
    await sessions.handle({ type: 'user.message', sessionId: a, text: '[예약] 점검' }, { via: 'local', user: '예약' });
    await sessions.handle({ type: 'user.message', sessionId: a, text: '전달' }, { via: 'local', user: '작업 Future Vision' });
    await sessions.handle({ type: 'user.message', sessionId: a, text: '/compact' }, local);
    await sessions.handle({ type: 'user.message', sessionId: b, text: '[업무 웹 채팅 · #일반] 질문', via: { app: '대시보드', label: '채팅 #일반' } }, local);
    assert.equal(events.filter((e) => e.type === 'session.intake').length, n0);
    // 도구로 하나 끄기, 모두 끄기
    assert.match(sessions.intakeByMain(a, false, '채팅 담당'), /끔: 채팅 담당/);
    assert.match(sessions.intakeByMain(a, false, undefined, true), /끔: 영업/);
    assert.throws(() => sessions.intakeByMain(a, 'yes' as any), /true\/false/);
  } finally {
    sessions.stopAll();
  }
});
