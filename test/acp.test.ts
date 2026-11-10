import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.ts';
import { AcpAdapter } from '../src/adapters/acp.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp.mjs');

function setup(mode: string, startTimeoutMs = 5000) {
  const base = mkdtempSync(join(tmpdir(), 'agent hub acp '));
  mkdirSync(join(base, 'ws'), { recursive: true });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    makeAdapter: () => new AcpAdapter({ label: 'Gemini', command: process.execPath, args: [fake, mode], startTimeoutMs }),
  });
  sessions.subscribe((e) => events.push(e));
  return { sessions, events };
}

const pc = { via: 'local' as const, user: 'local' };
const phone = { via: 'dashboard' as const, user: '김범무' };

async function open(mode: string, timeout?: number) {
  const t = setup(mode, timeout);
  await t.sessions.handle({ type: 'session.create', role: 'direct', agent: 'gemini' }, pc);
  const id = (await waitFor(t.events, (e) => e.type === 'session.created')).session.id as string;
  return { ...t, id };
}

test('ACP: 실시간 조각 → 완성 문장 → 차례 끝, 생각 조각은 숨기고 fs 요청은 거절한다', async () => {
  const { sessions, events, id } = await open('normal');
  await waitFor(events, (e) => e.type === 'session.status' && e.status === 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'hello' }, pc);
  await waitFor(events, (e) => e.type === 'agent.text' && e.partial);
  await waitFor(events, (e) => e.type === 'turn.done');
  const final = events.filter((e) => e.type === 'agent.text' && !e.partial) as any[];
  assert.deepEqual(final.map((e) => e.text), ['turn 1: hello']); // fs 거절이 안 됐으면 꼬리말이 붙는다
  assert.ok(!events.some((e) => e.type === 'agent.text' && e.text.includes('생각 중')));
  sessions.stopAll();
});

test('ACP: 승인 요청 → 대시보드에서 허용하면 실행되고, 늦게 온 PC 거부는 무시된다', async () => {
  const { sessions, events, id } = await open('normal');
  await waitFor(events, (e) => e.type === 'session.status' && e.status === 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'please write' }, pc);
  const req = await waitFor(events, (e) => e.type === 'permission.request');
  assert.equal(req.tool, 'WriteFile a.txt');
  assert.equal(req.detail, 'edit · a.txt');

  await sessions.handle({ type: 'permission.respond', sessionId: id, requestId: req.requestId, allow: true }, phone);
  await sessions.handle({ type: 'permission.respond', sessionId: id, requestId: req.requestId, allow: false }, pc);
  const resolved = events.filter((e) => e.type === 'permission.resolved') as any[];
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].by, '김범무');
  const result = await waitFor(events, (e) => e.type === 'agent.tool_result');
  assert.equal(result.ok, true); // allow_always 가 아니라 allow_once 를 골랐다
  assert.equal(result.summary, 'wrote a.txt');
  await waitFor(events, (e) => e.type === 'turn.done');
  sessions.stopAll();
});

test('ACP: 거부하면 reject_once 로 답하고 도구는 실패로 표시된다', async () => {
  const { sessions, events, id } = await open('normal');
  await waitFor(events, (e) => e.type === 'session.status' && e.status === 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'write it' }, pc);
  const req = await waitFor(events, (e) => e.type === 'permission.request');
  await sessions.handle({ type: 'permission.respond', sessionId: id, requestId: req.requestId, allow: false }, pc);
  const result = await waitFor(events, (e) => e.type === 'agent.tool_result');
  assert.equal(result.ok, false);
  assert.equal(result.summary, 'canceled (cancel)');
  sessions.stopAll();
});

test('ACP: 질문 두 개를 연달아 보내도 순서대로 하나씩 처리한다', async () => {
  const { sessions, events, id } = await open('normal');
  await waitFor(events, (e) => e.type === 'session.status' && e.status === 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'one' }, pc);
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'two' }, pc);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text === 'turn 2: two');
  const finals = events.filter((e) => e.type === 'agent.text' && !e.partial).map((e: any) => e.text);
  assert.deepEqual(finals, ['turn 1: one', 'turn 2: two']);
  sessions.stopAll();
});

test('ACP: 로그인 필요 오류는 이유와 함께 세션을 끝낸다', async () => {
  const { events } = await open('auth');
  const ended = await waitFor(events, (e) => e.type === 'session.ended');
  assert.match(ended.reason, /로그인 필요/);
});

test('ACP: 응답이 없으면 제한 시간 뒤 로그인 확인 안내와 함께 끝낸다', async () => {
  const { events } = await open('silent', 500);
  const ended = await waitFor(events, (e) => e.type === 'session.ended', 3000);
  assert.match(ended.reason, /응답 없음.*로그인/);
});
