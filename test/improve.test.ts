import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager, digest, friendlyError } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { Updater } from '../src/update.ts';
import { ScheduleStore } from '../src/schedules.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const local = { via: 'local' as const, user: 'local' };
const phone = { via: 'dashboard' as const, user: '홍길동' };

function world() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub improve '));
  mkdirSync(join(base, 'ws', 'proj'), { recursive: true });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    schedules: new ScheduleStore(join(base, 'data', 'schedules.json')),
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const create = async () => {
    const n = events.filter((e) => e.type === 'session.created').length;
    await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj' }, local);
    return (await waitFor(events, (e) => e.type === 'session.created' && events.filter((x) => x.type === 'session.created').indexOf(e) === n)).session.id as string;
  };
  return { sessions, events, create };
}

test('작업별 권한: 읽기만·늘 묻기가 "권한 묻지 않기(모든 작업)"보다 앞서고, 푸는 것은 PC 앞에서만', async () => {
  const { sessions, events, create } = world();
  sessions.setAutoApproveAll(true);
  const sid = await create();

  await sessions.handle({ type: 'session.configure', sessionId: sid, permMode: 'readonly' }, phone); // 조이는 것은 어디서든
  assert.equal(sessions.info(sid)?.permMode, 'readonly');
  await sessions.handle({ type: 'user.message', sessionId: sid, text: 'perm 하나' }, local);
  const res = await waitFor(events, (e) => e.type === 'permission.resolved' && e.sessionId === sid);
  assert.equal(res.allow, false);
  assert.equal(res.by, '읽기만');
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === sid);

  // 늘 묻기: 새 작업에서(설정을 바꾼 작업은 다음 지시 앞에 앞 대화가 붙는다)
  const sid2 = await create();
  await sessions.handle({ type: 'session.configure', sessionId: sid2, permMode: 'ask' }, local);
  const before = events.length;
  await sessions.handle({ type: 'user.message', sessionId: sid2, text: 'perm 둘' }, local);
  const req = await waitFor(events, (e) => events.indexOf(e) >= before && e.type === 'permission.request');
  assert.equal(req.auto, undefined); // 화면에 승인 카드로
  sessions.setAutoApproveAll(true); // 모든 작업 스위치를 다시 켜도 이 작업의 요청은 그대로 기다린다
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!events.slice(before).some((e) => e.type === 'permission.resolved'));
  assert.equal(sessions.sessionInfoByMain(sid2).asksPermission, true);
  await sessions.handle({ type: 'permission.respond', sessionId: sid2, requestId: req.requestId, allow: true }, local);
  await waitFor(events, (e) => events.indexOf(e) >= before && e.type === 'turn.done');

  // 푸는 것은 PC 앞에서만
  const errs = events.length;
  await sessions.handle({ type: 'session.configure', sessionId: sid2, permMode: null }, phone);
  assert.equal(sessions.info(sid2)?.permMode, 'ask');
  assert.ok(events.slice(errs).some((e) => e.type === 'error' && /PC 앞에서만/.test(e.message)));
  sessions.stopAll();
});

test('공유 요약: 차례마다 사람 지시와 마지막 보고만, 다른 갈래의 공유는 줄여서 이어 넘긴다', () => {
  const ev = (e: any) => e as HostEvent;
  const out = digest([
    ev({ type: 'user.message', sessionId: 's', text: '사이트맵 고쳐줘', from: 'local' }),
    ev({ type: 'agent.text', sessionId: 's', text: 'Now tests.', partial: false }),
    ev({ type: 'agent.tool', sessionId: 's', toolId: 't', name: 'Bash', input: {} }),
    ev({ type: 'agent.text', sessionId: 's', text: '고쳤습니다. 사이트맵에 3개 추가.', partial: false }),
    ev({ type: 'turn.done', sessionId: 's', durationMs: 1 }),
    ev({ type: 'session.merged', sessionId: 's', fromId: 'x', title: '홈페이지', text: 'a'.repeat(5000), lines: 0, kind: 'split' }),
    ev({ type: 'user.message', sessionId: 's', text: '푸시해', from: '예약' }),
    ev({ type: 'agent.text', sessionId: 's', text: '푸시함', partial: false }),
  ]);
  assert.equal(out[0], '사람(local): 사이트맵 고쳐줘');
  assert.equal(out[1], '에이전트: 고쳤습니다. 사이트맵에 3개 추가.');
  assert.ok(!out.join('\n').includes('Now tests.'));
  assert.match(out[2], /^\[분담 공유: 홈페이지\]/);
  assert.ok(out[2].length < 3200);
  assert.deepEqual(out.slice(3), ['사람(예약): 푸시해', '에이전트: 푸시함']);
});

test('메인이 다른 작업 다루기: 목록·보내기·분담·다른 작업에 예약, 읽기만인 작업은 못 함', async () => {
  const { sessions, events, create } = world();
  const a = await create();
  await sessions.handle({ type: 'session.rename', sessionId: a, title: 'Dashboard' }, local);
  const b = await create();
  await sessions.handle({ type: 'session.rename', sessionId: b, title: '영업' }, local);

  const list = sessions.taskList();
  assert.deepEqual(list.map((x) => x.name).sort(), ['Dashboard', '영업']);

  assert.match(await sessions.taskSendByMain(a, '영업', '오늘 견적 확인해 줘'), /영업 에 보냄/);
  const got = await waitFor(events, (e) => e.type === 'user.message' && e.sessionId === b);
  assert.equal(got.from, '작업 Dashboard');
  await assert.rejects(sessions.taskSendByMain(a, '없는것', 'x'), /없는 작업/);

  assert.match(await sessions.taskSplitByMain(a, '커뮤니케이션 담당'), /분담 "커뮤니케이션 담당"/);
  const split = sessions.taskList().find((x) => x.name === '커뮤니케이션 담당');
  assert.equal(split?.splitFrom, 'Dashboard');

  const s = sessions.scheduleSaveByMain(a, { session: '영업', prompt: '매일 견적 점검', repeat: 'daily', time: '09:10' });
  assert.equal(s.task, '영업');
  assert.equal(sessions.scheduleListByMain(a, '영업').length, 1);
  assert.equal(sessions.scheduleListByMain(a).length, 0);
  assert.equal(sessions.scheduleListByMain(a, undefined, true).length, 1);

  // 읽기만인 작업은 다른 작업을 시키지 못한다(제 권한을 넘지 않게)
  const comm = sessions.taskList().find((x) => x.name === '커뮤니케이션 담당')!;
  const commId = [...sessions.list()].find((x) => x.id.startsWith(comm.id))!.id;
  await sessions.handle({ type: 'session.configure', sessionId: commId, permMode: 'readonly' }, local);
  await assert.rejects(sessions.taskSendByMain(commId, '영업', 'DB 지워'), /다른 작업을 다루지 못함/);
  assert.throws(() => sessions.scheduleSaveByMain(commId, { session: '영업', prompt: 'x', repeat: 'daily', time: '01:00' }), /다른 작업을 다루지 못함/);
  sessions.stopAll();
});

test('아는 오류는 사람이 할 일로', () => {
  assert.match(friendlyError('Credit balance is too low')!.text, /크레딧/);
  assert.match(friendlyError('Failed to authenticate: OAuth session expired and could not be refreshed')!.text, /다시 로그인/);
  assert.match(friendlyError('Invalid API key · Fix external API key')!.text, /키를 다시/);
  assert.equal(friendlyError('Invalid API key')!.auth, true);
  assert.equal(friendlyError('rate limit exceeded (429)')!.auth, false);
  assert.equal(friendlyError('무언가 다른 오류'), undefined);
});

test('새 코드 있음: 켠 뒤 src 가 바뀌면 알고, 끝나면 다시 켜기를 걸 수 있다', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent hub code '));
  mkdirSync(join(root, 'src'));
  const f = join(root, 'src', 'a.ts');
  writeFileSync(f, 'x');
  utimesSync(f, new Date(2026, 0, 1), new Date(2026, 0, 1));
  let restarted = 0;
  let busy = true;
  const u = new Updater({ root, file: join(root, 'u.json'), defaultRepo: 'https://example.com/a/b', busy: () => busy, restart: () => restarted++ });
  assert.equal(u.public().codeChanged, false);
  assert.equal(u.restartForCode(false), false);
  writeFileSync(f, 'y'); // 지금 시각으로 바뀜
  (u as any).stampCache = undefined;
  assert.equal(u.public().codeChanged, true);
  assert.equal(u.restartForCode(false), true);
  assert.equal(restarted, 0); // 작업 중이라 기다림
  assert.equal(u.public().waiting, true);
  busy = false;
  u.maybeRestart();
  assert.equal(restarted, 1);
});
