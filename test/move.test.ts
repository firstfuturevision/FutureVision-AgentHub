import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
    myUrl: () => a.url,
    setParent: async (_u: string, taskId: string, parentId: string | null, me: string) => b.sessions.setRemoteParent(taskId, parentId ? { url: a.url, id: parentId, pc: me } : null),
    cmd: async (_u: string, c: any) => b.sessions.handle(c, local),
    all: async () => [{ url: b.url, ok: true, name: b.name, summary: b.sessions.peerSummary(b.name) }],
    post: async (_u: string, path: string, body: any) => (path === '/peer/move/start' ? b.sessions.moveStart(body) : path === '/peer/move/finish' ? b.sessions.moveFinish(body) : path === '/peer/image' ? b.sessions.receiveRemoteImage(body.to, body.fromPc, body.title, body) : null),
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
  // 이미 옮긴(보관된) 작업은 다시 옮기지 않는다 — 두 번 눌러 받는 PC 에 같은 작업이 둘 생기지 않게
  const nb = b.events.filter((e) => e.type === 'session.created').length;
  await a.sessions.handle({ type: 'session.moveToPeer', sessionId: id, url: b.url } as any, local);
  assert.ok(a.events.some((e) => e.type === 'error' && /이미 b 로 옮긴/.test(e.message)));
  assert.equal(b.events.filter((e) => e.type === 'session.created').length, nb);
  a.events.splice(0, a.events.length, ...a.events.filter((e) => e.type !== 'error'));
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

test('옮기기: 하위 작업도 함께(받는 PC 에서도 그 아래로), 채팅 그림 · 모델 · 생각 깊이 · 입력 거치기 설정도 그대로', async () => {
  const a = pc('a'), b = pc('b');
  link(a, b);
  mkdirSync(join(a.ws, 'proj', '첨부'), { recursive: true });
  writeFileSync(join(a.ws, 'proj', '첨부', '한글.txt'), '내용');
  await a.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', model: 'claude-opus-5-5', workdir: 'proj' }, local);
  const top = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  await a.sessions.handle({ type: 'session.effort', sessionId: top, effort: 'high' } as any, local);
  await a.sessions.handle({ type: 'session.setIntake', sessionId: top, on: true } as any, local);
  await a.sessions.handle({ type: 'session.setIntake', sessionId: top, on: false } as any, local);
  await a.sessions.handle({ type: 'session.split', sessionId: top }, local); // 하위 작업은 위 작업과 같은 폴더
  const kid = (await waitFor(a.events, (e) => e.type === 'session.created' && e.session.splitFrom === top)).session.id;
  // 채팅 그림 하나(작은 png)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = join(a.base, 'shot.png'); writeFileSync(img, png);
  await (a.sessions as any).showImage(top, { path: img });
  await a.sessions.handle({ type: 'session.moveToPeer', sessionId: top, url: b.url, withKids: true } as any, local);
  assert.ok(!a.events.some((e) => e.type === 'error'), JSON.stringify(a.events.filter((e) => e.type === 'error')));
  const made = b.events.filter((e) => e.type === 'session.created').map((e) => e.session);
  assert.equal(made.length, 2, '위 · 하위 작업 둘 다');
  const [bTop, bKid] = made;
  assert.equal(b.sessions.info(bKid.id)!.splitFrom, bTop.id, '받는 PC 에서도 위 작업 아래로');
  assert.equal(b.sessions.info(bKid.id)!.workdir, b.sessions.info(bTop.id)!.workdir, '같은 폴더를 쓰던 하위 작업은 받는 PC 에서도 같은 폴더');
  assert.equal(readFileSync(join(b.sessions.info(bTop.id)!.workdir, '첨부', '한글.txt'), 'utf8'), '내용', '함께 쓰던 폴더는 위 작업과 함께 한 번에');
  assert.equal(b.sessions.info(bTop.id)!.model, 'claude-opus-5-5');
  assert.equal(b.sessions.info(bTop.id)!.effort, 'high');
  assert.ok(!b.sessions.info(bTop.id)!.viaIntake, '입력 거치기 꺼 둔 것 그대로');
  assert.ok(b.events.some((e) => e.type === 'agent.image' && e.sessionId === bTop.id), '채팅 그림');
  assert.equal(a.sessions.info(top)!.archived, true);
  assert.equal(a.sessions.info(kid)!.archived, true);
  a.sessions.stopAll(); b.sessions.stopAll();
});

test('묶음: 한글 경로 · 빈 폴더 · 빼는 폴더 · 윈도우에서 못 쓰는 이름은 바꿔 풀고, 폴더 밖 이름은 버림', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent hub pack '));
  const src = join(base, 'src');
  mkdirSync(join(src, '첨부', '빈 폴더'), { recursive: true });
  mkdirSync(join(src, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(src, '첨부', '20261118-024644-image.png'), Buffer.from([1, 2, 3]));
  writeFileSync(join(src, 'a:b?.txt'), '윈도우 금지 글자');
  writeFileSync(join(src, 'node_modules', 'x', 'big.js'), 'x');
  writeFileSync(join(src, '.env'), 'S=1');
  writeFileSync(join(src, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  const { packFolder, packFiles, unpackTo } = await import('../src/move.ts');
  const out = join(base, 'a.pk');
  await packFolder(src, out, ['.env']);
  const linux = join(base, 'linux'); mkdirSync(linux);
  assert.deepEqual((await unpackTo(out, linux, false)).renamed, []);
  assert.deepEqual([...readFileSync(join(linux, '첨부', '20261118-024644-image.png'))], [1, 2, 3]);
  assert.ok(existsSync(join(linux, '첨부', '빈 폴더')));
  assert.equal(readFileSync(join(linux, 'a:b?.txt'), 'utf8'), '윈도우 금지 글자');
  assert.equal(readFileSync(join(linux, 'big.bin')).length, 3 * 1024 * 1024);
  assert.ok(!existsSync(join(linux, 'node_modules')));
  assert.ok(!existsSync(join(linux, '.env')));
  const win = join(base, 'win'); mkdirSync(win);
  const r = await unpackTo(out, win, true); // 윈도우처럼: 못 쓰는 이름은 바꿔 푼다
  assert.deepEqual(r.renamed, ['a:b?.txt']);
  assert.equal(readFileSync(join(win, 'a_b_.txt'), 'utf8'), '윈도우 금지 글자');
  // 첨부만 묶기
  const out2 = join(base, 'b.pk');
  await packFiles(src, out2, ['첨부/20261118-024644-image.png']);
  const only = join(base, 'only'); mkdirSync(only);
  await unpackTo(out2, only, false);
  assert.deepEqual(readdirSync(only), ['첨부']);
  // 예전 형식(tar.gz)도 푼다
  const tgz = join(base, 'old.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', src, '첨부']);
  const old = join(base, 'old'); mkdirSync(old);
  await unpackTo(tgz, old, false);
  assert.ok(existsSync(join(old, '첨부', '20261118-024644-image.png')));
});

test('옮긴 뒤 트리 자리: 하위 작업만 옮기면 받는 PC 에서 원래 PC 의 위 작업 아래로(같은 순서), 위 작업만 옮기면 남은 하위 작업이 옮겨 간 작업 아래로', async () => {
  const a = pc('a'), b = pc('b');
  link(a, b);
  await a.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude' }, local);
  const top = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  await a.sessions.handle({ type: 'session.split', sessionId: top }, local);
  const k1 = (await waitFor(a.events, (e) => e.type === 'session.created' && e.session.splitFrom === top)).session.id;
  await a.sessions.handle({ type: 'session.reorder', sessionId: k1, rank: 12345 } as any, local);
  // 하위 작업만 옮기기
  await a.sessions.handle({ type: 'session.moveToPeer', sessionId: k1, url: b.url } as any, local);
  const bk1 = b.events.filter((e) => e.type === 'session.created').at(-1).session.id;
  assert.deepEqual(b.sessions.info(bk1)!.remoteParent, { url: a.url, id: top, pc: 'a' }, '원래 PC 의 위 작업 아래');
  assert.equal(b.sessions.info(bk1)!.rank, 12345, '같은 순서');
  // 위 작업만 옮기기(남은 하위 작업 하나)
  await a.sessions.handle({ type: 'session.split', sessionId: top }, local);
  const k2 = (await waitFor(a.events, (e) => e.type === 'session.created' && e.session.splitFrom === top && e.session.id !== k1)).session.id;
  await a.sessions.handle({ type: 'session.moveToPeer', sessionId: top, url: b.url } as any, local);
  const btop = b.events.filter((e) => e.type === 'session.created').at(-1).session.id;
  assert.deepEqual(a.sessions.info(k2)!.remoteParent, { url: b.url, id: btop, pc: 'b' }, '남은 하위 작업은 옮겨 간 작업 아래');
  assert.ok(!a.sessions.info(k2)!.splitFrom);
  a.sessions.stopAll(); b.sessions.stopAll();
});

test('위 작업을 옮기면 그 아래에 붙어 있던 다른 PC 작업도 따라간다(받는 PC 작업이면 그 PC 안의 위 · 하위로, 순서 그대로)', async () => {
  const a = pc('a'), b = pc('b');
  link(a, b);
  await a.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude' }, local);
  const top = (await waitFor(a.events, (e) => e.type === 'session.created')).session.id;
  // b 의 작업 하나가 a 의 top 아래에 있다(다른 PC 하위 작업)
  await b.sessions.handle({ type: 'session.create', role: 'main', agent: 'claude' }, local);
  const hosted = (await waitFor(b.events, (e) => e.type === 'session.created')).session.id;
  b.sessions.setRemoteParent(hosted, { url: a.url, id: top, pc: 'a' });
  await b.sessions.handle({ type: 'session.reorder', sessionId: hosted, rank: 777 } as any, local);
  await a.sessions.handle({ type: 'session.moveToPeer', sessionId: top, url: b.url } as any, local);
  const btop = b.events.filter((e) => e.type === 'session.created').at(-1).session.id;
  assert.notEqual(btop, hosted);
  assert.equal(b.sessions.info(hosted)!.splitFrom, btop, '옮겨 온 위 작업 아래로');
  assert.ok(!b.sessions.info(hosted)!.remoteParent, '보관된 a 의 작업을 더는 가리키지 않음');
  assert.equal(b.sessions.info(hosted)!.rank, 777, '순서 그대로');
  a.sessions.stopAll(); b.sessions.stopAll();
});
