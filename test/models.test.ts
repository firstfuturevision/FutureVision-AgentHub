import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCli, olderThan, parseVersion, toOptions } from '../src/models.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-claude.mjs');

test('버전 비교·읽기, CLI 모델 → 목록("default" 는 뺀다)', () => {
  assert.equal(parseVersion('2.1.283 (Claude Code)'), '2.1.283');
  assert.equal(parseVersion('없음'), null);
  assert.ok(olderThan('2.1.283', '2.1.322'));
  assert.ok(olderThan('2.1.9', '2.1.10')); // 글자 비교가 아니라 숫자 비교
  assert.ok(!olderThan('2.2.0', '2.1.999'));
  assert.ok(!olderThan('2.1.322', '2.1.322'));
  assert.deepEqual(toOptions([{ value: 'default', displayName: 'Default' }, { value: 'opus', displayName: 'Opus 5.5' }, { value: 'x' }, { nope: 1 }]), [
    { id: 'opus', name: 'Opus 5.5' },
    { id: 'x', name: 'x' },
  ]);
  assert.deepEqual(toOptions(null), []);
});

test('Claude CLI 에게 모델·버전을 묻고, 새 버전이 있으면 outdated, 다음에 켤 때 저장한 것을 쓴다', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agent hub models ')), 'claude-models.json');
  const got: string[][] = [];
  const cli = new ClaudeCli({ command: process.execPath, prefix: [fake], file, latest: async () => '2.1.322' });
  cli.onModels = (m) => got.push(m.map((x) => x.id));
  assert.deepEqual(cli.models, []);
  await cli.refresh();
  const st = cli.public();
  assert.deepEqual(st.models, [{ id: 'opus', name: 'Opus 5.5' }, { id: 'claude-fable-5-2', name: 'Fable 5.2' }]);
  assert.equal(st.version, '2.1.283');
  assert.equal(st.latest, '2.1.322');
  assert.equal(st.outdated, true);
  assert.equal(st.error, null);
  assert.deepEqual(got, [['opus', 'claude-fable-5-2']]);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).models.length === 2);
  // 다시 켜면(새로 만들면) 묻기 전에도 저장한 목록
  const again = new ClaudeCli({ command: process.execPath, prefix: [fake], file, latest: async () => '2.1.283' });
  assert.equal(again.models.length, 2);
  await again.refresh();
  assert.equal(again.public().outdated, false); // 최신이면 업데이트 버튼 없음
});

test('CLI 가 없으면 목록은 그대로 두고 까닭만', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agent hub models ')), 'm.json');
  const cli = new ClaudeCli({ command: join(here, '없는-claude'), file, latest: async () => null });
  await cli.refresh();
  assert.deepEqual(cli.models, []);
  assert.ok(cli.public().error);
});
