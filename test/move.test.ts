import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { ScheduleStore } from '../src/schedules.ts';
import { waitFor } from './helpers.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const local = { via: 'local' as const, user: 'local' };

function pc(name: string) {
  const base = mkdtempSync(join(tmpdir(), `agent hub move ${name} `));
  mkdirSync(join(base, 'ws'), { recursive: true });
  const events: any[] = [];
  const schedules = new ScheduleStore(join(base, 'data', 'schedules.json'));
  const sessions = new SessionManager({ workspaceRoot: join(base, 'ws'), dataDir: join(base, 'data'), schedules, makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) } as any);
  sessions.subscribe((e) => events.push(e));
  return { name, base, ws: join(base, 'ws'), sessions, events, schedules, url: `http://192.168.0.${name === 'a' ? 5 : 9}:4319` };
}
/** a 의 연결: 받는 쪽 b 의 메서드를 그대로 부른다 */
function link(a: ReturnType<typeof pc>, b: ReturnType<typeof pc>) {
  (a.sessions as any).peers = {
    summary: () => ({ name: a.name, tasks: [] }),
    all: async () => [{ url: b.url, ok: true, name: b.name, summary: { name: b.name, tasks: [] } }],
    post: async (_u: string, path: string, body: any) => (path === '/peer/move/start' ? b.sessions.moveStart(body) : path === '/peer/move/finish' ? b.sessions.moveFinish(body) : null),
    postRaw: async (_u: string, path: string, buf: Buffer) => { const q = new URL(`http://x${path}`).searchParams; return b.sessions.moveChunk(q.get('id')!, Number(q.get('offset')), buf); },
  };
}

test('다른 PC 로 옮기기: 대화 · 역할 · 예약 · 작업 폴더(git 의 커밋 안 된 변경까지)를 옮기고, 큰 것 · 고르지 않은 비밀 파일은 빼고, 원래 작업은 "옮김"으로 보관 · 예약은 끔. 되돌리기도 같은 길', async () => {
  const a = pc('a'), b = pc('b');
  link(a, b); link(b, a);
  const dir = join(a.ws, 'game');
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x', 'big.js'), 'x'.repeat(1000));
  writeFileSync(join(dir, 'package.json'), '{"name":"g"}');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(dir, 'main.js'), 'v1');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  git('init', '-q'); git('add', 'main.js', 'package.json'); git('commit', '-qm', 'v1');
  writeFileSync(join(dir, 'main.js'), 'v2 커밋 안 함');
  await a.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'game' }, local);
  const id = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  await a.sessions.handle({ type: 'user.message', sessionId: id, text: '게임 장면 만들기' }, local);
  await waitFor(a.events, (e) => e.type === 'turn.done' && e.sessionId === id);
  a.schedules.save({ sessionId: id, prompt: '매일 점검', repeat: 'daily', time: '09:00', enabled: true });

  const plan = a.sessions.movePlan(id);
  assert.equal(plan.own, true);
  assert.equal(plan.git, true);
  assert.deepEqual(plan.secrets, ['.env']);
  assert.ok(plan.skipped.includes('node_modules'));
  assert.deepEqual(plan.setup, ['npm install']);

  await a.sessions.handle({ type: 'session.moveToPeer', sessionId: id, url: b.url, folder: 'game' } as any, local);
  assert.ok(!a.events.some((e) => e.type === 'error'), JSON.stringify(a.events.filter((e) => e.type === 'error')));
  const made = b.events.find((e) => e.type === 'session.created').session;
  const to = made.workdir;
  assert.equal(readFileSync(join(to, 'main.js'), 'utf8'), 'v2 커밋 안 함', '커밋 안 된 변경까지');
  assert.ok(existsSync(join(to, '.git')), 'git 저장소 그대로');
  assert.ok(!existsSync(join(to, 'node_modules')), '큰 것은 빼고');
  assert.ok(!existsSync(join(to, '.env')), '고르지 않은 비밀 파일은 빼고');
  assert.ok(b.events.some((e) => e.type === 'session.merged' && /게임 장면 만들기/.test(e.text)), '대화 요약');
  assert.equal(b.schedules.forSession(made.id).length, 1);
  assert.equal(b.schedules.forSession(made.id)[0].enabled, true, '받는 PC 에서 켬');
  assert.equal(a.schedules.forSession(id)[0].enabled, false, '원래 PC 에서는 끔');
  assert.equal(a.sessions.info(id)!.archived, true);
  assert.deepEqual(a.sessions.info(id)!.movedTo, { url: b.url, id: made.id, pc: 'b' });
  assert.ok(b.events.some((e) => e.type === 'notice' && /할 일/.test(e.message)), '옮길 수 없는 것을 받는 쪽 할 일로');

  // 되돌리기: 받은 PC 에서 다시 원래 PC 로(비밀 파일을 골라 함께)
  writeFileSync(join(to, '.env'), 'SECRET=2');
  await b.sessions.handle({ type: 'session.moveToPeer', sessionId: made.id, url: a.url, folder: 'game', secrets: ['.env'] } as any, local);
  assert.ok(!b.events.some((e) => e.type === 'error'), JSON.stringify(b.events.filter((e) => e.type === 'error')));
  const back = a.events.filter((e) => e.type === 'session.created').at(-1).session;
  assert.notEqual(back.id, id);
  assert.match(back.workdir, /game-2$/, '원래 폴더는 그대로 두고 옆에');
  assert.equal(readFileSync(join(back.workdir, '.env'), 'utf8'), 'SECRET=2', '고른 비밀 파일은 옮김');
  assert.equal(a.schedules.forSession(back.id)[0].enabled, true);
  a.sessions.stopAll(); b.sessions.stopAll();
});

test('옮기기 이어 받기: 받은 만큼은 건너뛰고, 내용이 바뀌면 처음부터', () => {
  const b = pc('b');
  assert.equal(b.sessions.moveStart({ id: 'abcd-1234', size: 10, sha1: 'x' }).have, 0);
  assert.equal(b.sessions.moveChunk('abcd-1234', 0, Buffer.from('12345')).have, 5);
  assert.equal(b.sessions.moveChunk('abcd-1234', 0, Buffer.from('12345')).have, 5, '어긋난 조각은 버림');
  assert.equal(b.sessions.moveStart({ id: 'abcd-1234', size: 10, sha1: 'x' }).have, 5, '같은 묶음이면 이어서');
  assert.equal(b.sessions.moveStart({ id: 'abcd-1234', size: 12, sha1: 'y' }).have, 0, '바뀌었으면 처음부터');
  assert.throws(() => b.sessions.moveStart({ id: '../x', size: 1, sha1: 'z' }));
  b.sessions.stopAll();
});
