// 메인 에이전트 → clink(MCP) → 작업자 전 과정. 실제 HTTP 서버와 가짜 CLI 들로 돌린다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ToolStore } from '../src/tools.ts';
import { HubSkillStore } from '../src/hubskills.ts';
import { SharedRepo, sharedId } from '../src/shared.ts';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { SessionManager } from '../src/sessions.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { AcpAdapter } from '../src/adapters/acp.ts';
import { startLocalServer } from '../src/transports/local.ts';
import { PresetStore } from '../src/presets.ts';
import { WorkPresetStore } from '../src/workpresets.ts';
import type { HostEvent } from '../src/protocol.ts';
import { waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** 운영체제에게 빈 포트를 받아 온다(무작위 포트 충돌 방지) */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
}

const servers: Server[] = [];
const managers: SessionManager[] = [];
// 테스트가 중간에 실패해도 CLI 프로세스·서버가 남지 않게
after(() => {
  managers.forEach((m) => m.stopAll());
  servers.forEach((s) => s.close());
});

async function setup(clinkWaitMs = 5000, defaultWorker?: { agent: string; model?: string }) {
  const port = await freePort();
  const base = mkdtempSync(join(tmpdir(), 'agent hub main '));
  mkdirSync(join(base, 'ws'), { recursive: true });
  const events: HostEvent[] = [];
  const presets = new PresetStore(join(base, 'data', 'presets.json'));
  presets.save({ name: '리뷰어', agent: 'gemini', model: 'gemini-2.5-pro', description: '코드 검토', instructions: '고치지 말고 문제만 목록으로 보고한다.' });
  const sessions = new SessionManager({
    workspaceRoot: join(base, 'ws'),
    dataDir: join(base, 'data'),
    presets,
    mcpBaseUrl: `http://127.0.0.1:${port}/mcp`,
    clinkWaitMs,
    makeAdapter: (agent) =>
      agent === 'claude'
        ? new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' })
        : new AcpAdapter({ label: agent, command: process.execPath, args: [join(here, 'fake-acp.mjs'), 'normal'] }),
  });
  sessions.subscribe((e) => events.push(e));
  managers.push(sessions);
  servers.push(await startLocalServer({ port, uiDir: here, sessions, info: {} }));
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', defaultWorker: defaultWorker as any }, { via: 'dashboard', user: '김범무' });
  const main = (await waitFor(events, (e) => e.type === 'session.created')).session;
  return { port, sessions, events, main, presets, base };
}

test('호스트를 다시 켜면 기록에서 작업·대화를 되살리고(대기, CLI 는 다음 지시 때), 작업자 카드는 제자리 순서로, 지운 작업은 빼고', async () => {
  const { sessions, events, main, base } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@codex hello' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === main.id);
  await sessions.handle({ type: 'session.rename', sessionId: main.id, title: '인사 작업' }, phone);
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude' }, phone);
  const gone = created(events).filter((s) => s.role === 'main')[1];
  await sessions.handle({ type: 'session.delete', sessionId: gone.id }, phone);
  sessions.stopAll();
  await new Promise((r) => setTimeout(r, 300));

  const again = new SessionManager({ workspaceRoot: join(base, 'ws'), dataDir: join(base, 'data'), makeAdapter: () => { throw new Error('되살린 작업은 CLI 를 띄우지 않음'); } });
  assert.equal(again.restore(), 2); // 메인 + 작업자, 지운 것은 빠짐
  const m = again.info(main.id)!;
  assert.equal(m.status, 'idle');
  assert.equal(m.customTitle, '인사 작업');
  const replay: HostEvent[] = [];
  again.subscribe((e) => replay.push(e));
  const kinds = replay.map((e) => `${e.type}${'sessionId' in e && e.sessionId !== main.id ? '(작업자)' : ''}${e.type === 'session.created' && e.session.role === 'worker' ? '(작업자)' : ''}`);
  const workerCreated = kinds.indexOf('session.created(작업자)');
  const mainReply = replay.findIndex((e) => e.type === 'agent.text' && e.sessionId === main.id && e.text.includes('결과를 확인'));
  assert.ok(workerCreated > 0 && workerCreated < mainReply, `작업자 카드가 메인 답보다 먼저: ${kinds.join(', ')}`);
  assert.ok(!replay.some((e) => 'sessionId' in e && e.sessionId === gone.id));
});

const mainReply = (events: HostEvent[], mainId: string, part: string) =>
  waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === mainId && e.text.includes(part));

test('대화로 프리셋 만들기: 메인이 agent_save → 사람 승인 카드 → 허용하면 저장되고 화면에 알린다', async () => {
  const { sessions, events, main, presets } = await setup();
  const draft = { name: '문서 조사', agent: 'gemini', description: '자료를 찾을 때', instructions: '출처를 붙여 요약한다. 추측은 추측이라고 표시한다.' };
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: `@preset-save ${JSON.stringify(draft)}` }, phone);
  const req = await waitFor(events, (e) => e.type === 'permission.request' && e.sessionId === main.id);
  assert.equal(req.tool, '에이전트 만들기 · 문서 조사 (gemini)');
  assert.match(req.detail, /자료를 찾을 때 — 출처를 붙여/);
  assert.equal(presets.find('문서 조사'), undefined); // 승인 전엔 저장 안 됨

  await sessions.handle({ type: 'permission.respond', sessionId: main.id, requestId: req.requestId, allow: true }, phone);
  const reply = await mainReply(events, main.id, '프리셋 결과');
  assert.match(reply.text, /저장함: "문서 조사"/);
  assert.equal(presets.find('문서 조사')?.agent, 'gemini');
  assert.ok(events.some((e) => e.type === 'presets.changed'));
  sessions.stopAll();
});

test('대화로 프리셋(작업 환경) 만들고 공유 레포에 올리기: 둘 다 사람 승인 후', async () => {
  const { sessions, events, main, presets, base } = await setup();
  const wp = new WorkPresetStore(join(base, 'data', 'wp-main.json'));
  (sessions as any).workPresets = wp;
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const shared = new SharedRepo({ file: join(base, 'data', 'shared.json'), dir: join(base, 'data', 'shared', 'repo'), presets, workPresets: wp, tools: new ToolStore(join(base, 'data', 'tools.json')), skills: new HubSkillStore(join(base, 'data', 'skills')), remoteUrl: () => remote, onChange: () => sessions.presetsChanged() });
  sessions.attachShared(shared);
  const approve = async (startsWith: string) => {
    const req = await waitFor(events, (e) => e.type === 'permission.request' && e.sessionId === main.id && e.tool.startsWith(startsWith) && !events.some((x) => x.type === 'permission.resolved' && x.requestId === e.requestId));
    await sessions.handle({ type: 'permission.respond', sessionId: main.id, requestId: req.requestId, allow: true }, phone);
    return req;
  };

  // 프리셋 만들기 — 에이전트는 이름으로
  const draft = { name: '견적 작업', folder: '견적', guidelines: '결과는 결과 폴더에', mainAgent: '리뷰어', agents: ['리뷰어'] };
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: `@tool preset_save ${JSON.stringify(draft)}` }, phone);
  const req = await approve('프리셋 만들기 · 견적 작업');
  assert.match(req.detail, /폴더 견적 — 결과는 결과 폴더에/);
  await mainReply(events, main.id, '저장함: 프리셋 "견적 작업"');
  const reviewer = presets.find('리뷰어')!;
  assert.equal(wp.find('견적 작업')?.mainAgent, reviewer.id);

  // 목록은 에이전트를 이름으로
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@tool preset_list' }, phone);
  assert.match((await mainReply(events, main.id, '"name": "견적 작업"')).text, /"mainAgent": "리뷰어"/);

  // 공유 레포가 없으면 이유를 돌려준다(묻지 않음)
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@tool share_push {"kind":"presets","name":"견적 작업"}' }, phone);
  await mainReply(events, main.id, '올리지 않음: 연동에서 공유 레포를 먼저');

  // 정하면 승인 후 올라가고, 이 PC 것은 공유본으로
  await shared.set({ repo: 'fv/shared' });
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@tool share_push {"kind":"presets","name":"견적 작업"}' }, phone);
  await approve('공유 레포에 올리기 · 프리셋 견적 작업');
  await mainReply(events, main.id, 'fv/shared 에 프리셋 "견적 작업" 을 올림');
  const p = wp.find('견적 작업')!;
  assert.equal(p.id, sharedId('presets', '견적 작업'));
  assert.equal(p.shared, true);
  assert.match(execFileSync('git', ['--git-dir', remote, 'log', '--format=%s'], { encoding: 'utf8' }), /프리셋 공유: 견적 작업/);

  // 이미 공유된 것·공유본 지우기는 거절
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@tool share_push {"kind":"presets","name":"견적 작업"}' }, phone);
  await mainReply(events, main.id, '올리지 않음: 이미 공유된 프리셋');
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@tool preset_delete {"preset":"견적 작업"}' }, phone);
  await mainReply(events, main.id, '지우지 않음: 공유받은 프리셋은');
  sessions.stopAll();
});

test('대화로 프리셋: 거부하면 저장 안 되고, 형식이 틀리면 묻지도 않는다, 지우기도 승인 후', async () => {
  const { sessions, events, main, presets } = await setup();
  // 거부
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: `@preset-save ${JSON.stringify({ name: '테스터', agent: 'codex', instructions: '테스트를 쓴다' })}` }, phone);
  const req = await waitFor(events, (e) => e.type === 'permission.request' && e.sessionId === main.id);
  await sessions.handle({ type: 'permission.respond', sessionId: main.id, requestId: req.requestId, allow: false }, phone);
  assert.match((await mainReply(events, main.id, '프리셋 결과')).text, /저장 안 됨: 사람이 거부함/);
  assert.equal(presets.find('테스터'), undefined);

  // 역할 지침 없음 → 승인 카드 없이 바로 이유
  const before = events.filter((e) => e.type === 'permission.request').length;
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: `@preset-save ${JSON.stringify({ name: '빈것', agent: 'codex', instructions: '' })}` }, phone);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('역할 지침'));
  assert.equal(events.filter((e) => e.type === 'permission.request').length, before);

  // 지우기
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@preset-delete 리뷰어' }, phone);
  const del = await waitFor(events, (e) => e.type === 'permission.request' && e.sessionId === main.id && e.tool.startsWith('에이전트 지우기'));
  await sessions.handle({ type: 'permission.respond', sessionId: main.id, requestId: del.requestId, allow: true }, phone);
  await mainReply(events, main.id, '지움: "리뷰어"');
  assert.equal(presets.find('리뷰어'), undefined);
  sessions.stopAll();
});

test('프리셋으로 맡기면 AI·모델·역할 지침을 프리셋에서 가져오고, 화면엔 맡긴 일만 보인다', async () => {
  const { sessions, events, main } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@role:리뷰어 check login.ts' }, phone);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('결과를 확인'));
  const worker = created(events).find((s) => s.role === 'worker');
  assert.equal(worker.agent, 'gemini');
  assert.equal(worker.model, 'gemini-2.5-pro');
  assert.equal(worker.preset.name, '리뷰어');
  // 화면·기록의 "맡긴 일"은 원래 지시만
  assert.ok(events.some((e) => e.type === 'user.message' && e.sessionId === worker.id && e.text === 'check login.ts'));
  // 가짜 작업자는 받은 글을 그대로 되돌려 주므로, 역할 지침이 실제로 전달됐는지 보인다
  assert.match(reply.text, /\[역할: 리뷰어\]/);
  assert.match(reply.text, /고치지 말고 문제만/);
  sessions.stopAll();
});

test('프리셋을 메인으로 고르면 그 AI·모델로 띄우고 첫 지시에 역할 지침을 붙인다', async () => {
  const { sessions, events } = await setup();
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', preset: '리뷰어' }, phone);
  const m = (await waitFor(events, (e) => e.type === 'session.created' && e.session.preset?.name === '리뷰어')).session;
  assert.equal(m.agent, 'gemini'); // 프리셋의 AI
  assert.equal(m.model, 'gemini-2.5-pro');
  await sessions.handle({ type: 'user.message', sessionId: m.id, text: '이번 주 변경 검토' }, phone);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === m.id);
  assert.match(reply.text, /\[역할: 리뷰어\]/);
  assert.match(reply.text, /\[맡긴 일\]\n이번 주 변경 검토/);
  sessions.stopAll();
});

test('메인 프리셋이 하위 에이전트를 정해 두면 그 프리셋에게만 맡기고, 도구 목록에도 그것만 보인다', async () => {
  const { port, sessions, events, presets } = await setup();
  const reviewer = presets.find('리뷰어')!;
  presets.save({ name: '조사', agent: 'gemini', description: '자료 조사', instructions: '출처를 붙인다' });
  presets.save({ name: '팀장', agent: 'claude', description: '나눠 맡김', instructions: '직접 하지 말고 맡긴다', agents: [reviewer.id] });
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', preset: '팀장' }, phone);
  const lead = (await waitFor(events, (e) => e.type === 'session.created' && e.session.preset?.name === '팀장')).session;

  // 첫 지시에는 역할 지침이 붙으므로(가짜 메인은 @명령을 못 읽음) 인사 한 번 하고 시작
  await sessions.handle({ type: 'user.message', sessionId: lead.id, text: 'hi' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === lead.id);
  // 허용된 리뷰어에게는 맡겨진다
  await sessions.handle({ type: 'user.message', sessionId: lead.id, text: '@role:리뷰어 check' }, phone);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === lead.id && e.text.includes('결과를 확인'));
  assert.ok(created(events).some((s) => s.role === 'worker' && s.parentId === lead.id && s.preset?.name === '리뷰어'));
  // 허용 안 된 프리셋, AI 직접 지정은 막힌다
  await assert.rejects(sessions.clink(lead.id, { prompt: 'x', preset: '조사' }), /"조사" 에게 맡길 수 없음 \(허용: 리뷰어\)/);
  await assert.rejects(sessions.clink(lead.id, { prompt: 'x', cli_name: 'codex' }), /정해진 하위 에이전트에게만/);

  // 메인에게 보이는 clink 의 preset 목록도 허용된 것만
  const token = (sessions as any).sessions.get(lead.id).token;
  const list = await (await fetch(`http://127.0.0.1:${port}/mcp/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
  assert.deepEqual(list.result.tools[0].inputSchema.properties.preset.enum, ['리뷰어']);
  sessions.stopAll();
});

test('프리셋(작업 환경): 폴더를 만들어 쓰고, 지침은 메인과 하위 에이전트의 첫 지시에 붙는다', async () => {
  const { sessions, events, base } = await setup();
  const wp = new WorkPresetStore(join(base, 'data', 'wp.json'));
  (sessions as any).workPresets = wp;
  wp.save({ name: '견적 작업', folder: '견적', extraDirs: ['단가표'], guidelines: '결과는 견적/결과 폴더에 저장한다.' });
  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workPreset: '견적 작업' }, phone);
  const m = (await waitFor(events, (e) => e.type === 'session.created' && e.session.workPreset)).session;
  assert.equal(m.workdir, join(base, 'ws', '견적'));
  assert.deepEqual(m.extraDirs, [join(base, 'ws', '단가표')]);
  // 메인 첫 지시: 가짜 메인은 앞에 지침이 붙으면 그대로 따라 말한다
  await sessions.handle({ type: 'user.message', sessionId: m.id, text: '시작' }, phone);
  const first = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === m.id);
  assert.match(first.text, /\[작업 환경: 견적 작업\]\n결과는 견적\/결과 폴더에 저장한다\./);
  // 하위 에이전트에게도 같은 지침
  await sessions.handle({ type: 'user.message', sessionId: m.id, text: '@codex 정리해' }, phone);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === m.id && e.text.includes('결과를 확인'));
  assert.match(reply.text, /\[작업 환경: 견적 작업\]/);
  const w = created(events).find((s) => s.role === 'worker' && s.parentId === m.id);
  assert.equal(w.workPreset.name, '견적 작업');
  sessions.stopAll();
});

test('프리셋이 메인·하위 에이전트를 정하면: 메인은 기본으로 그 에이전트, 하위는 프리셋과 에이전트가 둘 다 허용한 것만', async () => {
  const { sessions, events, base, presets } = await setup();
  const wp = new WorkPresetStore(join(base, 'data', 'wp2.json'));
  (sessions as any).workPresets = wp;
  const reviewer = presets.find('리뷰어')!;
  const research = presets.save({ name: '조사', agent: 'gemini', instructions: '출처' });
  const lead = presets.save({ name: '팀장', agent: 'claude', instructions: '맡긴다' }); // 에이전트 자체 제한 없음
  wp.save({ name: '검토 작업', mainAgent: lead.id, agents: [reviewer.id] });

  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workPreset: '검토 작업' }, phone);
  const m = (await waitFor(events, (e) => e.type === 'session.created' && e.session.workPreset?.name === '검토 작업')).session;
  assert.equal(m.preset?.name, '팀장'); // 에이전트를 안 골랐으니 프리셋의 메인
  await assert.rejects(sessions.clink(m.id, { prompt: 'x', preset: research.id }), /"조사" 에게 맡길 수 없음 \(허용: 리뷰어\)/);
  assert.deepEqual(sessions.presetsForMain(m.id).map((p) => p.name), ['리뷰어']);

  // 에이전트도 제한하면 교집합
  presets.save({ ...lead, agents: [research.id] });
  assert.deepEqual(sessions.presetsForMain(m.id).map((p) => p.name), []);
  sessions.stopAll();
});

test('프리셋이 골라 둔 하위 에이전트가 모두 지워지면 제한이 풀리고, 처음부터 없음으로 정했으면 이유를 알려 준다', async () => {
  const { sessions, events, base, presets } = await setup();
  const wp = new WorkPresetStore(join(base, 'data', 'wp3.json'));
  (sessions as any).workPresets = wp;
  const gone = presets.save({ name: '지울 것', agent: 'gemini', instructions: 'x' });
  wp.save({ name: '관리', agents: [gone.id] });
  wp.save({ name: '혼자', agents: [] });
  presets.remove(gone.id);

  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workPreset: '관리' }, phone);
  const m = (await waitFor(events, (e) => e.type === 'session.created' && e.session.workPreset?.name === '관리')).session;
  assert.equal(sessions.presetsForMain(m.id).length, presets.list().length); // 전부
  const r = await sessions.clink(m.id, { prompt: '정리해', cli_name: 'claude' });
  assert.equal(r.status, 'done');

  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude', workPreset: '혼자' }, phone);
  const solo = (await waitFor(events, (e) => e.type === 'session.created' && e.session.workPreset?.name === '혼자')).session;
  await assert.rejects(sessions.clink(solo.id, { prompt: 'x', cli_name: 'codex' }), /하위 에이전트를 쓰지 않게 정해져 있음/);
  sessions.stopAll();
});

test('없는 프리셋이면 메인에게 있는 프리셋 목록과 함께 알려 준다', async () => {
  const { sessions, events, main } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@role:디자이너 make a logo' }, phone);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('결과를 확인'));
  assert.match(reply.text, /없는 프리셋: 디자이너 \(있는 프리셋: 리뷰어\)/);
  assert.equal(created(events).filter((s) => s.role === 'worker').length, 0);
  sessions.stopAll();
});

test('화면에서 고른 기본 작업자(AI·모델)로 맡기고, CLI 가 알려 준 모델 목록이 화면으로 간다', async () => {
  const { sessions, events, main } = await setup(5000, { agent: 'codex', model: 'gpt-x-test' });
  assert.deepEqual(main.defaultWorker, { agent: 'codex', model: 'gpt-x-test' });
  // 메인이 AI 를 정하지 않으면 기본 작업자
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@default hello' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === main.id);
  const worker = created(events).find((s) => s.role === 'worker');
  assert.equal(worker.agent, 'codex');
  assert.equal(worker.model, 'gpt-x-test');
  // 메인이 다른 AI 를 정하면 그 AI 의 기본 모델(기본 작업자의 모델을 섞지 않는다)
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@gemini hi' }, phone);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('turn 1: hi'));
  const g = created(events).find((s) => s.role === 'worker' && s.agent === 'gemini');
  assert.equal(g.model, undefined);
  const models = await waitFor(events, (e) => e.type === 'agent.models' && e.sessionId === worker.id);
  assert.equal(models.agent, 'codex');
  assert.deepEqual(models.models.map((m: any) => m.id), ['fake-pro', 'fake-mini']);
  assert.equal(models.current, 'fake-pro');
  sessions.stopAll();
});

const created = (events: HostEvent[]) => events.filter((e) => e.type === 'session.created').map((e: any) => e.session);
const phone = { via: 'dashboard' as const, user: '김범무' };

test('메인이 "@codex …" 를 받으면 clink 로 Codex 작업자를 띄우고 그 결과를 보고한다', async () => {
  const { sessions, events, main } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@codex fix the bug' }, phone);

  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('결과를 확인'));
  assert.match(reply.text, /turn 1: fix the bug/);

  const worker = created(events).find((s) => s.role === 'worker');
  assert.equal(worker.agent, 'codex');
  assert.equal(worker.parentId, main.id);
  assert.equal(worker.requestedBy, '김범무'); // 기록상 요청자는 메인을 부린 사람
  assert.ok(events.some((e) => e.type === 'user.message' && e.sessionId === worker.id && e.from === '메인 · claude' && e.text === 'fix the bug'));
  // 메인 쪽에는 clink 도구 호출과 결과가 남는다
  assert.ok(events.some((e) => e.type === 'agent.tool' && e.sessionId === main.id && e.name === 'mcp__hub__clink'));
  sessions.stopAll();
});

test('모델 지정과 continuation_id 이어서 지시', async () => {
  const { sessions, events, main } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@gemini:gemini-3-pro first' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === main.id);
  const worker = created(events).find((s) => s.role === 'worker');
  assert.equal(worker.model, 'gemini-3-pro');
  // 가짜 Gemini 는 set_model 을 몰라서 → 알림 후 기본 모델로 진행
  assert.ok(events.some((e) => e.type === 'error' && e.sessionId === worker.id && e.message.includes('모델 지정 실패')));

  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@again second' }, phone);
  await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('turn 2: second'));
  assert.equal(created(events).filter((s) => s.role === 'worker').length, 1); // 새 작업자 없이 같은 작업자
  sessions.stopAll();
});

test('작업자 승인 대기 중에는 clink 가 working 으로 돌아오고, 사람이 허용하면 이어서 결과를 받는다', async () => {
  const { sessions, events, main } = await setup(300); // 0.3초마다 working 으로 돌려준다
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@codex please write' }, phone);
  const req = await waitFor(events, (e) => e.type === 'permission.request');
  await new Promise((r) => setTimeout(r, 800)); // 메인이 몇 번 working 을 받고 다시 기다리는 동안
  assert.ok(!events.some((e) => e.type === 'turn.done' && e.sessionId === main.id));

  await sessions.handle({ type: 'permission.respond', sessionId: req.sessionId, requestId: req.requestId, allow: true }, phone);
  const reply = await waitFor(events, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('결과를 확인'));
  assert.match(reply.text, /turn 1: please write/);
  assert.ok(events.some((e) => e.type === 'agent.tool_result' && e.sessionId === req.sessionId && e.summary === 'wrote a.txt'));
  sessions.stopAll();
});

test('메인을 멈추면 일하던 작업자도 멈추고(session/cancel), 둘 다 대기로 남아 다음 지시를 받는다', async () => {
  const { sessions, events, main } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@codex slow job' }, phone);
  const w = await waitFor(events, (e) => e.type === 'session.created' && e.session.role === 'worker');
  await waitFor(events, () => sessions.info(w.session.id)?.status === 'working');

  await sessions.handle({ type: 'session.stop', sessionId: main.id }, phone);
  await waitFor(events, (e) => e.type === 'session.halted' && e.sessionId === w.session.id);
  await waitFor(events, (e) => e.type === 'session.halted' && e.sessionId === main.id);
  await waitFor(events, () => sessions.info(main.id)?.status === 'idle' && sessions.info(w.session.id)?.status === 'idle');
  assert.ok(!events.some((e) => e.type === 'session.ended'));

  // 같은 메인·같은 작업자가 이어서 받는다
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@again 다시 해' }, phone);
  await mainReply(events, main.id, 'again 에게 맡긴 결과');
  assert.equal(created(events).filter((s) => s.role === 'worker').length, 1);
  sessions.stopAll();
});

test('호스트를 다시 켠 뒤: 쉬던 메인은 다음 지시 때 다시 떠서 앞 대화를 이어받고, 앞서 맡긴 작업자도 다시 띄워 이어 간다', async () => {
  const { sessions, events, main, base, presets } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@codex 첫 일' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === main.id);
  sessions.stopAll();
  await new Promise((r) => setTimeout(r, 300));

  const port = await freePort();
  const again = new SessionManager({
    workspaceRoot: join(base, 'ws'), dataDir: join(base, 'data'), presets, mcpBaseUrl: `http://127.0.0.1:${port}/mcp`, clinkWaitMs: 5000,
    makeAdapter: (agent) => agent === 'claude'
      ? new ClaudeAdapter({ command: process.execPath, extraArgs: [join(here, 'fake-claude.mjs')], permissionMode: 'default' })
      : new AcpAdapter({ label: agent, command: process.execPath, args: [join(here, 'fake-acp.mjs'), 'normal'] }),
  });
  managers.push(again);
  servers.push(await startLocalServer({ port, uiDir: here, sessions: again, info: {} }));
  again.restore();
  const ev2: HostEvent[] = [];
  again.subscribe((e) => ev2.push(e));
  const worker = created(events).find((s) => s.role === 'worker');
  assert.equal(again.info(worker.id)?.status, 'idle');

  // 메인: 다시 떠서 앞 대화를 받는다. 앞서 맡긴 작업자(continuation_id)도 다시 띄워 앞 대화를 붙여 보낸다
  const r = await again.clink(main.id, { prompt: 'x', continuation_id: worker.id }).catch((e) => e.message);
  assert.match(String(r), /쉬는 중/); // 메인 CLI 가 아직 없으면 MCP 로 부를 수 없다
  await again.handle({ type: 'user.message', sessionId: main.id, text: '이어서' }, phone);
  const reply = await waitFor(ev2, (e) => e.type === 'agent.text' && !e.partial && e.sessionId === main.id && e.text.includes('이어서'));
  assert.match(reply.text, /사람\(김범무\): @codex 첫 일/);
  const res = await again.clink(main.id, { prompt: '두 번째 일', continuation_id: worker.id });
  assert.equal(res.status, 'done');
  assert.match(res.content, /turn 1: \[이전 대화/); // 새 CLI, 앞 대화를 붙여 받음
  assert.match(res.content, /두 번째 일/);
  again.stopAll();
});

test('작업자는 다시 맡길 수 없고(깊이 1), 다른 메인의 작업도 건드릴 수 없다', async () => {
  const { sessions, events, main } = await setup();
  await sessions.handle({ type: 'user.message', sessionId: main.id, text: '@codex hello' }, phone);
  await waitFor(events, (e) => e.type === 'turn.done' && e.sessionId === main.id);
  const worker = created(events).find((s) => s.role === 'worker');
  await assert.rejects(sessions.clink(worker.id, { prompt: 'x', cli_name: 'gemini' }), /메인 세션이 없거나/);

  await sessions.handle({ type: 'session.create', role: 'main', agent: 'claude' }, phone);
  const other = created(events).filter((s) => s.role === 'main')[1];
  await assert.rejects(sessions.clink(other.id, { prompt: 'x', continuation_id: worker.id }), /이 메인이 맡긴 작업이 아님/);
  sessions.stopAll();
});

test('MCP: initialize 는 지침을, tools/list 는 clink 와 프리셋 도구를 돌려준다', async () => {
  const { port, sessions, events, main } = await setup();
  // 메인에게 준 주소를 MCP 설정 파일에서 읽는 대신, 같은 주소를 직접 부른다
  const url = (sessions as any).sessions.get(main.id).token;
  const call = async (method: string) =>
    (await fetch(`http://127.0.0.1:${port}/mcp/${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { protocolVersion: '2025-06-18' } }),
    })).json();
  const init = await call('initialize');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /메인 에이전트/);
  const list = await call('tools/list');
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['clink', 'agent_list', 'agent_save', 'agent_delete', 'preset_list', 'preset_save', 'preset_delete', 'share_push']);
  assert.deepEqual(list.result.tools[0].inputSchema.properties.preset.enum, ['리뷰어']); // 프리셋이 도구에 실린다
  assert.match(init.result.instructions, /맡길 수 있는 하위 에이전트: 리뷰어/);
  assert.ok(events.length > 0);
  sessions.stopAll();
});
