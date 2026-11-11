import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextRun, ScheduleStore } from '../src/schedules.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { PresetStore } from '../src/presets.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-claude.mjs');
const local = { via: 'local' as const, user: 'local' };
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'agent hub sched ')), 'schedules.json');
// 2026-11-10(화) 10:00 현지 시각
const TUE10 = new Date(2026, 10, 10, 10, 0, 0);

test('다음 실행 시각: 한 번·매일·평일·매주', () => {
  const at = (d: Date | null) => d && `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(at(nextRun({ repeat: 'daily', time: '09:00' }, TUE10)), '11/11 9:00'); // 오늘 9시는 지남 → 내일
  assert.equal(at(nextRun({ repeat: 'daily', time: '10:30' }, TUE10)), '11/10 10:30');
  assert.equal(at(nextRun({ repeat: 'daily', time: '10:00' }, TUE10)), '11/11 10:00'); // 같은 시각은 지난 것으로
  const fri = new Date(2026, 10, 13, 18, 0);
  assert.equal(at(nextRun({ repeat: 'weekdays', time: '09:00' }, fri)), '11/16 9:00'); // 금요일 저녁 → 월요일
  assert.equal(at(nextRun({ repeat: 'weekly', time: '09:00', weekday: 1 }, TUE10)), '11/16 9:00'); // 다음 월요일
  assert.equal(at(nextRun({ repeat: 'weekly', time: '11:00', weekday: 2 }, TUE10)), '11/10 11:00'); // 오늘(화) 아직 안 지남
  assert.equal(at(nextRun({ repeat: 'once', time: '09:00', date: '2026-11-12' }, TUE10)), '11/12 9:00');
  assert.equal(nextRun({ repeat: 'once', time: '09:00', date: '2026-11-10' }, TUE10), null);
});

test('예약 저장: 확인 · 고치기 · 실행 기록 · 한 번짜리는 끝나면 꺼짐', () => {
  const file = tmpFile();
  const store = new ScheduleStore(file, TUE10);
  assert.throws(() => store.save({ sessionId: 's1', prompt: '', repeat: 'daily', time: '09:00' }, TUE10), /지시/);
  assert.throws(() => store.save({ sessionId: 's1', prompt: 'x', repeat: 'daily', time: '9시' }, TUE10), /HH:MM/);
  assert.throws(() => store.save({ sessionId: 's1', prompt: 'x', repeat: 'weekly', time: '09:00' }, TUE10), /요일/);
  assert.throws(() => store.save({ sessionId: 's1', prompt: 'x', repeat: 'once', time: '09:00', date: '2026-11-10' }, TUE10), /지난/);

  const d = store.save({ sessionId: 's1', prompt: '어제 메일 정리', repeat: 'daily', time: '09:00' }, TUE10);
  assert.equal(new Date(d.nextAt!).getDate(), 11);
  const o = store.save({ sessionId: 's1', prompt: '보고서 제출', repeat: 'once', time: '11:00', date: '2026-11-10' }, TUE10);
  assert.equal(store.forSession('s1').length, 2);

  // 끄면 다음 시각 없음, 다시 켜면 생김
  store.save({ id: d.id, enabled: false }, TUE10);
  assert.equal(store.forSession('s1').find((x) => x.id === d.id)?.nextAt, null);
  store.save({ id: d.id, enabled: true }, TUE10);
  assert.ok(store.forSession('s1').find((x) => x.id === d.id)?.nextAt);

  // 11시: 한 번짜리만 차례
  const at11 = new Date(2026, 10, 10, 11, 0, 30);
  assert.deepEqual(store.due(at11).map((x) => x.id), [o.id]);
  store.markRun(o.id, at11, '보냄', 's2');
  const ran = store.list().find((x) => x.id === o.id)!;
  assert.equal(ran.sessionId, 's2'); // 작업을 따라간다
  assert.equal(ran.enabled, false);
  assert.equal(ran.nextAt, null);
  assert.equal(ran.lastResult, '보냄');
  assert.equal(store.due(at11).length, 0);

  store.removeForSession('s1');
  assert.deepEqual(store.list().map((x) => x.id), [o.id]);
});

test('호스트가 꺼져 있던 동안 지난 예약은 몰아서 실행하지 않고 다음 시각으로', () => {
  const file = tmpFile();
  new ScheduleStore(file, TUE10).save({ sessionId: 's1', prompt: 'x', repeat: 'daily', time: '10:30' }, TUE10);
  const later = new Date(2026, 10, 12, 8, 0); // 이틀 뒤 아침에 다시 켬
  const again = new ScheduleStore(file, later);
  assert.equal(again.due(later).length, 0);
  const s = again.list()[0];
  assert.equal(new Date(s.nextAt!).getDate(), 12);
  assert.match(s.lastResult ?? '', /건너뜀/);
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub sched run '));
  const ws = join(base, 'workspace');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  const events: HostEvent[] = [];
  const schedules = new ScheduleStore(join(base, 'data', 'schedules.json'), TUE10);
  const presets = new PresetStore(join(base, 'data', 'presets.json'));
  const sessions = new SessionManager({
    workspaceRoot: ws,
    dataDir: join(base, 'data'),
    schedules,
    presets,
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  return { sessions, events, schedules, presets };
}

test('예약 실행: 진행 중인 작업이면 그 작업에 보낸다', async () => {
  const { sessions, events, schedules } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  schedules.save({ sessionId: id, prompt: '아침 점검', repeat: 'daily', time: '10:30' }, TUE10);

  await sessions.runSchedules(new Date(2026, 10, 10, 10, 0)); // 아직
  assert.ok(!events.some((e) => e.type === 'user.message'));

  await sessions.runSchedules(new Date(2026, 10, 10, 10, 30, 5));
  const msg = await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === id);
  assert.equal(msg.text, '아침 점검');
  assert.equal(msg.from, '예약');
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text === 'turn 1: 아침 점검');
  assert.ok(events.some((e) => e.type === 'schedules.changed'));
  const s = schedules.forSession(id)[0];
  assert.equal(s.lastResult, '보냄');
  assert.equal(new Date(s.nextAt!).getDate(), 11);
  sessions.stopAll();
});

test('예약 실행: 끝난 작업이면 이어서 새로 시작하고 예약도 옮겨 간다 · 에이전트 설정을 이어받는다', async () => {
  const { sessions, events, schedules, presets } = setup();
  const p = presets.save({ name: '메일 담당', agent: 'claude', description: '', instructions: '메일만 정리한다' });
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', preset: p.id, workdir: 'proj' }, local);
  const orig = (await waitFor(events, (e) => e.type === 'session.created')).session;
  await sessions.handle({ type: 'user.message', sessionId: orig.id, text: 'hi' }, local);
  await waitFor(events, (e) => e.type === 'turn.done');
  await sessions.handle({ type: 'session.stop', sessionId: orig.id }, local);
  await waitFor(events, (e) => e.type === 'session.ended' && e.sessionId === orig.id);
  schedules.save({ sessionId: orig.id, prompt: '오늘 메일', repeat: 'daily', time: '10:30' }, TUE10);

  await sessions.runSchedules(new Date(2026, 10, 10, 10, 30, 5));
  const copy = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === orig.id)).session;
  assert.equal(copy.preset?.id, p.id); // 에이전트(전용 프로필·역할)를 이어받는다
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === copy.id);
  assert.match(reply.text, /메일만 정리한다/); // 역할 지침
  assert.match(reply.text, /사람\(local\): hi/); // 앞 대화
  assert.match(reply.text, /오늘 메일$/);
  const s = schedules.list()[0];
  assert.equal(s.sessionId, copy.id);
  assert.match(s.lastResult ?? '', /새로 시작/);

  // 작업을 지우면 그 작업의 예약도 지운다
  await sessions.handle({ type: 'session.delete', sessionId: copy.id }, local);
  assert.equal(schedules.list().length, 0);
  sessions.stopAll();
});

test('간격 예약: N분마다, 5분 미만은 안 되고, 작업이 일하는 중이면 그 차례는 건너뛴다', async () => {
  const st = new ScheduleStore(tmpFile());
  assert.throws(() => st.save({ sessionId: 'x', prompt: 'p', repeat: 'interval', every: 3 }, TUE10), /5분 이상/);
  const s = st.save({ sessionId: 'x', prompt: '상태 확인', repeat: 'interval', every: 90 }, TUE10);
  assert.equal(new Date(s.nextAt!).getTime(), TUE10.getTime() + 90 * 60_000);
  assert.equal(nextRun(s, new Date(2026, 10, 10, 12, 0))?.getTime(), new Date(2026, 10, 10, 13, 30).getTime());

  const { sessions, events, schedules } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  schedules.save({ sessionId: id, prompt: '확인', repeat: 'interval', every: 30 }, TUE10);
  (sessions as any).sessions.get(id).info.status = 'working'; // 앞 일이 아직 안 끝남
  await sessions.runSchedules(new Date(2026, 10, 10, 10, 30, 5));
  let x = schedules.forSession(id)[0];
  assert.equal(x.lastResult, '작업 중이라 건너뜀');
  assert.ok(!events.some((e) => e.type === 'user.message'));
  assert.equal(new Date(x.nextAt!).getTime(), new Date(2026, 10, 10, 11, 0, 5).getTime());

  (sessions as any).sessions.get(id).info.status = 'idle';
  await sessions.runSchedules(new Date(2026, 10, 10, 11, 0, 10));
  await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === id && e.text === '확인');
  x = schedules.forSession(id)[0];
  assert.equal(x.lastResult, '보냄');
  sessions.stopAll();
});
