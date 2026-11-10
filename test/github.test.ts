import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub } from '../src/github.ts';
import { findCommand, cliStatus, installCommand } from '../src/install.ts';
const until = async (f: () => Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error('시간 초과'); await new Promise((r) => setTimeout(r, 100)); } };

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'agent hub gh '));
const fake = () => [process.execPath, join(here, 'fake-gh.mjs')];

test('GitHub: 로그인 코드 받기 → 승인되면 계정 이름, 세션에만 git 자격 증명', async () => {
  const dir = join(tmp(), 'gh');
  const gh = new GitHub(dir, { cmd: fake(), known: [] });

  const before = await gh.status();
  assert.deepEqual(before, { installed: true, version: '9.9.9' });
  assert.deepEqual(gh.sessionEnv(), {}); // 로그인 전엔 아무것도 넣지 않는다

  const code = await gh.startLogin();
  assert.deepEqual(code, { code: 'ABCD-1234', url: 'https://github.com/login/device' });
  const mid = await gh.status();
  assert.ok(mid.pending?.code === 'ABCD-1234' || mid.login === 'fv-bot');

  await until(async () => (await gh.status()).login === 'fv-bot' && !(await gh.status()).pending);
  const after = await gh.status();
  assert.equal(after.pending, undefined); // gh 가 끝나면 대기 상태도 사라진다

  const env = gh.sessionEnv();
  assert.equal(env.GH_CONFIG_DIR, dir);
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '!gh auth git-credential');
  assert.ok(!JSON.stringify(after).includes('token'));

  await gh.logout();
  assert.equal((await gh.status()).login, undefined);
  assert.deepEqual(gh.sessionEnv(), {});
});

test('GitHub: gh 가 없으면 설치 안 됨', async () => {
  const gh = new GitHub(join(tmp(), 'gh'), { cmd: ['no-such-gh-command-xyz'], known: [] });
  assert.deepEqual(await gh.status(), { installed: false });
  assert.match(gh.installCommand(), process.platform === 'win32' ? /winget install --id GitHub\.cli/ : /gh/);
});

test('설치: PATH 에서 명령 찾기와 AI 별 설치 명령', () => {
  const bin = tmp();
  const name = process.platform === 'win32' ? 'mycli.cmd' : 'mycli';
  writeFileSync(join(bin, name), '');
  mkdirSync(join(bin, 'sub'));
  assert.equal(findCommand('mycli', bin), join(bin, name));
  assert.equal(findCommand('nothere', bin), undefined);
  assert.equal(findCommand(join(bin, name)), join(bin, name)); // 절대 경로

  const old = process.env.PATH;
  process.env.PATH = bin;
  try {
    const st = cliStatus({ claude: ['mycli'], codex: ['mycli', 'codex-acp-none'], gemini: ['gem-none'] });
    assert.deepEqual(st.claude, { installed: true, missing: [] });
    assert.deepEqual(st.codex, { installed: false, missing: ['codex-acp-none'] });
    assert.equal(st.gemini.installed, false);
  } finally {
    process.env.PATH = old;
  }
  assert.equal(installCommand('codex'), 'npm install -g @openai/codex @agentclientprotocol/codex-acp');
  assert.equal(installCommand('claude'), 'npm install -g @anthropic-ai/claude-code');
});
