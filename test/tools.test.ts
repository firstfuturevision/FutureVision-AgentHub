import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolStore } from '../src/tools.ts';
import { PresetStore } from '../src/presets.ts';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { AcpAdapter } from '../src/adapters/acp.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'agent hub tools '));

test('툴 저장소: http·stdio 저장, 끄면 enabled 에서 빠짐, 잘못된 값 거부', () => {
  const store = new ToolStore(join(tmp(), 'tools.json'));
  const a = store.save({ name: 'docs', type: 'http', url: 'https://example.com/mcp', description: '사내 문서' });
  store.save({ name: 'fs-tools', type: 'stdio', command: 'npx', args: ['some-mcp', ' --flag ', ''] });
  assert.deepEqual(store.list().find((t) => t.name === 'fs-tools')?.args, ['some-mcp', '--flag']);
  store.save({ ...a, enabled: false });
  assert.deepEqual(store.enabled().map((t) => t.name), ['fs-tools']);

  assert.throws(() => store.save({ name: 'Docs!', type: 'http', url: 'https://x' }), /이름은/);
  assert.throws(() => store.save({ name: 'hub', type: 'http', url: 'https://x' }), /쓸 수 없는 이름/);
  assert.throws(() => store.save({ name: 'x', type: 'http', url: 'file:///etc' }), /http/);
  assert.throws(() => store.save({ name: 'y', type: 'stdio', command: '' }), /명령/);
  assert.throws(() => store.save({ name: 'docs', type: 'http', url: 'https://y' }), /같은 이름/);
});

function setup(agent: 'claude' | 'gemini') {
  const base = tmp();
  mkdirSync(join(base, 'ws'), { recursive: true });
  const tools = new ToolStore(join(base, 'data', 'tools.json'));
  tools.save({ name: 'docs', type: 'http', url: 'https://example.com/mcp' });
  tools.save({ name: 'local-fs', type: 'stdio', command: 'node', args: ['fs-mcp.js'] });
  tools.save({ name: 'off-tool', type: 'http', url: 'https://off.example', enabled: false });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    tools,
    makeAdapter: () =>
      agent === 'claude'
        ? new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' })
        : new AcpAdapter({ label: 'Gemini', command: process.execPath, args: [join(here, 'fake-acp.mjs'), 'normal'] }),
  });
  sessions.subscribe((e) => events.push(e));
  return { base, sessions, events };
}

const pc = { via: 'local' as const, user: 'local' };

test('툴: Claude 세션에는 켠 툴만 MCP 설정 파일로 붙고, 계정 MCP 는 읽지 않게 한다', async () => {
  const { base, sessions, events } = setup('claude');
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'claude' }, pc);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  const cfg = JSON.parse(readFileSync(join(base, 'data', 'mcp', `${id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['docs', 'local-fs']); // 꺼진 툴은 없음
  assert.deepEqual(cfg.mcpServers['local-fs'], { type: 'stdio', command: 'node', args: ['fs-mcp.js'] });

  await sessions.handle({ type: 'user.message', sessionId: id, text: 'argv?' }, pc);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text.startsWith('argv:'));
  assert.match(reply.text, /--strict-mcp-config/);
  assert.match(reply.text, /--allowedTools mcp__docs,mcp__local-fs/);
  sessions.stopAll();
});

test('툴: 프리셋이 툴을 정해 두면 그 툴만, 빈 목록이면 툴 없이 뜬다', async () => {
  const base = tmp();
  mkdirSync(join(base, 'ws'), { recursive: true });
  const tools = new ToolStore(join(base, 'data', 'tools.json'));
  const docs = tools.save({ name: 'docs', type: 'http', url: 'https://example.com/mcp' });
  tools.save({ name: 'local-fs', type: 'stdio', command: 'node', args: ['fs-mcp.js'] });
  const presets = new PresetStore(join(base, 'data', 'presets.json'));
  presets.save({ name: '문서 담당', agent: 'claude', instructions: '문서만 본다', tools: [docs.id] });
  presets.save({ name: '맨손', agent: 'claude', instructions: '툴 없이', tools: [] });
  const events: HostEvent[] = [];
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    tools,
    presets,
    makeAdapter: () => new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' }),
  });
  sessions.subscribe((e) => events.push(e));
  const servers = async (name: string) => {
    await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', preset: name }, pc);
    const id = (await waitFor(events, (e) => e.type === 'session.created' && e.session.preset?.name === name)).session.id;
    return Object.keys(JSON.parse(readFileSync(join(base, 'data', 'mcp', `${id}.json`), 'utf8')).mcpServers);
  };
  assert.deepEqual(await servers('문서 담당'), ['docs']);
  assert.deepEqual(await servers('맨손'), []);
  sessions.stopAll();
});

test('툴: ACP 세션(Gemini·Codex)에는 session/new 의 mcpServers 로 붙는다', async () => {
  const { sessions, events } = setup('gemini');
  await sessions.handle({ type: 'session.create', role: 'direct', agent: 'gemini' }, pc);
  const id = (await waitFor(events, (e) => e.type === 'session.created')).session.id;
  await waitFor(events, (e) => e.type === 'session.status' && e.status === 'idle');
  await sessions.handle({ type: 'user.message', sessionId: id, text: 'mcp?' }, pc);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.text.startsWith('mcp:'));
  assert.equal(reply.text, 'mcp: docs(http),local-fs(stdio)');
  sessions.stopAll();
});
