import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { ClaudeHistory } from '../src/external.ts';
import { parseCommand, type HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-claude.mjs');
const local = { via: 'local' as const, user: 'local' };

/** Claude Code 기록 한 줄씩(실제 2.1.283 기록과 같은 모양) */
const human = (cwd: string, text: string) => ({ type: 'user', isSidechain: false, turnOrigin: 'human', promptSource: 'sdk', entrypoint: 'claude-desktop', cwd, message: { role: 'user', content: text } });
const reply = (cwd: string, text: string) => ({ type: 'assistant', isSidechain: false, cwd, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text }] } });

function world() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub cc '));
  const ws = join(base, 'workspace');
  const outside = join(base, '내 프로젝트'); // 작업 폴더 뿌리 밖(사람이 Claude Code 를 연 폴더)
  mkdirSync(join(ws, 'proj'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const home = join(base, 'claude-home');
  const proj = join(home, 'projects', 'C--x');
  mkdirSync(proj, { recursive: true });
  const write = (id: string, lines: object[]) => writeFileSync(join(proj, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const manager = () => {
    const events: HostEvent[] = [];
    const sessions = new SessionManager({
      workspaceRoot: ws,
      dataDir: join(base, 'data'),
      claudeHome: home,
      makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }),
    });
    sessions.subscribe((e) => events.push(e));
    return { sessions, events };
  };
  return { base, ws, outside, home, proj, write, manager };
}

test('Claude Code 기록 찾기: 사람이 연 세션만, 첫 지시·마지막 말·사용 중', () => {
  const { outside, proj, write, home } = world();
  const id = randomUUID();
  write(id, [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', isMeta: true, cwd: outside, message: { role: 'user', content: '<command-name>/model</command-name>' } },
    human(outside, '<system-reminder>무시</system-reminder>견적서 정리해줘'),
    reply(outside, '네, 정리할게요'),
    { type: 'assistant', isSidechain: false, cwd: outside, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'C:/x/견적.md', content: '아주 긴 파일 내용'.repeat(500) } }] } },
    { type: 'user', cwd: outside, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '파일을 만들었습니다\n둘째 줄' }] } },
    { type: 'assistant', isSidechain: false, cwd: outside, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } },
    { type: 'user', cwd: outside, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'Error: 포트 사용 중' }] }] } },
    reply(outside, '표로 만들었어요'),
    human(outside, '좋아 저장해'),
  ]);
  const sdk = randomUUID(); // 프로그램이 -p 로 띄운 세션(Agent Hub 작업 등)은 뺀다
  write(sdk, [{ ...human(outside, '자동 작업'), turnOrigin: 'sdk' }, reply(outside, 'ok')]);
  const old = randomUUID();
  write(old, [human(join(outside, '지워진 폴더'), '옛날 일'), reply(outside, '끝')]);
  const t = Date.now() / 1000 - 3600;
  utimesSync(join(proj, `${old}.jsonl`), t, t);
  writeFileSync(join(proj, 'not-a-session.jsonl'), '{}');

  const list = new ClaudeHistory(home).list();
  assert.deepEqual(list.map((s) => s.id), [id, old]);
  assert.equal(list[0].title, '견적서 정리해줘');
  assert.equal(list[0].last, '좋아 저장해');
  assert.equal(list[0].cwd, outside);
  assert.equal(list[0].active, true);
  assert.equal(list[0].folderOk, true);
  assert.equal(list[1].active, false);
  assert.equal(list[1].folderOk, false);
  assert.deepEqual(new ClaudeHistory(home).list(new Set([id])).map((s) => s.id), [old]);

  // 대화 읽기: 지시·답과 그 사이 도구 사용(파일·명령만, 큰 내용은 버림)·결과(첫 줄)
  const got = new ClaudeHistory(home).read(id)!;
  assert.deepEqual(got.messages, [
    { role: 'user', text: '견적서 정리해줘' },
    { role: 'assistant', text: '네, 정리할게요' },
    { role: 'tool', id: 't1', name: 'Write', input: { file_path: 'C:/x/견적.md' } },
    { role: 'tool_result', id: 't1', ok: true, summary: '파일을 만들었습니다' },
    { role: 'tool', id: 't2', name: 'Bash', input: { command: 'npm run dev' } },
    { role: 'tool_result', id: 't2', ok: false, summary: 'Error: 포트 사용 중' },
    { role: 'assistant', text: '표로 만들었어요' },
    { role: 'user', text: '좋아 저장해' },
  ]);
  // max: 끝에서 글 2개 → 그 답을 만든 도구 사용까지 함께
  assert.deepEqual(new ClaudeHistory(home).read(id, 2)!.messages.map((m) => m.role), ['tool', 'tool_result', 'tool', 'tool_result', 'assistant', 'user']);
  assert.deepEqual(new ClaudeHistory(home).read(id, 3)!.messages.map((m) => m.role), ['assistant', 'tool', 'tool_result', 'tool', 'tool_result', 'assistant', 'user']);
  assert.equal(new ClaudeHistory(home).read('../../etc/passwd'), null);
  assert.equal(parseCommand({ type: 'session.import', cliSessionId: '../x' }), null);
});

test('Claude Code 세션 가져오기: 같은 폴더에서 --resume 으로 이어 가고, 호스트를 다시 켜도 같은 대화로', async () => {
  const { outside, write, manager } = world();
  const id = randomUUID();
  write(id, [human(outside, '견적서 정리해줘'), reply(outside, '네, 정리할게요')]);

  const a = manager();
  // PC 앞에서만
  await a.sessions.handle({ type: 'session.import', cliSessionId: id }, { via: 'dashboard', user: '홍길동' });
  await waitFor(a.events, (e) => e.type === 'error' && /PC 앞에서만/.test(e.message));
  assert.equal(a.sessions.list().length, 0);

  assert.deepEqual(a.sessions.claudeCodeSessions().map((s) => s.id), [id]);
  await a.sessions.handle({ type: 'session.import', cliSessionId: id }, local);
  const created = (await waitFor(a.events, (e) => e.type === 'session.created')).session;
  assert.equal(created.workdir, outside);
  assert.equal(created.cliSessionId, id);
  assert.equal(created.imported, true);
  assert.equal(created.customTitle, '견적서 정리해줘');
  // 화면에는 그 대화 끝부분이 먼저 보인다
  const mine = a.events.filter((e) => 'sessionId' in e && e.sessionId === created.id);
  assert.deepEqual(mine.filter((e) => e.type === 'user.message' || e.type === 'agent.text').map((e: any) => e.text), ['견적서 정리해줘', '네, 정리할게요']);
  assert.ok(mine.some((e) => e.type === 'session.imported' && e.shown === 2));
  // 가져온 것은 목록에서 빠지고, 두 번 가져오지 않는다
  assert.deepEqual(a.sessions.claudeCodeSessions(), []);
  await a.sessions.handle({ type: 'session.import', cliSessionId: id }, local);
  await waitFor(a.events, (e) => e.type === 'error' && /이미 가져온/.test(e.message));

  // 이어서: 앞 대화를 글로 붙이지 않고 --resume 으로(지시가 그대로 간다)
  await a.sessions.handle({ type: 'user.message', sessionId: created.id, text: 'argv?' }, local);
  const argv1 = (await waitFor(a.events, (e) => e.type === 'agent.text' && !e.partial && e.text.startsWith('argv:'))).text;
  assert.match(argv1, new RegExp(`--resume ${id}`));
  a.sessions.stopAll();

  // 호스트를 다시 켜면: 같은 대화 id 로 다시 --resume
  const b = manager();
  assert.equal(b.sessions.restore(), 1);
  await b.sessions.handle({ type: 'user.message', sessionId: created.id, text: 'argv?' }, local);
  const argv2 = (await waitFor(b.events, (e) => e.type === 'agent.text' && !e.partial && e.text.startsWith('argv:'))).text;
  assert.match(argv2, new RegExp(`--resume ${id}`));
  b.sessions.stopAll();
});

test('Agent Hub 작업도 다시 켜면 Claude 대화 기록이 있으면 --resume, 없으면 앞 대화를 글로 붙인다', async () => {
  const { write, manager, ws } = world();
  const a = manager();
  await a.sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude', workdir: 'proj' }, local);
  const sid = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  await a.sessions.handle({ type: 'user.message', sessionId: sid, text: '첫 지시' }, local);
  const cli = (await waitFor(a.events, (e) => e.type === 'session.cli')).cliSessionId;
  await waitFor(a.events, (e) => e.type === 'turn.done');
  assert.equal(a.sessions.info(sid)?.cliSessionId, cli);
  a.sessions.stopAll();

  // 기록이 없으면(다른 PC 로 옮김 등) 예전처럼 앞 대화를 붙인다
  const b = manager();
  b.sessions.restore();
  await b.sessions.handle({ type: 'user.message', sessionId: sid, text: 'argv?' }, local);
  const carried = (await waitFor(b.events, (e) => e.type === 'agent.text' && !e.partial && e.text.includes('[이전 대화'))).text;
  assert.match(carried, /첫 지시/);
  // 새 대화로 시작했으니 대화 id 도 새것
  const cli2 = b.sessions.info(sid)?.cliSessionId!;
  assert.ok(cli2 && cli2 !== cli);
  b.sessions.stopAll();

  // 기록이 있으면 --resume
  write(cli2, [human(join(ws, 'proj'), '첫 지시')]);
  const c = manager();
  c.sessions.restore();
  await c.sessions.handle({ type: 'user.message', sessionId: sid, text: 'argv?' }, local);
  const argv = (await waitFor(c.events, (e) => e.type === 'agent.text' && !e.partial && e.text.startsWith('argv:'))).text;
  assert.match(argv, new RegExp(`--resume ${cli2}`));
  c.sessions.stopAll();
});
