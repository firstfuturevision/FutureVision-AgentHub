import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSkills } from '../src/claudeskills.ts';
import { HubSkillStore } from '../src/hubskills.ts';

const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n본문 ${name}\n`;

test('Claude Code 스킬 전체: 개인 · 계정 동기화 · 작업 폴더 · 플러그인을 보고, 개인 스킬 고치기 · 지우기, 켜기 · 끄기', () => {
  const home = mkdtempSync(join(tmpdir(), 'cs home '));
  const proj = mkdtempSync(join(tmpdir(), 'cs proj '));
  const put = (dir: string, name: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), md(name, `${name} 설명`)); };
  put(join(home, '.claude', 'skills'), 'mine');
  put(join(home, '.claude', 'skills', 'synced', 'acct'), 'cloud');
  put(join(proj, '.claude', 'skills'), 'proj-skill');
  const plug = join(home, '.claude', 'plugins', 'cache', 'x', 'figma', '1.0');
  put(join(plug, 'skills'), 'figma-use');
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'figma@x': [{ installPath: plug }] } }));
  const cs = new ClaudeSkills(home, () => [proj]);
  const by = (n: string) => cs.list().find((s) => s.name === n)!;
  assert.deepEqual([by('mine').where, by('mine').editable, by('mine').enabled], ['personal', true, true]);
  assert.equal(by('cloud').synced, true);
  assert.equal(by('cloud').editable, false);
  assert.equal(by('proj-skill').project, proj);
  assert.deepEqual([by('figma-use').where, by('figma-use').plugin, by('figma-use').enabled], ['plugin', 'figma@x', true]);
  // 읽기 · 저장 · 새로 만들기
  assert.match(cs.read({ name: 'mine' }).body, /본문 mine/);
  cs.save({ name: 'new-one', description: '새 스킬: "따옴표"', body: '내용' });
  assert.equal(cs.read({ name: 'new-one' }).description, '새 스킬: "따옴표"');
  assert.throws(() => cs.save({ name: 'Bad Name', description: 'x', body: 'y' }));
  // 끄기 · 켜기(개인 · 작업 폴더는 폴더를 옮김, 플러그인은 settings.json)
  cs.setEnabled({ name: 'mine', enabled: false });
  assert.ok(existsSync(join(home, '.claude', 'skills-disabled', 'mine', 'SKILL.md')));
  assert.equal(by('mine').enabled, false);
  cs.save({ name: 'mine', description: '꺼진 채 고침', body: '바뀐 본문' });
  assert.equal(by('mine').enabled, false, '꺼진 자리에서 고친다');
  cs.setEnabled({ name: 'mine', enabled: true });
  assert.equal(by('mine').enabled, true);
  cs.setEnabled({ where: 'project', name: 'proj-skill', project: proj, enabled: false });
  assert.equal(by('proj-skill').enabled, false);
  cs.setEnabled({ where: 'plugin', plugin: 'figma@x', enabled: false });
  assert.equal(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins['figma@x'], false);
  assert.equal(by('figma-use').enabled, false);
  assert.throws(() => cs.setEnabled({ name: 'cloud', enabled: false }), /계정 동기화/);
  // 지우기: 개인만
  cs.remove('new-one');
  assert.equal(cs.list().some((s) => s.name === 'new-one'), false);
  assert.throws(() => cs.remove('figma-use'));
});

test('Agent Hub 스킬 켜기 · 끄기: 꺼 두면 프리셋 세션에 넣지 않는다', () => {
  const d = mkdtempSync(join(tmpdir(), 'hs '));
  const st = new HubSkillStore(join(d, 'skills'));
  st.save({ name: 'quote', description: '견적', body: 'b' });
  st.save({ name: 'reply', description: '답장', body: 'b' });
  assert.deepEqual(st.pick(), ['quote', 'reply']);
  st.setEnabled('quote', false);
  assert.equal(st.list().find((s) => s.name === 'quote')!.enabled, false);
  assert.deepEqual(st.pick(), ['reply']);
  assert.deepEqual(st.pick(['quote', 'reply']), ['reply']);
  st.setEnabled('quote', true);
  assert.deepEqual(st.pick(), ['quote', 'reply']);
  assert.throws(() => st.setEnabled('nope', false));
});
