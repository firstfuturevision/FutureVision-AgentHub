import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubSkillStore } from '../src/hubskills.ts';
import { PresetStore } from '../src/presets.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'agent hub profile '));
const pc = { via: 'local' as const, user: 'local' };

test('Agent Hub 스킬: 저장·목록·지우기, 이름 규칙', () => {
  const store = new HubSkillStore(join(tmp(), 'skills'));
  store.save({ name: 'quote-writing', description: '견적서를 쓸 때: 단가표 기준', body: '1. 단가표를 읽는다\n2. 합계를 낸다' });
  store.save({ name: 'code-review', description: '코드 검토', body: '버그만 찾는다' });
  assert.deepEqual(store.list().map((s) => s.name), ['code-review', 'quote-writing']);
  assert.equal(store.list()[1].description, '견적서를 쓸 때: 단가표 기준'); // 콜론이 있어도 그대로
  assert.deepEqual(store.pick(['code-review', '없는것']), ['code-review']);
  assert.deepEqual(store.pick(undefined), ['code-review', 'quote-writing']);
  assert.throws(() => store.save({ name: 'Bad Name', description: 'x', body: 'y' }), /스킬 이름/);
  assert.throws(() => store.save({ name: 'ok', description: '', body: 'y' }), /설명/);
  store.remove('code-review');
  assert.deepEqual(store.list().map((s) => s.name), ['quote-writing']);
});

test('프리셋 세션은 전용 프로필(CLAUDE_CONFIG_DIR) + 고른 스킬만, 기본 메인은 계정 그대로', async () => {
  const base = tmp();
  mkdirSync(join(base, 'ws'), { recursive: true });
  const hubSkills = new HubSkillStore(join(base, 'data', 'skills'));
  hubSkills.save({ name: 'quote-writing', description: '견적', body: '단가표' });
  hubSkills.save({ name: 'code-review', description: '검토', body: '버그만' });
  const presets = new PresetStore(join(base, 'data', 'presets.json'));
  presets.save({ name: '견적 담당', agent: 'claude', instructions: '견적만', skills: ['quote-writing'] });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    presets,
    hubSkills,
    profilesDir: join(base, 'data', 'profiles'),
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const ask = async (id: string, text: string) => {
    const n = events.filter((e) => e.type === 'turn.done' && e.sessionId === id).length;
    await sessions.handle({ type: 'user.message', sessionId: id, text }, pc);
    await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === id && events.filter((x) => x.type === 'turn.done' && x.sessionId === id).length > n);
    return (events.filter((e) => e.type === 'agent.text' && !e.partial && e.sessionId === id).at(-1) as any).text as string;
  };

  // 프리셋 메인
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', preset: '견적 담당' }, pc);
  const p = (await waitFor(events, (e) => e.type === 'session.created' && e.session.preset)).session;
  await ask(p.id, 'hi'); // 첫 지시에는 역할 지침이 붙으므로 한 번 인사
  assert.equal(await ask(p.id, 'env?'), `env: ANTHROPIC_API_KEY=unset CLAUDE_CONFIG_DIR=${join(base, 'data', 'profiles', 'claude')}`);
  const argv = await ask(p.id, 'argv?');
  const plugin = join(base, 'data', 'mcp', `${p.id}-skills`);
  assert.ok(argv.includes(`--plugin-dir ${plugin}`), argv);
  assert.ok(existsSync(join(plugin, '.claude-plugin', 'plugin.json')));
  assert.ok(existsSync(join(plugin, 'skills', 'quote-writing', 'SKILL.md')));
  assert.ok(!existsSync(join(plugin, 'skills', 'code-review'))); // 고르지 않은 스킬은 없음
  assert.deepEqual(sessions.skillsOf(p.id).map((s) => `${s.name}/${s.where}`), ['quote-writing/Agent Hub']);

  // 기본 메인
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude' }, pc);
  const d = (await waitFor(events, (e) => e.type === 'session.created' && !e.session.preset && e.session.role === 'main')).session;
  assert.equal(await ask(d.id, 'env?'), 'env: ANTHROPIC_API_KEY=unset CLAUDE_CONFIG_DIR=unset');
  assert.doesNotMatch(await ask(d.id, 'argv?'), /--plugin-dir/);
  sessions.stopAll();
});
