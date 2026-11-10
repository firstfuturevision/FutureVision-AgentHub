import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFolders, createFolder } from '../src/folders.ts';

test('작업 폴더: 뿌리 + 바로 아래 폴더만(숨김·파일 제외), 새 폴더는 뿌리 바로 아래에만', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent hub folders '));
  mkdirSync(join(root, '견적 프로젝트'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'memo.txt'), 'x');
  assert.deepEqual(listFolders(root).map((f) => f.name), ['', '견적 프로젝트']);

  createFolder(root, ' 새 작업 ');
  assert.deepEqual(listFolders(root).map((f) => f.name), ['', '견적 프로젝트', '새 작업'].sort((a, b) => a.localeCompare(b, 'ko')));

  for (const bad of ['../밖', 'a/b', 'a\\b', '..', '.숨김', 'con', 'x:y', '']) {
    assert.throws(() => createFolder(root, bad), /폴더 이름|쓸 수 없는/, bad);
  }
  assert.throws(() => createFolder(root, '견적 프로젝트'), /이미 있는/);
});

test('폴더 찾아보기: 폴더만(숨김·파일 빼고), 위 폴더, 없는 폴더는 오류', async () => {
  const { browseFolders } = await import('../src/folders.ts');
  const root = mkdtempSync(join(tmpdir(), 'agent hub browse '));
  mkdirSync(join(root, '자료'));
  mkdirSync(join(root, '.cache'));
  writeFileSync(join(root, 'a.txt'), 'x');
  const b = browseFolders(root);
  assert.deepEqual(b.dirs.map((d) => d.name), ['자료']);
  assert.ok(b.parent);
  assert.ok(b.roots.length >= 1);
  assert.throws(() => browseFolders(join(root, '없음')), /없는 폴더/);
});

test('폴더 연결: 뿌리 밖 폴더는 PC 앞에서만, 키가 든 data 폴더·드라이브 전체는 안 됨', async () => {
  const { SessionManager } = await import('../src/sessions.ts');
  const { ClaudeAdapter } = await import('../src/adapters/claude.ts');
  const { dirname, parse } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const base = mkdtempSync(join(tmpdir(), 'agent hub dirs '));
  const ws = join(base, 'workspace');
  const outside = join(base, '다른 자료');
  mkdirSync(join(ws, 'proj'), { recursive: true });
  mkdirSync(outside);
  const events: any[] = [];
  const sessions = new SessionManager({
    workspaceRoot: ws,
    dataDir: join(base, 'data'),
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const local = { via: 'local' as const, user: 'local' };
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workdir: 'proj' }, local);
  const id = events.find((e) => e.type === 'session.created').session.id;
  const lastErr = () => events.filter((e) => e.type === 'error').at(-1)?.message ?? '';

  await sessions.handle({ type: 'session.dirs', sessionId: id, dirs: [outside] }, { via: 'dashboard', user: 'kim' });
  assert.match(lastErr(), /PC 앞에서만/);
  await sessions.handle({ type: 'session.dirs', sessionId: id, dirs: [outside] }, local);
  assert.deepEqual(sessions.info(id)?.extraDirs, [outside]);
  // 대시보드에서 다른 것을 바꿔도 이미 연결된 밖 폴더는 남는다
  await sessions.handle({ type: 'session.dirs', sessionId: id, dirs: [outside, '.'] }, { via: 'dashboard', user: 'kim' });
  assert.deepEqual(sessions.info(id)?.extraDirs, [outside, ws]);

  await sessions.handle({ type: 'session.dirs', sessionId: id, dirs: [base] }, local); // data 를 품은 폴더
  assert.match(lastErr(), /기록·키/);
  await sessions.handle({ type: 'session.dirs', sessionId: id, dirs: [parse(base).root] }, local);
  assert.match(lastErr(), /드라이브 전체/);
  sessions.stopAll();
});
