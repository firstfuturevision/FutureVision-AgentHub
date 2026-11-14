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

test('분담 공유: 가운데 작업이 받은 공유를 자기 차례 끝에 다시 넘기지 않는다(같은 내용은 한 번만)', async () => {
  const { sessions, events, create } = world();
  const a = await create();
  await sessions.handle({ type: 'session.rename', sessionId: a, title: '가운데' }, local);
  await sessions.handle({ type: 'user.message', sessionId: a, text: '시작' }, local);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === a);
  await sessions.taskSplitByMain(a, '왼쪽');
  await sessions.taskSplitByMain(a, '오른쪽');
  const id = (name: string) => sessions.list().find((s) => s.customTitle === name)!.id;
  const [b, c] = [id('왼쪽'), id('오른쪽')];

  // 왼쪽이 일하면 가운데(자기 일)와 오른쪽(넘겨받은 공유)이 한 번씩 받는다
  await sessions.handle({ type: 'user.message', sessionId: b, text: '왼쪽 일 ZZ' }, local);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === b);
  const got = (to: string) => events.filter((e) => e.type === 'session.merged' && e.sessionId === to && e.text.includes('사람(local): 왼쪽 일 ZZ'));
  assert.equal(got(a).length, 1);
  assert.equal(got(c).length, 1);
  assert.equal((got(c)[0] as any).relay, true);

  // 가운데가 자기 일을 하면 오른쪽은 가운데 일만 받고, 왼쪽이 받은 지시는 다시 받지 않는다(가짜 CLI 는 받은 글을 그대로 되돌려 답하므로 사람 지시 줄로 센다)
  await sessions.handle({ type: 'user.message', sessionId: a, text: '가운데 일 YY' }, local);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === a && events.some((x) => x.type === 'session.merged' && x.sessionId === c && x.text.includes('가운데 일 YY')));
  // 가운데 → 오른쪽 공유 가운데 "넘겨받은 공유" 꼴(`[분담 공유: 왼쪽]` 머리)로 왼쪽 일이 다시 간 것은 처음 한 번뿐
  const relayed = events.filter((e) => e.type === 'session.merged' && e.sessionId === c && e.fromId === a && /^\[분담 공유: 왼쪽\]$/m.test(e.text));
  assert.equal(relayed.length, 1);
  assert.equal((relayed[0] as any).relay, true);
  assert.equal(events.filter((e) => e.type === 'session.merged' && e.sessionId === b && /^\[분담 공유: 왼쪽\]$/m.test(e.text)).length, 0); // 보낸 쪽으로 되돌아가지 않음
  sessions.stopAll();
});

test('공유 요약: 예약 지시는 첫 줄만', () => {
  const out = digest([{ type: 'user.message', sessionId: 's', text: '[예약] 오늘의 Q&A\n긴 절차 '.padEnd(3000, '가'), from: '예약' } as any]);
  assert.equal(out[0], '사람(예약): [예약] 오늘의 Q&A');
});

test('이름 바꾸기: 예전 이름도 알아듣는다', async () => {
  const { sessions, events, create } = world();
  const a = await create();
  await sessions.handle({ type: 'session.rename', sessionId: a, title: '커뮤니케이션 담당' }, local);
  await sessions.handle({ type: 'session.rename', sessionId: a, title: '커뮤니케이션 에이전트' }, local);
  const ev = events.filter((e) => e.type === 'session.renamed').at(-1) as any;
  assert.deepEqual(ev.aliases, ['커뮤니케이션 담당']);
  assert.equal(sessions.findTask('커뮤니케이션 담당').info.id, a);
  assert.equal(sessions.findTask('커뮤니케이션 에이전트').info.id, a);
  sessions.stopAll();
});

test('예약 10분씩 나누기: 시각마다 하나는 그대로, 나머지는 비어 있는 다음 자리로', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent hub spread '));
  const store = new ScheduleStore(join(dir, 's.json'));
  for (const [t, p] of [['09:00', 'a'], ['09:00', 'b'], ['09:00', 'c'], ['09:10', 'd']]) store.save({ sessionId: 's', prompt: p, repeat: 'daily', time: t });
  store.save({ sessionId: 's', prompt: 'iv', repeat: 'interval', every: 60 });
  assert.equal(store.spread().length, 2);
  const times = store.list().filter((x) => x.repeat === 'daily').map((x) => x.time).sort();
  assert.deepEqual(times, ['09:00', '09:10', '09:20', '09:30']);
  assert.equal(store.spread().length, 0);
});

test('바뀐 서버 코드: 작업이 모두 10분 쉬면 저절로 다시 켠다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent hub auto '));
  mkdirSync(join(root, 'src'));
  const f = join(root, 'src', 'a.ts');
  writeFileSync(f, 'x');
  utimesSync(f, new Date(2026, 0, 1), new Date(2026, 0, 1));
  let restarted = 0;
  let busy = false;
  const u = new Updater({ root, file: join(root, 'u.json'), defaultRepo: 'https://example.com/a/b', busy: () => busy, restart: () => restarted++ });
  (u as any).saved.lastCheck = new Date().toISOString(); // 정한 시각의 업데이트 확인은 건너뛰게
  writeFileSync(f, 'y');
  (u as any).stampCache = undefined;
  const t0 = new Date(2026, 10, 14, 15, 0);
  (u as any).lastSlot = () => new Date(0);
  await u.tick(t0);
  await u.tick(new Date(t0.getTime() + 9 * 60_000));
  assert.equal(restarted, 0);
  busy = true;
  await u.tick(new Date(t0.getTime() + 11 * 60_000)); // 일하는 작업이 생기면 처음부터
  busy = false;
  await u.tick(new Date(t0.getTime() + 12 * 60_000));
  await u.tick(new Date(t0.getTime() + 21 * 60_000));
  assert.equal(restarted, 0);
  await u.tick(new Date(t0.getTime() + 23 * 60_000));
  assert.equal(restarted, 1);
});
