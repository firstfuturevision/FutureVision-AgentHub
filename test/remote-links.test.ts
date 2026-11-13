import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager, digest } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { parseCommand } from '../src/protocol.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

// 원격 접속: 바깥 시스템이 /cmd 에 via 를 붙여 작업과 글을 주고받는다 — 작업마다 연결 목록·막기
const here = dirname(fileURLToPath(import.meta.url));
const local = { via: 'local' as const, user: 'local' };
const dash = { via: 'dashboard' as const, user: '김직원' };
const chan = { app: '대시보드', label: '커뮤니케이션 #테스트', ref: 'https://dashboard.example.com/c/test' };
const other = { app: '알림봇', label: '야간 점검' };

function world() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub remote links '));
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

/** 지시 하나를 보내고 그 차례가 끝날 때까지 */
async function say(sessions: SessionManager, events: HostEvent[], sessionId: string, text: string, via?: object, origin = local) {
  const before = events.length;
  await sessions.handle({ type: 'user.message', sessionId, text, ...(via ? { via } : {}) } as any, origin);
  return waitFor(events, (e) => events.indexOf(e) >= before && e.type === 'agent.text' && !e.partial && e.sessionId === sessionId);
}

test('parseCommand: via 는 이름을 다듬고, 틀린 주소는 빼고, app·label 이 없으면 via 전체를 뺀다', () => {
  const ok = parseCommand({ type: 'user.message', sessionId: 's', text: '안녕', via: { app: '  대시보드\u0007 ', label: '채널\n#a', ref: 'https://x.example.com/a?b=1' } }) as any;
  assert.deepEqual(ok.via, { app: '대시보드', label: '채널 #a', ref: 'https://x.example.com/a?b=1' });
  const long = parseCommand({ type: 'user.message', sessionId: 's', text: 'x', via: { app: 'a'.repeat(60), label: 'b'.repeat(100) } }) as any;
  assert.equal(long.via.app.length, 40);
  assert.equal(long.via.label.length, 80);
  // ref: http(s) 만, 300자까지
  for (const ref of ['javascript:alert(1)', 'ftp://x.example.com', '그냥 글', `https://x.example.com/${'a'.repeat(300)}`, 42]) {
    const c = parseCommand({ type: 'user.message', sessionId: 's', text: 'x', via: { app: 'a', label: 'b', ref } }) as any;
    assert.deepEqual(c.via, { app: 'a', label: 'b' }, String(ref));
  }
  // app·label 이 비거나 없으면 via 없이(명령은 그대로)
  for (const via of [{ app: 'a' }, { label: 'b' }, { app: ' ', label: 'b' }, 'a', null]) {
    const c = parseCommand({ type: 'user.message', sessionId: 's', text: 'x', via }) as any;
    assert.equal(c.type, 'user.message');
    assert.equal('via' in c, false);
  }
  const created = parseCommand({ type: 'session.create', agent: 'claude', via: chan }) as any;
  assert.deepEqual(created.via, chan);
  // 막기·풀기
  assert.deepEqual(parseCommand({ type: 'session.remote', sessionId: 's', app: ' 대시보드 ', label: '채널', blocked: true }), { type: 'session.remote', sessionId: 's', app: '대시보드', label: '채널', blocked: true });
  assert.equal(parseCommand({ type: 'session.remote', sessionId: 's', app: 'a', label: 'b' }), null);
  assert.equal(parseCommand({ type: 'session.remote', sessionId: 's', app: '', label: 'b', blocked: false }), null);
});

test('원격 접속: 이벤트에 via 가 남고, 연결마다 모이고, 다시 켜도 그대로', async () => {
  const { make } = world();
  const a = make();
  await a.sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj', via: chan }, local);
  const created = await waitFor(a.events, (e) => e.type === 'session.created');
  assert.deepEqual(created.via, chan);
  const sid = created.session.id;
  await waitFor(a.events, (e) => e.type === 'session.status' && e.status === 'idle');

  await say(a.sessions, a.events, sid, '첫 글', chan);
  await say(a.sessions, a.events, sid, '둘째 글', { ...chan, ref: 'https://dashboard.example.com/c/test2' });
  await say(a.sessions, a.events, sid, '점검 결과', other);
  await say(a.sessions, a.events, sid, 'PC 에서 직접');
  const msgs = a.events.filter((e) => e.type === 'user.message') as any[];
  assert.deepEqual(msgs[0].via, chan);
  assert.equal(msgs[3].via, undefined);
  assert.equal(msgs[0].from, 'local'); // from 은 그대로

  const list = a.sessions.remotesOf(sid);
  assert.equal(list.length, 2);
  const c = list.find((r) => r.app === '대시보드')!;
  assert.equal(c.messages, 2);
  assert.equal(c.createdSession, true);
  assert.equal(c.ref, 'https://dashboard.example.com/c/test2'); // 마지막 주소
  assert.equal(c.blocked, false);
  assert.ok(c.firstAt <= c.lastAt);
  const o = list.find((r) => r.app === '알림봇')!;
  assert.deepEqual([o.messages, o.createdSession, o.ref], [1, false, undefined]);
  assert.equal(list[0].app, '알림봇'); // 최근에 쓴 것부터
  // 화면에는 바뀔 때마다 목록 전체(기록에는 남기지 않음)
  const snap = a.events.filter((e) => e.type === 'session.remotes').at(-1) as any;
  assert.equal(snap.remotes.length, 2);
  a.sessions.stopAll();

  // 다시 켜면 기록에서 다시 모은다. 새로 붙은 화면도 목록을 받는다
  const b = make();
  assert.equal(b.sessions.restore(), 1);
  assert.deepEqual(b.sessions.remotesOf(sid), list);
  const late: HostEvent[] = [];
  b.sessions.subscribe((e) => late.push(e));
  const got = late.find((e) => e.type === 'session.remotes') as any;
  assert.deepEqual(got.remotes, list);
  assert.deepEqual((late.find((e) => e.type === 'session.created') as any).via, chan);
});

test('원격 접속 막기: 막힌 연결의 글은 받지 않고, 푸는 것은 PC 앞에서만', async () => {
  const { make } = world();
  const a = make();
  await a.sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const sid = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  await waitFor(a.events, (e) => e.type === 'session.status' && e.status === 'idle');
  await say(a.sessions, a.events, sid, '첫 글', chan);

  // 온 적 없는 연결은 막을 수 없다
  await a.sessions.handle({ type: 'session.remote', sessionId: sid, app: '모름', label: '없음', blocked: true }, local);
  assert.ok(a.events.some((e) => e.type === 'error' && /연결한 적 없는/.test(e.message)));

  // 막기는 대시보드에서도 된다
  await a.sessions.handle({ type: 'session.remote', sessionId: sid, app: chan.app, label: chan.label, blocked: true }, dash);
  const blocked = a.events.find((e) => e.type === 'session.remoteBlocked') as any;
  assert.deepEqual([blocked.blocked, blocked.by], [true, '김직원']);
  assert.equal(a.sessions.remotesOf(sid)[0].blocked, true);

  const users = () => a.events.filter((e) => e.type === 'user.message').length;
  const n = users();
  await a.sessions.handle({ type: 'user.message', sessionId: sid, text: '막혀도 보냄', via: { app: chan.app, label: chan.label } }, local);
  const err = await waitFor(a.events, (e) => e.type === 'error' && /막힌 원격 접속/.test(e.message));
  assert.equal(err.sessionId, sid);
  assert.equal(err.message, '막힌 원격 접속에서 온 글이라 받지 않았습니다: 대시보드 · 커뮤니케이션 #테스트');
  assert.equal(users(), n); // 기록·에이전트에 넣지 않음
  assert.equal(a.sessions.remotesOf(sid)[0].messages, 1);
  // 다른 연결·PC 글은 그대로 받는다
  await say(a.sessions, a.events, sid, '다른 곳', other);

  // 대시보드에서는 못 푼다
  await a.sessions.handle({ type: 'session.remote', sessionId: sid, app: chan.app, label: chan.label, blocked: false }, dash);
  assert.ok(a.events.some((e) => e.type === 'error' && /PC 앞에서만/.test(e.message)));
  assert.equal(a.sessions.remotesOf(sid).find((r) => r.app === chan.app)!.blocked, true);
  a.sessions.stopAll();

  // 다시 켜도 막힌 채로 — PC 앞에서 풀면 다시 받는다
  const b = make();
  b.sessions.restore();
  assert.equal(b.sessions.remotesOf(sid).find((r) => r.app === chan.app)!.blocked, true);
  await b.sessions.handle({ type: 'session.remote', sessionId: sid, app: chan.app, label: chan.label, blocked: false }, local);
  assert.equal(b.sessions.remotesOf(sid).find((r) => r.app === chan.app)!.blocked, false);
  const reply = await say(b.sessions, b.events, sid, '풀린 뒤', chan);
  assert.match(reply.text, /풀린 뒤/);
  b.sessions.stopAll();
});

test('에이전트가 받는 앞 대화·공유 글: 원격 접속 글은 그 연결 이름이 말한 사람', async () => {
  const lines = digest([
    { type: 'user.message', sessionId: 's', text: '정리해줘', from: 'local', via: chan },
    { type: 'agent.text', sessionId: 's', text: '정리함', partial: false },
    { type: 'turn.done', sessionId: 's', durationMs: 1, costUsd: null, isError: false },
    { type: 'user.message', sessionId: 's', text: '고마워', from: 'local' },
  ]);
  assert.deepEqual(lines, ['사람(대시보드 · 커뮤니케이션 #테스트): 정리해줘', '에이전트: 정리함', '사람(local): 고마워']);

  // 복사한 작업의 첫 지시에 붙는 앞 대화(가짜 CLI 는 받은 글을 되풀이한다)
  const { make } = world();
  const a = make();
  await a.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj' }, local);
  const sid = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  await waitFor(a.events, (e) => e.type === 'session.status' && e.status === 'idle');
  await say(a.sessions, a.events, sid, '견적 건', chan);
  await a.sessions.handle({ type: 'session.copy', sessionId: sid }, local);
  const copy = (await waitFor(a.events, (e) => e.type === 'session.created' && e.session.copiedFrom === sid)).session;
  const reply = await say(a.sessions, a.events, copy.id, '이어서');
  assert.match(reply.text, /사람\(대시보드 · 커뮤니케이션 #테스트\): 견적 건/);
  a.sessions.stopAll();
});
