import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore, withRole } from '../src/presets.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'agent hub presets ')), 'presets.json');
const reviewer = { name: '코드 리뷰어', agent: 'codex', model: 'gpt-5.5', description: '바뀐 코드를 검토할 때', instructions: '버그와 빠진 예외 처리를 찾고, 고치지는 말고 목록으로 보고한다.' };

test('프리셋: 만들고, 이름으로 찾고, 고치고, 지우고, 파일에 남는다', () => {
  const file = tmp();
  const store = new PresetStore(file);
  const p = store.save(reviewer);
  assert.equal(p.id.length, 8);
  assert.equal(store.find(' 코드 리뷰어 ')?.id, p.id); // 이름은 앞뒤 공백·대소문자 무시
  assert.equal(store.find(p.id)?.name, '코드 리뷰어');

  store.save({ ...reviewer, id: p.id, model: '' }); // 모델 비우면 기본 모델
  assert.equal(store.find(p.id)?.model, undefined);
  assert.equal(store.list().length, 1);

  const again = new PresetStore(file); // 다시 읽어도 같다
  assert.equal(again.list()[0].instructions, reviewer.instructions);

  again.remove(p.id);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
});

test('프리셋: 잘못된 값은 이유와 함께 거부', () => {
  const store = new PresetStore(tmp());
  assert.throws(() => store.save({ ...reviewer, name: '' }), /이름은/);
  assert.throws(() => store.save({ ...reviewer, agent: 'gpt' }), /AI 는/);
  assert.throws(() => store.save({ ...reviewer, model: 'x & del' }), /모델 이름/);
  assert.throws(() => store.save({ ...reviewer, instructions: ' ' }), /역할 지침/);
  store.save(reviewer);
  assert.throws(() => store.save({ ...reviewer }), /같은 이름/);
});

test('프리셋: 깨진 파일이면 비운 채 시작하고, 역할 지침은 맡긴 일 앞에 붙는다', () => {
  const file = tmp();
  writeFileSync(file, '{ 깨짐');
  assert.deepEqual(new PresetStore(file).list(), []);
  const text = withRole({ id: 'a', name: '리뷰어', agent: 'codex', description: '', instructions: '검토만 한다' }, '로그인 코드 봐줘');
  assert.equal(text, '[역할: 리뷰어]\n검토만 한다\n\n[맡긴 일]\n로그인 코드 봐줘');
});
