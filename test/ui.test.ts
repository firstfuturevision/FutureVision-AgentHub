import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

// 화면 스크립트는 모듈이라 문법 오류 하나면 화면 전체가 멈춘다(선택 상자도 브라우저 기본 목록으로 돌아감).
// .mjs 로 옮겨 node --check 로 모듈 문법을 확인한다(같은 이름 두 번 선언 같은 것).
test('화면 스크립트가 모듈로 읽힌다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent hub ui '));
  for (const f of readdirSync(ui).filter((n) => n.endsWith('.js'))) {
    const copy = join(dir, f.replace(/\.js$/, '.mjs'));
    copyFileSync(join(ui, f), copy);
    const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr.split('\n').find((l) => l.includes('Error')) ?? r.stderr}`);
  }
});
