import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore } from '../src/presets.ts';
import { WorkPresetStore } from '../src/workpresets.ts';
import { ToolStore } from '../src/tools.ts';
import { HubSkillStore } from '../src/hubskills.ts';
import { SharedRepo, sharedId, findSecret } from '../src/shared.ts';

// 회사 레포 대신 로컬 bare 레포, PC 두 대(A·B)는 각자 data 폴더
function world() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub shared '));
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const pc = (name: string) => {
    const d = join(base, name);
    const presets = new PresetStore(join(d, 'presets.json'));
    const workPresets = new WorkPresetStore(join(d, 'work-presets.json'));
    const tools = new ToolStore(join(d, 'tools.json'));
    const skills = new HubSkillStore(join(d, 'skills'));
    let changed = 0;
    const make = () => new SharedRepo({ file: join(d, 'shared.json'), dir: join(d, 'shared', 'repo'), presets, workPresets, tools, skills, author: async () => `pc-${name}`, remoteUrl: () => remote, onChange: () => changed++ });
    return { d, presets, workPresets, tools, skills, shared: make(), make, changes: () => changed };
  };
  return { base, remote, pc };
}

test('공유: A 가 올린 툴·스킬·에이전트·프리셋을 B 가 받고, 서로는 이름으로 이어진다', async () => {
  const { remote, pc } = world();
  const A = pc('a');
  const tool = A.tools.save({ name: 'docs', type: 'http', url: 'https://docs.example.com/mcp', description: '사내 문서', enabled: true });
  A.skills.save({ name: 'quote-writing', description: '견적서 쓰는 법', body: '표로 쓴다' });
  const reviewer = A.presets.save({ name: '리뷰어', agent: 'codex', instructions: '검토한다', tools: [tool.id], skills: ['quote-writing'], autoApprove: true });
  const wp = A.workPresets.save({ name: '견적 작업', folder: '견적', guidelines: '결과는 결과 폴더', mainAgent: reviewer.id, agents: [reviewer.id] });

  await A.shared.set({ repo: 'firstfuturevision/agent-hub-shared' }); // 빈 레포도 받아진다
  await A.shared.push('tools', tool.id);
  await A.shared.push('skills', 'quote-writing');
  await A.shared.push('agents', reviewer.id);
  await A.shared.push('presets', wp.id);

  // A: 이 PC 것은 공유본으로 바뀌고, 가리키던 곳도 따라간다
  const sTool = sharedId('tools', 'docs');
  const sAgent = sharedId('agents', '리뷰어');
  assert.deepEqual(A.tools.list().map((t) => [t.id, t.shared]), [[sTool, true]]);
  assert.deepEqual(A.presets.list().map((p) => [p.id, p.shared, p.tools, p.autoApprove]), [[sAgent, true, [sTool], undefined]]); // 권한 묻지 않기는 올리지 않는다
  assert.deepEqual(A.workPresets.list().map((p) => [p.shared, p.mainAgent, p.agents]), [[true, sAgent, [sAgent]]]);
  assert.equal(A.skills.list()[0].shared, true);
  assert.ok(!existsSync(join(A.d, 'skills', 'quote-writing')));
  const log = execFileSync('git', ['--git-dir', remote, 'log', '--format=%an %s'], { encoding: 'utf8' });
  assert.match(log, /pc-a 프리셋 공유: 견적 작업/);
  // 레포에는 id 가 아니라 이름
  const onDisk = JSON.parse(readFileSync(join(A.d, 'shared', 'repo', 'agents', '리뷰어.json'), 'utf8'));
  assert.deepEqual(onDisk.tools, ['docs']);

  // B: 같은 이름의 내 것은 "(내 것)" 으로 남고, 공유본이 이긴다
  const B = pc('b');
  B.presets.save({ name: '리뷰어', agent: 'claude', instructions: '내 방식' });
  await B.shared.set({ repo: 'firstfuturevision/agent-hub-shared' });
  assert.deepEqual(B.presets.list().map((p) => p.name).sort(), ['리뷰어', '리뷰어 (내 것)']);
  const got = B.presets.find('리뷰어')!;
  assert.equal(got.id, sAgent);
  assert.equal(got.shared, true);
  assert.deepEqual(got.tools, [sTool]);
  assert.equal(B.workPresets.find('견적 작업')?.mainAgent, sAgent);
  assert.deepEqual(B.skills.pick(['quote-writing']), ['quote-writing']);
  assert.ok(B.changes() > 0);

  // 공유본은 고치거나 지울 수 없다
  assert.throws(() => B.presets.save({ ...got, instructions: '바꿈' }), /공유받은 것은/);
  assert.throws(() => B.tools.remove(sTool), /공유받은 것은/);
  assert.throws(() => B.skills.save({ name: 'quote-writing', description: 'x', body: 'y' }), /공유받은 것은/);

  // 종류를 끄면 뗀다
  await B.shared.set({ kinds: { agents: false } });
  assert.deepEqual(B.presets.list().map((p) => p.name), ['리뷰어 (내 것)']);
  assert.equal(B.shared.public().counts.agents, 0);

  // 다시 켜도(새로 띄워도) 받아 둔 것으로 바로 끼운다
  await B.shared.set({ kinds: { agents: true } });
  const again = B.make();
  assert.ok(again.public().counts.agents === 1);
});

test('공유: 키·토큰이 든 것은 올리지 않고, 내리면 이 PC 에 내 것으로 남는다', async () => {
  const { pc } = world();
  const A = pc('a');
  await A.shared.set({ repo: 'fv/shared' });
  const bad = A.tools.save({ name: 'leaky', type: 'http', url: 'https://x.example.com/mcp?token=abcd1234efgh5678', description: '', enabled: true });
  await assert.rejects(A.shared.push('tools', bad.id), /주소에 든 키·토큰/);
  assert.ok(!A.tools.list().find((t) => t.id === bad.id)?.shared); // 그대로 이 PC 것
  const argTool = A.tools.save({ name: 'cli', type: 'stdio', command: 'npx', args: ['some-mcp', '--api-key', 'zzzzzzzzzzzzzzzz'], description: '', enabled: true });
  await assert.rejects(A.shared.push('tools', argTool.id), /명령 인자에 든 키·토큰/);

  const ok = A.tools.save({ name: 'docs', type: 'http', url: 'https://docs.example.com/mcp', description: '', enabled: true });
  const user = A.presets.save({ name: '정리', agent: 'claude', instructions: '정리', tools: [ok.id] });
  await A.shared.push('tools', ok.id);
  const sTool = sharedId('tools', 'docs');
  assert.deepEqual(A.presets.find(user.id)?.tools, [sTool]);

  await A.shared.unshare('tools', sTool);
  const mine = A.tools.list().find((t) => t.name === 'docs')!;
  assert.ok(mine && !mine.shared);
  assert.deepEqual(A.presets.find(user.id)?.tools, [mine.id]); // 가리키던 곳도 새 id 로

  const B = pc('b');
  await B.shared.set({ repo: 'fv/shared' });
  assert.equal(B.tools.list().length, 0);
});

test('공유: 레포 이름 형식과 비밀값 검사', async () => {
  const { pc } = world();
  const A = pc('a');
  await assert.rejects(A.shared.set({ repo: 'not a repo' }), /조직\/이름/);
  await assert.rejects(A.shared.push('agents', 'x'), /공유 레포를 먼저/);
  assert.equal(findSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), 'Bearer 토큰');
  assert.equal(findSecret('"sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa"'), 'API 키');
  assert.equal(findSecret('비밀번호는 각자 넣는다. password 칸은 비워 둔다'), null);
  assert.equal(findSecret('https://docs.example.com/mcp?lang=ko'), null);
});
