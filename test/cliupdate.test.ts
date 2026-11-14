import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliUpdater } from '../src/cliupdate.ts';

function world(opts: { busy?: boolean; claudeOut?: string; claudeFails?: boolean; geminiNow?: string; geminiLatest?: string; smokeFails?: boolean } = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  let models = [{ id: 'opus', name: 'Opus 5.5' }, { id: 'fable', name: 'Fable 5.1' }];
  let busy = opts.busy ?? false;
  const u = new CliUpdater({
    file: join(mkdtempSync(join(tmpdir(), 'cliup-')), 'cli-update.json'),
    claudeCommand: 'claude-시험-없는-명령', // 진짜 claude 링크를 건드리지 않게
    refreshModels: async () => { if (opts.claudeOut?.includes('Successfully')) models = [{ id: 'opus', name: 'Opus 5.5' }, { id: 'fable', name: 'Fable 5.2' }]; return models; }, // 실제로 올렸을 때만 목록이 바뀐다
    currentModels: () => models,
    installed: () => ({ claude: { installed: true }, gemini: { installed: Boolean(opts.geminiNow) }, codex: { installed: false } }),
    busy: () => busy,
    notify: (m) => notes.push(m),
    smokeClaude: async () => { if (opts.smokeFails) throw new Error('응답 없음'); return { status: 'allowed', unifiedWindows: {} }; },
    fetchText: async () => '# Changelog\n## 2.1.325\n- Added Fable 5.2 model\n- Fixed a typo\n## 2.1.300\n- New --foo flag\n## 2.1.294\n- old thing\n',
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'claude-시험-없는-명령') { if (args[0] === '--version') return '2.1.294 (Claude Code)'; if (opts.claudeFails) throw new Error('네트워크 오류'); return opts.claudeOut ?? 'Claude Code is up to date (2.1.325)'; }
      if (args[0] === 'view') return `${opts.geminiLatest}\n`;
      if (args[0] === 'ls') return JSON.stringify({ dependencies: { '@google/gemini-cli': { version: opts.geminiNow } } });
      return 'ok';
    },
  });
  return { u, calls, notes, setBusy: (b: boolean) => { busy = b; } };
}

test('작업자 프로그램 업데이트: 정한 시각 뒤 모두 쉴 때 한 번, 올리면 모델 목록을 다시 받고 새 모델을 알린다', async () => {
  const w = world({ busy: true, claudeOut: 'Updating to 2.1.325...\nSuccessfully updated from 2.1.294 to version 2.1.325' });
  const at6 = new Date(2026, 10, 15, 6, 0);
  await w.u.tick(at6);
  assert.deepEqual(w.calls, []); // 일하는 중이면 기다린다
  w.setBusy(false);
  await w.u.tick(at6);
  assert.deepEqual(w.calls, ['claude-시험-없는-명령 --version', 'claude-시험-없는-명령 update']);
  assert.match(w.u.public().lastResult!, /Claude Code 2\.1\.294 → 2\.1\.325/);
  assert.ok(w.notes.some((n) => /Claude 모델 목록이 바뀌었어요 · 새로: Fable 5\.2 · 없어짐: Fable 5\.1/.test(n)));
  // 바뀐 점: 2.1.294 초과 ~ 2.1.325 이하만, 모델·옵션 줄이 앞
  const note = w.u.public().notes!.at(-1)!;
  assert.deepEqual([note.from, note.to], ['2.1.294', '2.1.325']);
  assert.deepEqual(note.lines, ['Added Fable 5.2 model', 'New --foo flag', 'Fixed a typo']);
  await w.u.tick(new Date(2026, 10, 15, 9, 0)); // 같은 날은 다시 안 함
  assert.equal(w.calls.length, 2);
  await w.u.tick(new Date(2026, 10, 16, 5, 1)); // 다음 날 05:00 뒤
  assert.equal(w.calls.length, 4);
});

test('작업자 프로그램 업데이트: 꺼 두면 안 하고, 실패하면 그대로 두고 알리고, npm 으로 깐 Gemini 는 옛것일 때만', async () => {
  const off = world();
  off.u.set({ enabled: false });
  await off.u.tick(new Date(2026, 10, 15, 6, 0));
  assert.deepEqual(off.calls, []);
  assert.throws(() => off.u.set({ hour: 24 }), /0~23/);

  const bad = world({ claudeFails: true, geminiNow: '0.20.0', geminiLatest: '0.23.0' });
  const r = await bad.u.check();
  assert.match(r, /올림: @google\/gemini-cli 0\.20\.0 → 0\.23\.0/);
  assert.match(r, /실패\(그대로 둠\): Claude Code\(네트워크 오류\)/);
  assert.ok(bad.calls.includes('npm install -g @google/gemini-cli@latest'));
  assert.ok(bad.notes.some((n) => /작업자 프로그램 업데이트/.test(n)));

  const same = world({ geminiNow: '0.23.0', geminiLatest: '0.23.0' });
  assert.equal(await same.u.check(), '새 버전 없음');
  assert.equal(same.calls.some((c) => c.includes('install')), false);
  assert.deepEqual(same.notes, []); // 바뀐 것 없으면 조용히
});

test('작업자 프로그램 업데이트: 올린 뒤 시험이 실패하면 이전 버전으로 되돌리고 알린다', async () => {
  const w = world({ claudeOut: 'Successfully updated from 2.1.294 to version 2.1.325', smokeFails: true });
  const r = await w.u.check();
  assert.match(r, /Claude Code 2\.1\.325 시험 실패\(응답 없음\) → 2\.1\.294 되돌림/);
  assert.ok(w.calls.includes('npm install -g @anthropic-ai/claude-code@2.1.294'));
  assert.equal((w.u.public().notes ?? []).length, 0); // 되돌렸으니 바뀐 점은 남기지 않는다
});
