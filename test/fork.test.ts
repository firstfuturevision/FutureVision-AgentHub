import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { PresetStore } from '../src/presets.ts';
import { parseCommand, type HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-claude.mjs');
const local = { via: 'local' as const, user: 'local' };

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub fork '));
  const ws = join(base, 'workspace');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  const events: HostEvent[] = [];
  const presets = new PresetStore(join(base, 'data', 'presets.json'));
  const sessions = new SessionManager({
    workspaceRoot: ws,
    dataDir: join(base, 'data'),
    presets,
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  return { sessions, events, presets };
}

async function say(sessions: SessionManager, events: HostEvent[], id: string, text: string) {
  const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
  await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
  await waitFor(events, () => events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length > n);
  return events.filter((e) => e.type === 'agent.text' && !e.partial && e.sessionId === id).at(-1) as any;
}

async function newMain(sessions: SessionManager, events: HostEvent[], extra: object = {}) {
  const before = events.filter((e) => e.type === 'session.created').length;
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj', ...extra }, local);
  return (events.filter((e) => e.type === 'session.created')[before] as any).session;
}

test('여기서 포크: 정한 차례까지만 대화를 가져간다', async () => {
  const { sessions, events } = setup();
  const orig = await newMain(sessions, events);
  await say(sessions, events, orig.id, '첫째');
  await say(sessions, events, orig.id, '둘째');
  await sessions.handle({ type: 'session.fork', sessionId: orig.id, upTo: 1 }, local);
  const fork = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === orig.id)).session;
  const reply = await say(sessions, events, fork.id, '다른 길');
  assert.match(reply.text, /사람\(local\): 첫째/);
  assert.match(reply.text, /turn 1: 첫째/);
  assert.doesNotMatch(reply.text, /둘째/);
  sessions.stopAll();
});

test('복사: 설정·에이전트·대화를 가져가지만 원본과 잇지 않는다(공유 없음)', async () => {
  const { sessions, events, presets } = setup();
  const p = presets.save({ name: '정리 담당', agent: 'claude', description: '', instructions: '표로 정리한다' });
  const orig = await newMain(sessions, events, { preset: p.id });
  await say(sessions, events, orig.id, '견적 건');
  await sessions.handle({ type: 'session.copy', sessionId: orig.id }, local);
  const copy = (events.filter((e) => e.type === 'session.created').at(-1) as any).session;
  assert.notEqual(copy.id, orig.id);
  assert.equal(copy.forkedFrom, undefined);
  assert.equal(copy.copiedFrom, orig.id);
  assert.equal(copy.preset?.id, p.id);
  assert.equal(copy.workdir, orig.workdir);
  const reply = await say(sessions, events, copy.id, '새 건');
  assert.match(reply.text, /표로 정리한다/); // 역할 지침
  assert.match(reply.text, /사람\(local\): 견적 건/); // 대화도 가져간다
  assert.ok(!events.some((e) => e.type === 'session.merged')); // 원본에 공유하지 않는다
  sessions.stopAll();
});

test('포크 공유: 포크의 답이 끝날 때마다 새 대화만 원본에 가고, 원본은 다음 지시에 받는다', async () => {
  const { sessions, events } = setup();
  const orig = await newMain(sessions, events);
  await say(sessions, events, orig.id, '계획');
  await sessions.handle({ type: 'session.fork', sessionId: orig.id }, local);
  const fork = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === orig.id)).session;
  assert.ok(!events.some((e) => e.type === 'session.merged')); // 포크만 해서는 공유할 게 없다
  await say(sessions, events, fork.id, '대안 A 검토');

  const m1 = await waitFor(events, (e) => e.type === 'session.merged' && e.sessionId === orig.id);
  assert.equal(m1.fromId, fork.id);
  // 원본에서 가져간 앞 대화는 다시 안 보낸다: 포크에서 사람이 한 첫 지시부터 시작
  // (가짜 CLI 는 받은 글 전체를 되풀이하므로 답 줄에는 앞 대화가 섞여 있다)
  assert.equal(m1.text.split('\n')[0], '사람(local): 대안 A 검토');
  // 원본은 다음 지시에 공유받은 내용을 받는다(화면 기록에는 사람이 쓴 글만)
  const reply = await say(sessions, events, orig.id, '이어서');
  assert.match(reply.text, /\[포크 공유: 대안 A 검토/);
  assert.match(reply.text, /이어서$/);
  assert.ok(events.some((e) => e.type === 'user.message' && e.sessionId === orig.id && e.text === '이어서'));
  // 원본의 답은 포크로 공유되지 않는다(포크 → 원본 한 방향)
  assert.equal(events.filter((e) => e.type === 'session.merged').length, 1);

  // 더 진행하면 그 뒤만
  await say(sessions, events, fork.id, '대안 B');
  const merges = events.filter((e) => e.type === 'session.merged') as any[];
  assert.equal(merges.length, 2);
  assert.match(merges[1].text, /대안 B/);
  assert.doesNotMatch(merges[1].text, /대안 A/);
  sessions.stopAll();
});

test('포크 공유: CLI 가 꺼진 원본도 공유를 받고, 다음 지시에 다시 떠서 앞 대화와 공유를 한 번씩 이어받는다', async () => {
  const { sessions, events } = setup();
  const orig = await newMain(sessions, events);
  await say(sessions, events, orig.id, '계획');
  await sessions.handle({ type: 'session.fork', sessionId: orig.id }, local);
  const fork = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === orig.id)).session;
  await sessions.handle({ type: 'user.message', sessionId: orig.id, text: 'exit!' }, local);
  await waitFor(events, (e) => e.type === 'session.ended' && e.sessionId === orig.id);
  await say(sessions, events, fork.id, '조사 결과 정리');
  await waitFor(events, (e) => e.type === 'session.merged' && e.sessionId === orig.id);

  const reply = await say(sessions, events, orig.id, '다음');
  assert.match(reply.text, /사람\(local\): 계획/);
  assert.equal(reply.text.split('[포크 공유: 조사 결과 정리').length - 1, 1); // 공유는 한 번만
  assert.match(reply.text, /다음$/);
  sessions.stopAll();
});

test('parseCommand: 포크 차례·복사', () => {
  assert.deepEqual(parseCommand({ type: 'session.fork', sessionId: 'a', upTo: 2 }), { type: 'session.fork', sessionId: 'a', upTo: 2 });
  assert.deepEqual(parseCommand({ type: 'session.fork', sessionId: 'a', upTo: -1 }), { type: 'session.fork', sessionId: 'a' });
  assert.deepEqual(parseCommand({ type: 'session.copy', sessionId: 'a' }), { type: 'session.copy', sessionId: 'a' });
  assert.equal(parseCommand({ type: 'session.merge', sessionId: 'a' }), null); // 공유는 자동이라 명령이 없다
});

test('분담: 원본과 분담이 서로 한 일을 주고받고, 받은 것을 되돌려 보내지 않는다', async () => {
  const { sessions, events } = setup();
  const orig = await newMain(sessions, events);
  await say(sessions, events, orig.id, '계획 세우기');
  await sessions.handle({ type: 'session.split', sessionId: orig.id }, local);
  const part = (await waitFor(events, (e) => e.type === 'session.created' && e.session.splitFrom === orig.id)).session;
  assert.equal(part.forkedFrom, undefined);

  // 분담 → 원본
  const r1 = await say(sessions, events, part.id, 'A 부분');
  assert.match(r1.text, /사람\(local\): 계획 세우기/); // 앞 대화를 이어받음
  const toOrig = events.filter((e) => e.type === 'session.merged' && e.sessionId === orig.id) as any[];
  assert.equal(toOrig.length, 1);
  assert.equal(toOrig[0].kind, 'split');
  assert.match(toOrig[0].text, /사람\(local\): A 부분/);

  // 원본 → 분담: 원본의 다음 지시에 분담 쪽 진행이 붙고, 원본의 답은 분담으로 간다
  const r2 = await say(sessions, events, orig.id, 'B 부분');
  assert.match(r2.text, /\[분담 공유: A 부분/);
  const toPart = events.filter((e) => e.type === 'session.merged' && e.sessionId === part.id) as any[];
  assert.equal(toPart.length, 1);
  assert.match(toPart[0].text, /사람\(local\): B 부분/);
  assert.doesNotMatch(toPart[0].text, /\[분담 공유: A 부분\]/); // 분담에게서 받은 기록은 되돌려 보내지 않는다
  assert.match(toPart[0].text, /^사람\(local\): B 부분/); // 이미 이어받은 앞 대화는 빼고 그 뒤부터(가짜 AI 는 받은 글을 따라 말하므로 첫 줄로 본다)

  const r3 = await say(sessions, events, part.id, 'C 부분');
  assert.match(r3.text, /\[분담 공유: 계획 세우기/); // 원본이 그사이 한 일이 분담의 다음 지시에 붙었다
  sessions.stopAll();
});

test('컨텍스트: 사용량과, 앞 대화·공유가 다음 지시에 붙을 때까지 대기로 보인다', async () => {
  const { sessions, events } = setup();
  const lastItems = (id: string) => (events.filter((e) => e.type === 'context.items' && e.sessionId === id).at(-1) as any)?.items ?? [];
  const orig = await newMain(sessions, events);
  await say(sessions, events, orig.id, '계획');
  const u = events.filter((e) => e.type === 'context.usage' && e.sessionId === orig.id).at(-1) as any;
  assert.ok(u.used > 1000);
  assert.equal(u.window, 200000);

  await sessions.handle({ type: 'session.fork', sessionId: orig.id }, local);
  const fork = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === orig.id)).session;
  assert.deepEqual(lastItems(fork.id).map((i: any) => [i.label, i.pending]), [['앞 대화', true]]);
  await say(sessions, events, fork.id, '대안 A');
  assert.deepEqual(lastItems(fork.id).map((i: any) => [i.label, i.pending]), [['앞 대화', false]]);

  // 포크의 답이 끝나면 원본에 공유가 대기로 생기고, 원본의 다음 지시에 넣으면 대기가 풀린다
  const shared = lastItems(orig.id);
  assert.equal(shared.length, 1);
  assert.match(shared[0].label, /^포크 공유 · 대안 A/);
  assert.equal(shared[0].pending, true);
  assert.ok(shared[0].chars > 0);
  await say(sessions, events, orig.id, '이어서');
  assert.equal(lastItems(orig.id)[0].pending, false);

  // 설정을 바꿔 다시 띄우면 사용량은 비고, 넣었던 것은 앞 대화에 담겨 다시 대기
  await sessions.handle({ type: 'session.configure', sessionId: orig.id, model: 'sonnet' }, local);
  await waitFor(events, (e) => e.type === 'context.usage' && e.sessionId === orig.id && e.used === 0);
  assert.deepEqual(lastItems(orig.id).map((i: any) => [i.label, i.pending]), [['앞 대화', true]]);
  sessions.stopAll();
});
