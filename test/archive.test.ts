import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/protocol.ts';

test('parseCommand: 보관·꺼내기', () => {
  assert.deepEqual(parseCommand({ type: 'session.archive', sessionId: 'a', archived: true }), { type: 'session.archive', sessionId: 'a', archived: true });
  assert.equal(parseCommand({ type: 'session.archive', sessionId: 'a' }), null);
  assert.equal(parseCommand({ type: 'session.archive', archived: true }), null);
});

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScheduleStore } from '../src/schedules.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const local = { via: 'local' as const, user: 'local' };

test('보관: 아래 작업까지 숨기고, 목록·보내기에서 빠지고, 예약은 건너뛰고, 다시 켜도 그대로', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub archive '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const make = () => {
    const schedules = new ScheduleStore(join(base, 'data', 'schedules.json'));
    const events: HostEvent[] = [];
    const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), schedules, makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
    sessions.subscribe((e) => events.push(e));
    return { sessions, events, schedules };
  };
  const { sessions, events, schedules } = make();
  await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '원본' }, local);
  const root = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  await sessions.handle({ type: 'session.rename', sessionId: root, title: '원본' }, local);
  await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '다른' }, local);
  const other = (await waitFor(events, (e) => e.type === 'session.created' && e.session.id !== root)).session.id;
  await sessions.handle({ type: 'session.rename', sessionId: other, title: '다른' }, local);
  assert.match(await sessions.taskSplitByMain(other, '원본 분담', root), /분담/);
  const split = (events.find((e) => e.type === 'session.created' && e.session.splitFrom === root) as any).session.id;
  const now = new Date();
  const sch = schedules.save({ sessionId: root, prompt: '매일 점검', repeat: 'interval', every: 5 }, new Date(now.getTime() - 10 * 60_000));

  await sessions.handle({ type: 'session.archive', sessionId: root, archived: true }, local);
  const archived = events.filter((e) => e.type === 'session.archived' && e.archived).map((e: any) => e.sessionId).sort();
  assert.deepEqual(archived, [root, split].sort()); // 아래 작업(분담)까지
  assert.deepEqual(sessions.taskList().map((t) => t.name), ['다른']);
  await assert.rejects(sessions.taskSendByMain(other, '원본', '안녕'), /없는 작업/);

  await sessions.runSchedules(new Date(now.getTime() + 60_000));
  assert.equal(schedules.list().find((x) => x.id === sch.id)?.lastResult, '보관 중이라 건너뜀');
  assert.equal(events.some((e) => e.type === 'user.message' && e.sessionId === root), false);

  // 다시 켜도 보관 그대로, 꺼내면 돌아온다
  const b = make();
  b.sessions.restore();
  assert.deepEqual(b.sessions.taskList().map((t) => t.name), ['다른']);
  await b.sessions.handle({ type: 'session.archive', sessionId: root, archived: false }, local);
  assert.deepEqual(b.sessions.taskList().map((t) => t.name).sort(), ['다른', '원본', '원본 분담'].sort());
  sessions.stopAll();
  b.sessions.stopAll();
});

test('계층 옮기기·합치기: 끌어 놓은 부모로 옮기고(새 부모에겐 옮긴 뒤부터 공유), 합치면 한 일을 넘기고 아래 작업을 옮기고 보관', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub tree '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.subscribe((e) => events.push(e));
  try {
    const mk = async (title: string) => {
      const n = events.filter((e) => e.type === 'session.created').length;
      await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title }, local);
      const id = (events.filter((e) => e.type === 'session.created')[n] as any).session.id;
      await sessions.handle({ type: 'session.rename', sessionId: id, title }, local);
      return id;
    };
    const say = async (id: string, text: string) => {
      const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
      await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
      await waitFor(events, () => events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length > n);
    };
    const a = await mk('가');
    const b = await mk('나');
    await say(b, '옛 일 OLD');
    // 나 를 가 아래로
    await sessions.handle({ type: 'session.reparent', sessionId: b, parentId: a }, local);
    assert.equal(sessions.info(b)?.splitFrom, a);
    await sessions.handle({ type: 'session.reparent', sessionId: a, parentId: b }, local); // 자기 아래 작업 밑으로는 못 감
    assert.equal(sessions.info(a)?.splitFrom, undefined);
    assert.ok(events.some((e) => e.type === 'error' && /옮길 수 없음/.test(e.message)));
    await say(b, '새 일 NEW');
    const toA = events.filter((e) => e.type === 'session.merged' && e.sessionId === a) as any[];
    assert.equal(toA.length, 1);
    assert.match(toA[0].text, /새 일 NEW/);
    assert.doesNotMatch(toA[0].text, /옛 일 OLD/); // 옮긴 뒤부터
    // 다 를 만들고 나 를 다 에 합치기: 나 의 일 전체가 다 로, 나 는 보관
    const c = await mk('다');
    await sessions.handle({ type: 'session.mergeInto', sessionId: b, targetId: c }, local);
    const toC = events.filter((e) => e.type === 'session.merged' && e.sessionId === c) as any[];
    assert.equal(toC.length, 1);
    assert.match(toC[0].text, /옛 일 OLD/);
    assert.equal(sessions.info(b)?.archived, true);
    // 맨 위로
    await sessions.handle({ type: 'session.reparent', sessionId: b, parentId: null }, local);
    assert.equal(sessions.info(b)?.splitFrom, undefined);
  } finally {
    sessions.stopAll();
  }
});

test('다른 PC 작업 아래로: 한 일이 그 PC 의 위 작업으로 공유되고, 받는 쪽은 하위 작업 공유로 받는다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub remote tree '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  const sent: any[] = [];
  sessions.peers = { summary: () => ({ name: 'pc2', tasks: [] }), shareUp: async (rp: any, body: any) => { sent.push({ rp, body }); } } as any;
  sessions.subscribe((e) => events.push(e));
  try {
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '해양VR' }, local);
    const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
    await sessions.handle({ type: 'session.rename', sessionId: id, title: '해양VR' }, local);
    await sessions.handle({ type: 'user.message', sessionId: id, text: '옮기기 전 OLD' }, local);
    await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === id);
    sessions.setRemoteParent(id, { url: 'http://192.168.0.5:4319', id: 'top-id', pc: 'pc1' });
    assert.equal(sessions.info(id)?.remoteParent?.id, 'top-id');
    await sessions.handle({ type: 'user.message', sessionId: id, text: '옮긴 뒤 NEW' }, local);
    await waitFor(events, () => sent.length > 0);
    assert.equal(sent[0].rp.id, 'top-id');
    assert.equal(sent[0].body.fromPc, 'pc2');
    assert.match(sent[0].body.text, /옮긴 뒤 NEW/);
    assert.doesNotMatch(sent[0].body.text, /옮기기 전 OLD/);
    await waitFor(events, (e) => e.type === 'session.remoteShared');

    // 받는 쪽
    sessions.receiveRemoteShare(id, 'pc9', 'x1', '조사', '사람(local): 조사함');
    const m = events.filter((e) => e.type === 'session.merged' && e.sessionId === id).at(-1) as any;
    assert.equal(m.title, 'pc9/조사');
    assert.throws(() => sessions.receiveRemoteShare('없음', 'pc9', 'x', 't', 'x'), /없는 작업/);
    sessions.setRemoteParent(id, null);
    assert.equal(sessions.info(id)?.remoteParent, undefined);
  } finally {
    sessions.stopAll();
  }
});
