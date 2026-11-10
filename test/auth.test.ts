import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore } from '../src/auth.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'agent hub auth '));
const FAKE_KEY = 'test-key-not-real-1234567890';

test('연동: 키는 화면으로 나가지 않고, AI 마다 맞는 환경 변수로만 넣는다', () => {
  const dir = tmp();
  const auth = new AuthStore(join(dir, 'auth.json'));
  assert.throws(() => auth.set('claude', { mode: 'apikey' }), /API 키를 먼저/);
  auth.set('claude', { mode: 'apikey', key: FAKE_KEY });
  auth.set('codex', { mode: 'apikey', key: FAKE_KEY });
  auth.set('gemini', { mode: 'login', project: 'my-company-proj' });

  const pub = JSON.stringify(auth.public());
  assert.ok(!pub.includes(FAKE_KEY)); // 키 값은 절대 안 나감
  assert.deepEqual(auth.public().claude, { mode: 'apikey', hasKey: true });

  assert.deepEqual(auth.launch('claude'), { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  assert.deepEqual(auth.launch('codex'), { env: { OPENAI_API_KEY: FAKE_KEY, CODEX_API_KEY: FAKE_KEY }, authMethod: 'api-key' });
  assert.deepEqual(auth.launch('gemini'), { env: { GOOGLE_CLOUD_PROJECT: 'my-company-proj' } }); // 로그인 + 회사 프로젝트

  // Gemini API 키: 개인 설정 대신 Hub 전용 시스템 설정으로 인증 방식만 바꾼다
  auth.set('gemini', { mode: 'apikey', key: FAKE_KEY });
  const g = auth.launch('gemini');
  assert.equal(g.env.GEMINI_API_KEY, FAKE_KEY);
  assert.equal(JSON.parse(readFileSync(g.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')).security.auth.selectedType, 'gemini-api-key');

  // 다시 읽어도 같고, 키 지우기·잘못된 값 거부
  const again = new AuthStore(join(dir, 'auth.json'));
  assert.equal(again.public().codex.hasKey, true);
  assert.throws(() => again.set('codex', { key: null }), /API 키를 먼저/); // API 키 모드인데 키를 지우면 안 됨
  again.set('codex', { mode: 'login', key: null });
  assert.deepEqual(again.launch('codex'), { env: {} });
  assert.throws(() => again.set('claude', { key: 'has space key' }), /형식/);
  assert.throws(() => again.set('gemini', { project: 'BAD_ID' }), /프로젝트 ID/);
});

test('연동: API 키로 정하면 그 CLI 프로세스에만 환경 변수가 들어간다', async () => {
  const base = tmp();
  mkdirSync(join(base, 'ws'), { recursive: true });
  const auth = new AuthStore(join(base, 'data', 'auth.json'));
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    auth,
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const ask = async () => {
    await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude' }, { via: 'local', user: 'local' });
    const id = (await waitFor(events, (e) => e.type === 'session.created' && !events.some((x) => x.type === 'user.message' && x.sessionId === e.session.id))).session.id;
    await sessions.handle({ type: 'user.message', sessionId: id, text: 'env?' }, { via: 'local', user: 'local' });
    return (await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === id)).text;
  };
  assert.ok(!process.env.ANTHROPIC_API_KEY, '이 시험은 PC 에 ANTHROPIC_API_KEY 가 없을 때 의미가 있다');
  assert.equal(await ask(), 'env: ANTHROPIC_API_KEY=unset CLAUDE_CONFIG_DIR=unset');
  auth.set('claude', { mode: 'apikey', key: FAKE_KEY });
  assert.equal(await ask(), 'env: ANTHROPIC_API_KEY=set CLAUDE_CONFIG_DIR=unset');
  assert.ok(!process.env.ANTHROPIC_API_KEY); // 호스트 자신의 환경은 그대로
  sessions.stopAll();
});
