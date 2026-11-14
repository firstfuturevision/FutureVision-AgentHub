import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LimitStore } from '../src/limits.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

test('연결별 사용 한도: 작업이 받은 rate_limit_event 를 로그인별로 모으고 기록에는 남기지 않는다', async () => {
  const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const base = mkdtempSync(join(tmpdir(), 'agent hub limits '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.limits = new LimitStore(join(base, 'data', 'limits.json'));
  sessions.subscribe((e) => events.push(e));
  const local = { via: 'local' as const, user: 'local' };
  try {
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '가' }, local);
    const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
    await sessions.handle({ type: 'user.message', sessionId: id, text: 'limits?' }, local);
    await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === id);
    const l = sessions.limits.public()['claude:default'];
    assert.equal(l.windows!.seven_day.utilization, 0.09);
    assert.equal(l.windows!.five_hour.utilization, 0.4);
    assert.equal(l.windows!.seven_day.resetsAt, 1794880800);
    assert.equal(l.turns, 1);
    assert.equal(events.some((e) => e.type === 'agent.limits'), false); // 화면·기록으로는 안 간다
    // API 키는 금액을 센다
    const s2 = new LimitStore(join(base, 'data', 'l2.json'));
    s2.turn('claude', 'apikey', 0.0123);
    s2.turn('claude', 'apikey', 0.01);
    assert.equal(s2.public()['claude:apikey'].costUsd, 0.0223);
  } finally {
    sessions.stopAll();
  }
});
