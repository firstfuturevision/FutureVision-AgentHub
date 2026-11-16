import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataAllows, dataBashAllows } from '../src/permits.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const API = 'http://127.0.0.1:8000/api/';

test('데이터만: 허락한 주소로 보내는 curl 과 읽기 명령만, 파일 쓰기·다른 명령·다른 주소는 거절', () => {
  const ok = (c: string) => dataBashAllows(c, [API]).ok;
  // 되는 것
  assert.ok(ok(`curl -s -X POST ${API}agent/all/tools/task_create/ -H "Authorization: Token $(cat ~/.config/x/token)" -H 'content-type: application/json' -d '{"title":"태스크 <1>"}'`));
  assert.ok(ok(`curl -s ${API}projects/ | jq '.[0]'`));
  assert.ok(ok('cat ~/.config/x/token'));
  assert.ok(ok('TOKEN=$(cat t) curl -s ' + API + 'a/'));
  // 안 되는 것
  assert.equal(ok('systemctl --user restart dashboard'), false);
  assert.equal(ok('git push'), false);
  assert.equal(ok('rm -rf /tmp/x'), false);
  assert.equal(ok('echo hi > a.txt'), false); // 파일로 쓰기
  assert.equal(ok('cat a | tee b'), false);
  assert.equal(ok(`curl -s ${API}x -o out.json`), false);
  assert.equal(ok(`curl -so out ${API}x`), false);
  assert.equal(ok(`curl -d @secret.txt ${API}x`), false);
  assert.equal(ok('curl -s https://evil.example.com/'), false);
  assert.equal(ok(`curl -s ${API}x && curl https://evil.example.com`), false);
  assert.equal(ok('echo `id`'), false);
  assert.equal(ok('cat $(rm -rf x)'), false);
  assert.equal(ok('sleep 100 &'), false);
  assert.equal(ok('python3 -c "print(1)"'), false);
  assert.match(dataBashAllows('systemctl stop x', [API]).why, /허락하지 않은 명령: systemctl/);
  // 도구
  assert.ok(dataAllows('Read', undefined, [API]).ok);
  assert.equal(dataAllows('Edit', undefined, [API]).ok, false);
  assert.equal(dataAllows(undefined, undefined, [API]).ok, false); // 무슨 도구인지 모르면(다른 AI) 거절
  assert.ok(dataAllows('WebFetch', `${API}x`, [API]).ok);
  assert.equal(dataAllows('WebFetch', 'https://evil.example.com', [API]).ok, false);
  assert.equal(dataBashAllows(`curl ${API}x`, []).ok, false); // 허락 주소가 없으면 curl 도 안 됨
});

test('데이터만 작업: "모든 작업 권한 묻지 않기"가 켜져 있어도 묻지 않고 규칙대로 허용·거절, 파일 수정 도구는 빠진 채로', async () => {
  const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const base = mkdtempSync(join(tmpdir(), 'agent hub data mode '));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const events: HostEvent[] = [];
  const sessions = new SessionManager({ workspaceRoot: ws, dataDir: join(base, 'data'), makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [fake], permissionMode: 'default' }) });
  sessions.subscribe((e) => events.push(e));
  sessions.autoApproveAll = true;
  const local = { via: 'local' as const, user: 'local' };
  const phone = { via: 'dashboard' as const, user: '직원' };
  try {
    await sessions.handle({ type: 'session.create', agent: 'claude', role: 'main', title: '채팅 담당' }, local);
    const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    await sessions.handle({ type: 'session.configure', sessionId: id, permMode: 'data', permAllow: [API, 'ftp://x'] }, local);
    assert.equal(sessions.info(id)?.permMode, 'data');
    assert.deepEqual(sessions.info(id)?.permAllow, [API]); // http(s) 주소만
    await waitFor(events, () => sessions.info(id)?.status === 'idle');
    const say = async (text: string) => {
      const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
      await sessions.handle({ type: 'user.message', sessionId: id, text }, local);
      await waitFor(events, () => events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length > n);
      return (events.filter((e) => e.type === 'agent.text' && e.sessionId === id && !(e as any).partial).at(-1) as any).text as string;
    };
    assert.match(await say(`bash curl -s -X POST ${API}tools/task_create/ -d '{"title":"t"}'`), /bash 허용/);
    assert.match(await say('bash systemctl --user restart x'), /bash 거절/);
    assert.match(await say('bash echo x > /tmp/a'), /bash 거절/);
    const res = events.filter((e) => e.type === 'permission.resolved' && e.sessionId === id) as any[];
    assert.ok(res.every((r) => /^데이터만/.test(r.by))); // 묻지 않고 규칙으로(권한 묻지 않기보다 먼저)
    assert.match(res.at(-1).by, /거절\(파일로 쓰기/);
    assert.match(await say('빠진 도구?'), /Edit,MultiEdit,Write,NotebookEdit,mcp__hub__screen_click/);
    // 푸는 것과 허락 주소 늘리기는 PC 앞에서만
    await sessions.handle({ type: 'session.configure', sessionId: id, permAllow: [API, 'https://more.example.com/'] }, phone);
    assert.deepEqual(sessions.info(id)?.permAllow, [API]);
    await sessions.handle({ type: 'session.configure', sessionId: id, permMode: null }, phone);
    assert.equal(sessions.info(id)?.permMode, 'data');
  } finally {
    sessions.stopAll();
  }
});

test('데이터만: 읽기 조회는 묻지 않고 — 버리는 출력 돌리기, 짧은 셸 함수, sqlite3 읽기 SQL', () => {
  const v = (c: string) => dataBashAllows(c, [API]);
  // 실제로 막혔던 명령(대시보드 도구 API 를 함수로 여러 번 부름)
  const real = `T=$(cat ~/.config/x/token); B=${API}agent/all/tools\nc(){ curl -s -X POST "$B/$1/" -H "Authorization: Token $T" -H "Content-Type: application/json" -d "$2"; echo; }\nc user_list '{}' | head -c 1500\nc task_list '{"status":"in_progress"}' | head -c 6000`;
  assert.ok(v(real).ok, v(real).why);
  assert.ok(v('ls -d /home/x/*dash* 2>/dev/null').ok);
  assert.ok(v(`curl -s ${API}a/ 2>&1 | head`).ok);
  assert.ok(v("sqlite3 -readonly db.sqlite3 'SELECT id, title FROM task LIMIT 5'").ok);
  assert.ok(v('sqlite3 -header db.sqlite3 ".tables"').ok);
  assert.ok(v("sqlite3 db.sqlite3 'PRAGMA table_info(task)'").ok);
  // 여전히 안 되는 것
  assert.equal(v("sqlite3 db.sqlite3 'DELETE FROM task'").ok, false);
  assert.equal(v("sqlite3 db.sqlite3 'SELECT 1; DROP TABLE task'").ok, false);
  assert.equal(v("sqlite3 db.sqlite3 '.output x.txt'").ok, false);
  assert.equal(v('sqlite3 db.sqlite3').ok, false); // 입력을 기다리는 것
  assert.equal(v('c(){ rm -rf /tmp/x; }; c').ok, false); // 함수 몸통도 같은 규칙
  assert.equal(v('c(){ curl -s https://evil.example.com; }; c').ok, false);
  assert.equal(v('echo hi > /dev/nullx').ok, false);
  assert.equal(v('echo hi 2> err.txt').ok, false);
  assert.match(v('curl -s https://work.example.com/api/x').why, /허락한 주소: http:\/\/127\.0\.0\.1:8000\/api\//);
});

test('데이터만: 변수로 쓴 curl 주소는 한 번만 넣은 글자 그대로의 값만 풀어 본다', () => {
  const v = (c: string) => dataBashAllows(c, [API]).ok;
  assert.ok(v(`B=${API}x; curl -s "$B/a/"`));
  assert.equal(v(`B=${API}x; B=https://evil.example.com; curl -s "$B/a/"`), false);
  assert.equal(v(`B=https://evil.example.com; curl -s "$B/a/"`), false);
  assert.equal(v(`B=$(cat u); curl -s "$B/a/"`), false);
});
