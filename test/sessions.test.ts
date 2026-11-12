import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { skillsFor } from '../src/skills.ts';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { UnavailableAdapter } from '../src/adapters/types.ts';
import { parseCommand, type HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-claude.mjs');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub ')); // 공백 있는 경로도 시험
  const ws = join(base, 'workspace');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: ws,
    dataDir: join(base, 'data'),
    makeAdapter: (agent) =>
      agent === 'claude'
        ? new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' })
        : new UnavailableAdapter(`${agent} 연결 전`),
  });
  sessions.subscribe((e) => events.push(e));
  return { base, sessions, events };
}

const local = { via: 'local' as const, user: 'local' };

test('Claude 세션: 실시간 조각 → 완성 → 차례 끝, 두 번째 질문은 같은 프로세스가 받는다', async () => {
  const { base, sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;

  await sessions.handle({ type: 'user.message', sessionId: id, text: 'hello' }, local);
  await waitFor(events, (e) => e.type === 'agent.text' && e.partial);
  const done1 = await waitFor(events, (e) => e.type === 'turn.done');
  assert.equal(done1.costUsd, 0.001);
  assert.ok(events.some((e) => e.type === 'agent.text' && !e.partial && e.text === 'turn 1: hello'));

  await sessions.handle({ type: 'user.message', sessionId: id, text: 'use a tool' }, local);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text === 'turn 2: use a tool');
  assert.ok(events.some((e) => e.type === 'agent.tool' && e.name === 'Read'));
  assert.ok(events.some((e) => e.type === 'agent.tool_result' && e.ok && e.summary === '파일 내용 한 줄'));
  assert.ok(events.some((e) => e.type === 'session.status' && e.status === 'idle'));

  // 멈춤(■): 하던 차례만 멈추고 작업은 대기로. 같은 프로세스가 다음 지시를 받는다(차례 번호가 이어짐)
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'slow job' }, local);
  await waitFor(events, () => sessions.info(id)?.status === 'working');
  await sessions.handle({ type: 'session.stop', sessionId: id }, local);
  await waitFor(events, (e) => e.type === 'session.halted' && e.sessionId === id);
  const stopped = await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === id && events.indexOf(e) > events.findIndex((x) => x.type === 'session.halted'));
  assert.equal(stopped.isError, false); // 멈춤은 오류가 아니다
  assert.equal(sessions.info(id)?.status, 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'next' }, local);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text === 'turn 4: next');
  assert.ok(!events.some((e) => e.type === 'session.ended'));
  sessions.stopAll();

  // 기록: 조각 글은 빠지고 완성본·사용자 말·비용이 남는다
  const log = readFileSync(join(base, 'data', 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.type === 'user.message' && e.text === 'hello' && e.from === 'local'));
  assert.ok(log.some((e) => e.type === 'turn.done'));
  assert.ok(!log.some((e) => e.type === 'agent.text' && e.partial));
});

test('CLI 가 꺼져도 작업은 대기로 남고, 다음 지시에 다시 띄워 앞 대화를 붙여 이어 간다', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  await sessions.handle({ type: 'user.message', sessionId: id, text: '견적 정리' }, local);
  await waitFor(events, (e) => e.type === 'turn.done');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'exit!' }, local);
  await waitFor(events, (e) => e.type === 'session.ended' && e.sessionId === id);
  await waitFor(events, () => sessions.info(id)?.status === 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: '이어서' }, local);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === id && e.text.includes('이어서'));
  assert.match(reply.text, /^turn 1: /); // 새 CLI
  assert.match(reply.text, /사람\(local\): 견적 정리/); // 앞 대화를 이어받음
  assert.doesNotMatch(reply.text, /사람\(local\): 이어서/); // 이번 지시는 앞 대화에 겹쳐 넣지 않는다
  assert.equal(sessions.info(id)?.status, 'idle');
  sessions.stopAll();
});

test('Claude 승인: 물어야 하는 도구는 허용·거부 카드로 오고, 답이 CLI 로 간다', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;

  await sessions.handle({ type: 'user.message', sessionId: id, text: 'perm 1' }, local);
  const req1 = await waitFor(events, (e) => e.type === 'permission.request' && e.sessionId === id);
  assert.equal(req1.tool, 'Read');
  assert.match(req1.detail, /C:\/밖\/a\.txt · 작업 폴더 밖/);
  await sessions.handle({ type: 'permission.respond', sessionId: id, requestId: req1.requestId, allow: true }, local);
  await waitFor(events, (e) => e.type === 'agent.tool_result' && e.ok && e.summary === '읽음 C:/밖/a.txt');

  await sessions.handle({ type: 'user.message', sessionId: id, text: 'perm 2' }, local);
  const req2 = await waitFor(events, (e) => e.type === 'permission.request' && e.requestId !== req1.requestId);
  await sessions.handle({ type: 'permission.respond', sessionId: id, requestId: req2.requestId, allow: false }, local);
  await waitFor(events, (e) => e.type === 'agent.tool_result' && !e.ok && e.summary === '사람이 거부함');
  sessions.stopAll();
});

test('Claude 승인: CLI 가 거둬들인 요청·답 없이 차례가 끝난 요청은 "승인 대기"로 남지 않는다', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  const open = () => {
    const done = new Set(events.flatMap((e) => (e.type === 'permission.resolved' ? [e.requestId] : [])));
    return events.filter((e) => e.type === 'permission.request' && e.sessionId === id && !done.has(e.requestId));
  };
  for (const text of ['permcancel 1', 'permleft 2']) {
    const n = events.filter((e) => e.type === 'turn.done').length;
    await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
    await waitFor(events, () => events.filter((e) => e.type === 'turn.done').length > n);
    await waitFor(events, () => open().length === 0, 2000);
  }
  const by = events.filter((e) => e.type === 'permission.resolved').map((e: any) => e.by);
  assert.deepEqual(by, ['CLI 가 거둠', '차례 끝남']);
  sessions.stopAll();
});

test('Claude 승인: 평소에는 stdio 로 승인을 묻게 띄운다', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'argv?' }, local);
  const a = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text.startsWith('argv:'));
  assert.match(a.text, /--permission-prompt-tool stdio/);
  sessions.stopAll();
});

test('나중에 붙은 화면은 지금까지의 기록을 다시 받는다', async () => {
  const { sessions, events } = setup();
  const phone = { via: 'dashboard' as const, user: '김범무' };
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, phone);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'hi' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done');

  const late: HostEvent[] = [];
  sessions.subscribe((e) => late.push(e));
  assert.equal(late[0].type, 'session.created');
  assert.equal((late[0] as any).session.requestedBy, '김범무');
  assert.ok(late.some((e) => e.type === 'agent.text' && e.text === 'turn 1: hi'));
  sessions.stopAll();
});

test('작업 폴더는 workspaceRoot 밖으로 나갈 수 없다', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: '../..' }, local);
  assert.ok(events.some((e) => e.type === 'error' && e.message.includes('작업 폴더')));
  assert.equal(sessions.list().length, 0);
});

test('연결 전 AI 는 이유와 함께 바로 끝난다', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'codex' }, local);
  const ended = await waitFor(events, (e) => e.type === 'session.ended');
  assert.equal(ended.reason, 'codex 연결 전');
});

test('터미널 열기: PC 앞에서만, 작업 폴더 안에서만 열린다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub term '));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  const opened: Array<[string, string]> = [];
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: ws,
    dataDir: join(base, 'data'),
    makeAdapter: () => new UnavailableAdapter('x'),
    openTerminal: async (agent, dir) => { opened.push([agent, dir]); },
  });
  sessions.subscribe((e) => events.push(e));

  await sessions.handle({ type: 'terminal.open', agent: 'gemini', workdir: 'proj' }, { via: 'dashboard', user: '김범무' });
  assert.equal(opened.length, 0);
  assert.ok(events.some((e) => e.type === 'error' && e.message.includes('공용 PC 앞에서만')));

  await sessions.handle({ type: 'terminal.open', agent: 'gemini', workdir: '../..' }, local);
  assert.equal(opened.length, 0);

  await sessions.handle({ type: 'terminal.open', agent: 'codex', workdir: 'proj' }, local);
  assert.deepEqual(opened, [['codex', join(ws, 'proj')]]);
  assert.ok(events.some((e) => e.type === 'notice' && e.agent === 'codex'));
});

test('작업 이름 바꾸기 · 복제(앞 대화 이어받기) · 삭제', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const orig = (await waitFor(events, (e) => e.type === 'session.created')).session;
  await sessions.handle({ type: 'user.message', sessionId: orig.id, text: 'hello' }, local);
  await waitFor(events, (e) => e.type === 'turn.done');

  // 이름 바꾸기
  await sessions.handle({ type: 'session.rename', sessionId: orig.id, title: '견적 정리' }, local);
  assert.ok(events.some((e) => e.type === 'session.renamed' && e.title === '견적 정리'));
  assert.equal(sessions.info(orig.id)?.customTitle, '견적 정리');

  // 복제: 같은 설정·폴더, 첫 지시에 앞 대화가 붙어 간다(화면엔 사람이 쓴 글만)
  await sessions.handle({ type: 'session.fork', sessionId: orig.id }, local);
  const copy = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === orig.id)).session;
  assert.equal(copy.workdir, orig.workdir);
  assert.equal(copy.customTitle, '견적 정리 (포크)');
  await sessions.handle({ type: 'user.message', sessionId: copy.id, text: 'next' }, local);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === copy.id);
  assert.match(reply.text, /사람\(local\): hello/);
  assert.match(reply.text, /에이전트: turn 1: hello/);
  assert.match(reply.text, /\[이어서 할 일\]\nnext$/);
  assert.ok(events.some((e) => e.type === 'user.message' && e.sessionId === copy.id && e.text === 'next'));

  // 삭제: 목록에서 빠지고, 나중에 붙은 화면도 모른다
  await sessions.handle({ type: 'session.delete', sessionId: orig.id }, local);
  assert.ok(events.some((e) => e.type === 'session.deleted' && e.sessionId === orig.id));
  assert.ok(!sessions.list().some((s) => s.id === orig.id));
  const late: HostEvent[] = [];
  sessions.subscribe((e) => late.push(e));
  assert.ok(!late.some((e) => 'sessionId' in e && e.sessionId === orig.id));
  sessions.stopAll();
});

test('첨부: 작업 폴더 첨부/ 에 저장되고, 이미지는 이미지째·모든 파일은 경로로 에이전트에게 간다', async () => {
  const { base, sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const img = sessions.saveAttachment(id, '화면 캡처.png', 'image/png', png);
  const doc = sessions.saveAttachment(id, '회의록.mp4', 'video/mp4', Buffer.from('fake video'));
  assert.match(img.path, /^첨부\/\d{8}-\d{6}-화면 캡처\.png$/);
  assert.equal(readFileSync(join(base, 'workspace', 'proj', img.path)).length, png.length);
  assert.throws(() => sessions.saveAttachment('없음', 'a.txt', 'text/plain', Buffer.from('x')), /없는 세션/);

  // 첨부/ 밖을 가리키는 경로는 버린다
  await sessions.handle({ type: 'user.message', sessionId: id, text: '이거 봐줘', attachments: [img, doc, { path: '첨부/../../secret', name: 'x', mime: 'text/plain', size: 1 }] }, local);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === id);
  assert.match(reply.text, /^turn 1: \[이미지 1\] 이거 봐줘/); // 이미지 블록 1개가 함께 갔다
  assert.match(reply.text, /\[첨부 파일 — 작업 폴더 기준 경로\]/);
  assert.match(reply.text, /첨부\/.*회의록\.mp4 \(video\/mp4, 10B\)/);
  assert.doesNotMatch(reply.text, /secret/);
  const um = events.find((e) => e.type === 'user.message' && e.sessionId === id) as any;
  assert.equal(um.text, '이거 봐줘'); // 화면에는 사람이 쓴 글 + 첨부 목록(따로)
  assert.equal(um.attachments.length, 2);
  sessions.stopAll();
});

test('연결 폴더: 뿌리 안 폴더만 연결되고, 복제·새 하위 에이전트부터 CLI 에 --add-dir 로 간다', async () => {
  const { base, sessions, events } = setup();
  mkdirSync(join(base, 'workspace', '자료'), { recursive: true });
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const s = (await waitFor(events, (e) => e.type === 'session.created')).session;
  await sessions.handle({ type: 'session.dirs', sessionId: s.id, dirs: ['../..'] }, local);
  assert.ok(events.some((e) => e.type === 'error' && e.message.includes('연결할 수 없는 폴더')));
  await sessions.handle({ type: 'session.dirs', sessionId: s.id, dirs: ['자료', 'proj'] }, local); // 작업 폴더 자신은 빠진다
  assert.deepEqual(sessions.info(s.id)?.extraDirs, [join(base, 'workspace', '자료')]);

  await sessions.handle({ type: 'session.fork', sessionId: s.id }, local);
  const copy = (await waitFor(events, (e) => e.type === 'session.created' && e.session.forkedFrom === s.id)).session;
  // 복제한 작업의 첫 지시에는 앞 대화가 붙으므로 한 번 인사하고 묻는다
  await sessions.handle({ type: 'user.message', sessionId: copy.id, text: 'hi' }, local);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === copy.id);
  await sessions.handle({ type: 'user.message', sessionId: copy.id, text: 'argv?' }, local);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === copy.id && e.text.startsWith('argv:'));
  assert.match(reply.text, /--add-dir .*자료/);
  sessions.stopAll();
});

test('지침: 그 CLI 가 읽는 스킬 폴더에서 이름·설명을 읽는다', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent hub skills home '));
  const work = mkdtempSync(join(tmpdir(), 'agent hub skills work '));
  const skill = (dir: string, name: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 설명\n---\n`);
  };
  skill(join(home, '.claude', 'skills'), '검증 루프');
  skill(join(home, '.claude', 'skills', 'synced', 'acct'), '사내 대시보드');
  skill(join(work, '.claude', 'skills'), '견적 작성');
  skill(join(home, '.agents', 'skills'), '공용 스킬');
  assert.deepEqual(skillsFor('claude', work, home).map((s) => `${s.name}/${s.where}`), ['검증 루프/계정', '견적 작성/작업 폴더', '사내 대시보드/계정']);
  assert.deepEqual(skillsFor('codex', work, home).map((s) => s.name), ['공용 스킬']);
  assert.deepEqual(skillsFor('gemini', work, home), []);
});

test('parseCommand 는 모르는 모양을 거른다', () => {
  assert.equal(parseCommand({ type: 'session.create', agent: 'gpt' }), null);
  assert.equal(parseCommand({ type: 'user.message', sessionId: 'x' }), null);
  assert.equal(parseCommand('rm -rf'), null);
  assert.deepEqual(parseCommand({ type: 'session.stop', sessionId: 'a' }), { type: 'session.stop', sessionId: 'a' });
  // 화면에서는 worker 를 만들 수 없다, 위험한 모델 이름은 버린다
  assert.equal((parseCommand({ type: 'session.create', agent: 'codex', role: 'worker' }) as any).role, 'direct');
  assert.equal((parseCommand({ type: 'session.create', agent: 'codex', model: 'x & del' }) as any).model, undefined);
});
