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

test('보관: 아래 작업까지 숨고, 목록·보내기에서 빠지고, 예약은 건너뛰고, 다시 켜도 그대로', async () => {
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
