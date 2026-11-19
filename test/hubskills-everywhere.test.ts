import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubSkillStore } from '../src/hubskills.ts';

test('모든 작업에 넣기: 켠 스킬만, 꺼 둔 스킬은 빼고, 플러그인 폴더로 묶임', () => {
  const base = mkdtempSync(join(tmpdir(), 'hub skills all '));
  const s = new HubSkillStore(join(base, 'skills'));
  s.save({ name: 'manual-writing', description: '매뉴얼 쓰기', body: '절차' });
  s.save({ name: 'quote-writing', description: '견적 쓰기', body: '절차' });
  assert.deepEqual(s.everywhere(), []);
  s.setEverywhere('manual-writing', true);
  s.setEverywhere('quote-writing', true);
  assert.deepEqual(s.everywhere(), ['manual-writing', 'quote-writing']);
  s.setEnabled('quote-writing', false); // 꺼 둔 스킬은 넣지 않음
  assert.deepEqual(s.everywhere(), ['manual-writing']);
  assert.equal(s.list().find((k) => k.name === 'manual-writing')?.everywhere, true);
  const dir = s.buildPlugin(join(base, 'plug'), s.everywhere())!;
  assert.ok(existsSync(join(dir, '.claude-plugin', 'plugin.json')));
  assert.ok(existsSync(join(dir, 'skills', 'manual-writing', 'SKILL.md')));
  s.setEverywhere('manual-writing', false);
  assert.deepEqual(s.everywhere(), []);
  assert.throws(() => s.setEverywhere('none', true), /없는 스킬/);
  void mkdirSync; void writeFileSync;
});
