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
  const base = mkdtempSync(join(tmpdir(), 'agent hub conf '));
  const ws = join(base, 'workspace');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  const events: HostEvent[] = [];
  const presets = new PresetStore(join(base, 'data', 'presets.json'));
  const opts = {
    workspaceRoot: ws,
    dataDir: join(base, 'data'),
    presets,
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' as const }),
  };
  const sessions = new SessionManager(opts);
  sessions.subscribe((e) => events.push(e));
  return { sessions, events, presets, opts };
}

async function say(sessions: SessionManager, events: HostEvent[], id: string, text: string) {
  const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
  await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
  await waitFor(events, () => events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length > n);
  return events.filter((e) => e.type === 'agent.text' && !e.partial && e.sessionId === id).at(-1) as any;
}

test('에이전트 설정 바꾸기: 같은 작업에서 새 설정으로 다시 띄우고 앞 대화를 이어받는다', async () => {
  const { sessions, events, presets, opts } = setup();
  const planner = presets.save({ name: '기획자', agent: 'claude', model: 'claude-sonnet-5-5', description: '기획', instructions: '기획서를 쓴다.' });
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj' }, local);
  const s = (events.find((e) => e.type === 'session.created') as any).session;
  await say(sessions, events, s.id, '견적서 정리');

  await sessions.handle({ type: 'session.configure', sessionId: s.id, preset: planner.id }, local);
  const conf = (await waitFor(events, (e) => e.type === 'session.configured')) as any;
  assert.equal(conf.session.id, s.id);
  assert.deepEqual(conf.session.preset, { id: planner.id, name: '기획자' });
  assert.equal(conf.session.model, 'claude-sonnet-5-5'); // 에이전트를 바꾸면 그 에이전트의 모델
  await waitFor(events, () => sessions.info(s.id)?.status === 'idle');

  const reply = await say(sessions, events, s.id, '이어서');
  assert.match(reply.text, /\[claude-sonnet-5-5\]/); // 새 모델로 다시 떴다
  assert.match(reply.text, /turn 1: /); // 새 CLI 의 첫 차례
  assert.match(reply.text, /사람\(local\): 견적서 정리/); // 앞 대화를 이어받음
  assert.match(reply.text, /기획서를 쓴다/); // 새 역할 지침
  assert.equal(events.filter((e) => e.type === 'session.ended' && e.sessionId === s.id).length, 0); // 앞 CLI 끝남은 화면에 안 나감

  // 모델만, 에이전트 없애기(기본)
  await sessions.handle({ type: 'session.configure', sessionId: s.id, preset: null, model: 'claude-haiku-5-5' }, local);
  await waitFor(events, () => sessions.info(s.id)?.status === 'idle');
  assert.equal(sessions.info(s.id)?.preset, undefined);
  assert.equal(sessions.info(s.id)?.model, 'claude-haiku-5-5');
  sessions.stopAll();

  // 다시 켜도 바뀐 설정으로 복원
  const again = new SessionManager(opts);
  again.restore();
  assert.equal(again.info(s.id)?.model, 'claude-haiku-5-5');
  assert.equal(again.info(s.id)?.preset, undefined);
});

test('에이전트 설정 바꾸기: 작업 중·하위 에이전트·없는 에이전트는 거절, 명령 검사', async () => {
  const { sessions, events } = setup();
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj' }, local);
  const s = (events.find((e) => e.type === 'session.created') as any).session;
  await waitFor(events, () => sessions.info(s.id)?.status === 'idle');
  await sessions.handle({ type: 'session.configure', sessionId: s.id, preset: 'nope' }, local);
  assert.match((events.at(-1) as any).message, /없는 에이전트/);

  await sessions.handle({ type: 'user.message', sessionId: s.id, text: '느리게' }, local);
  await sessions.handle({ type: 'session.configure', sessionId: s.id, model: 'claude-haiku-5-5' }, local);
  assert.ok(events.some((e) => e.type === 'error' && /작업 중에는/.test(e.message)));
  sessions.stopAll();

  assert.deepEqual(parseCommand({ type: 'session.configure', sessionId: 'a', preset: null, model: 'm-1' }), { type: 'session.configure', sessionId: 'a', preset: null, model: 'm-1' });
  assert.equal(parseCommand({ type: 'session.configure', sessionId: 'a', model: 'x & del' }), null);
  assert.equal(parseCommand({ type: 'session.configure', sessionId: 'a', agent: 'gpt' }), null);
});
