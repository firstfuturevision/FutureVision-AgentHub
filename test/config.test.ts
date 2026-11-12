import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, originRepo } from '../src/config.ts';

const repoWith = (origin?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent hub config '));
  execFileSync('git', ['init', '-q', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
};

test('업데이트 레포: 포크해 받은 곳(origin)이 기본, config.json 에 적으면 그것', () => {
  assert.equal(loadConfig(repoWith('https://github.com/other-co/agent-hub.git')).updateRepo, 'https://github.com/other-co/agent-hub');
  assert.equal(originRepo(repoWith('git@github.com:other-co/agent-hub.git')), 'https://github.com/other-co/agent-hub');
  assert.equal(originRepo(repoWith('https://x-access-token:abc@github.com/other-co/agent-hub')), 'https://github.com/other-co/agent-hub'); // 토큰은 빼고

  // origin 이 없거나 git 폴더가 아니면 원래 레포
  assert.equal(loadConfig(repoWith()).updateRepo, 'https://github.com/firstfuturevision/FutureVision-AgentHub');
  assert.equal(loadConfig(mkdtempSync(join(tmpdir(), 'agent hub nogit '))).updateRepo, 'https://github.com/firstfuturevision/FutureVision-AgentHub');

  const dir = repoWith('https://github.com/other-co/agent-hub.git');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ updateRepo: 'https://git.example.com/me/hub' }));
  assert.equal(loadConfig(dir).updateRepo, 'https://git.example.com/me/hub');
});
