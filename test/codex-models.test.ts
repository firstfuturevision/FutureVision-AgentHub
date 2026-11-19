import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEffortModels, withEffort, baseOf } from '../src/adapters/acp.ts';

const list = [
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ id: `gpt-6-luna[${e}]`, name: `6 Luna (${e})` })),
  ...['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((e) => ({ id: `gpt-5.6-terra[${e}]`, name: `5.6 Terra (${e})` })),
];

test('Codex 의 "모델[깊이]" 목록을 모델별로 묶는다', () => {
  const s = splitEffortModels(list)!;
  assert.deepEqual(s.models, [{ id: 'gpt-6-luna', name: '6 Luna' }, { id: 'gpt-5.6-terra', name: '5.6 Terra' }]);
  assert.deepEqual(s.efforts.get('gpt-5.6-terra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('[깊이] 꼴이 아니면 묶지 않는다(Gemini 등)', () => {
  assert.equal(splitEffortModels([{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }]), null);
  assert.equal(splitEffortModels([]), null);
});

test('모델과 생각 깊이를 CLI 가 받는 꼴로 합친다', () => {
  const s = splitEffortModels(list)!;
  assert.equal(withEffort(s, 'gpt-6-luna', 'high'), 'gpt-6-luna[high]');
  assert.equal(withEffort(s, 'gpt-6-luna', undefined), 'gpt-6-luna[medium]'); // 깊이를 안 고르면 기본
  assert.equal(withEffort(s, 'gpt-6-luna[xhigh]', undefined), 'gpt-6-luna[xhigh]'); // 예전에 고른 값은 그대로
  assert.equal(withEffort(s, 'gpt-6-luna[xhigh]', 'low'), 'gpt-6-luna[low]'); // 작업에 정한 깊이가 앞선다
  assert.equal(withEffort(s, 'gpt-6-luna', 'ultra'), 'gpt-6-luna[medium]'); // 그 모델이 받지 않는 깊이
  assert.equal(withEffort(s, 'gpt-9', 'high'), 'gpt-9'); // 모르는 모델은 그대로
  assert.equal(withEffort(s, null, 'high'), null);
  assert.equal(baseOf('gpt-5.6-terra[ultra]'), 'gpt-5.6-terra');
});
