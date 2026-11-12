import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/sessions.ts';
import { UnavailableAdapter } from '../src/adapters/types.ts';
import { PresetStore } from '../src/presets.ts';
import type { HostEvent } from '../src/protocol.ts';

test('긴 기록: 다시 켜도 작업이 사라지지 않고(만든 기록 유지), 큰 파일은 압축해 옮기고 최근 것만 남긴다', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub cap '));
  const ws = join(base, 'workspace');
  const logDir = join(base, 'data', 'sessions');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const id = 'big-1';
  const at = new Date().toISOString();
  const info = { id, role: 'main', agent: 'claude', title: '긴 작업', workdir: join(ws, 'proj'), requestedBy: 'local', via: 'local', createdAt: at, status: 'idle' };
  const pad = 'x'.repeat(10_000);
  const lines = [JSON.stringify({ at, type: 'session.created', session: info }), JSON.stringify({ at, type: 'session.renamed', sessionId: id, title: '새 이름' })];
  const t0 = Date.parse(at);
  for (let i = 0; i < 2500; i++) lines.push(JSON.stringify({ at: new Date(t0 + i + 1).toISOString(), type: 'agent.text', sessionId: id, text: `${i} ${pad}` }));
  const file = join(logDir, `${id}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  assert.ok(statSync(file).size > 20 * 1024 * 1024);

  const opts = { workspaceRoot: ws, dataDir: join(base, 'data'), presets: new PresetStore(join(base, 'data', 'presets.json')), makeAdapter: () => new UnavailableAdapter('시험') };
  const sm = new SessionManager(opts as any);
  assert.equal(sm.restore(), 1);
  const seen: HostEvent[] = [];
  sm.subscribe((e) => seen.push(e));
  assert.equal(seen[0].type, 'session.created'); // 화면이 작업을 알 수 있다
  assert.equal((seen[0] as any).session.customTitle, '새 이름');
  assert.ok(seen.length <= 2000);
  assert.ok((seen.at(-1) as any).text.startsWith("2499 "));

  // 파일은 작아지고, 전체는 archive 에 압축으로
  assert.ok(statSync(file).size < 21 * 1024 * 1024 && readFileSync(file, 'utf8').split('\n').filter(Boolean).length === 2000);
  const gz = readdirSync(join(logDir, 'archive'));
  assert.equal(gz.length, 1);
  assert.equal(gunzipSync(readFileSync(join(logDir, 'archive', gz[0]))).toString('utf8').split('\n').filter(Boolean).length, lines.length);

  // 줄인 파일로 다시 켜도 이름·작업 그대로
  const again = new SessionManager(opts as any);
  assert.equal(again.restore(), 1);
  assert.equal(again.info(id)?.customTitle, '새 이름');
  assert.equal(readdirSync(join(logDir, 'archive')).length, 1); // 작아졌으니 또 옮기지 않는다
});

test('일하던 중에 꺼진 작업: 다시 켜면 기록이 "대기"로 끝나고 답 없던 승인은 닫힌다(화면에 승인 대기로 남지 않게)', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub halt '));
  const ws = join(base, 'workspace');
  const logDir = join(base, 'data', 'sessions');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const id = 'halt-1';
  const t = (i: number) => new Date(Date.parse('2026-11-12T00:00:00Z') + i * 1000).toISOString();
  const info = { id, role: 'main', agent: 'claude', title: '도중', workdir: join(ws, 'proj'), requestedBy: 'local', via: 'local', createdAt: t(0), status: 'idle' };
  writeFileSync(join(logDir, `${id}.jsonl`), [
    { at: t(0), type: 'session.created', session: info },
    { at: t(1), type: 'session.status', sessionId: id, status: 'working' },
    { at: t(2), type: 'permission.request', sessionId: id, requestId: 'c1', tool: 'Bash', detail: 'ls' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const sm = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), presets: new PresetStore(join(base, 'data', 'presets.json')), makeAdapter: () => new UnavailableAdapter('시험') } as any);
  sm.restore();
  const seen: HostEvent[] = [];
  sm.subscribe((e) => seen.push(e));
  assert.equal((seen.filter((e) => e.type === 'session.status').at(-1) as any).status, 'idle');
  assert.ok(seen.some((e) => e.type === 'permission.resolved' && e.requestId === 'c1'));
});
