/**
 * 공개 레포에 올리기 전 검사: 올라갈 파일, 아직 안 올린 커밋이 더한 줄과 커밋 메시지에 키·토큰, 회사·고객 정보가 없는지 본다.
 *  - 키·토큰: 공유 레포 올리기와 같은 검사(findSecret)
 *  - 회사·고객 정보: data/public-deny.txt 에 한 줄에 하나씩 적은 말(대소문자 무시, # 은 주석). data/ 는 레포에 안 올라가므로
 *    회사 이름·고객 이름·사내 주소를 적어 두어도 바깥에 나가지 않는다.
 *  - 바이너리 파일(화면 캡처 등): 글로 검사할 수 없어 막는다. 확인한 것은 data/public-allow.txt 에 경로를 적는다
 * 걸리면 위치를 보여 주고 1 로 끝난다. `npm run check:public`, 또는 git pre-push 훅으로 푸시 전에 자동으로.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecret } from '../src/shared.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// --install: 이 레포의 git pre-push 훅으로 건다(푸시할 때마다 검사, 걸리면 푸시를 막음)
if (process.argv.includes('--install')) {
  const hook = join(root, git('rev-parse', '--git-path', 'hooks').trim(), 'pre-push');
  writeFileSync(hook, '#!/bin/sh\n# 공개 레포에 올리기 전 검사(scripts/check-public.ts). 걸리면 푸시를 막는다\ncd "$(git rev-parse --show-toplevel)" || exit 1\nexec node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/check-public.ts\n');
  chmodSync(hook, 0o755);
  console.log(`푸시 전 검사를 걸었습니다: ${hook}`);
  process.exit(0);
}

const denyFile = join(root, 'data', 'public-deny.txt');
const deny = existsSync(denyFile)
  ? readFileSync(denyFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase())
  : [];

const hits: string[] = [];
function check(where: string, line: string) {
  const secret = findSecret(line);
  if (secret) hits.push(`${where}: ${secret}로 보이는 값`);
  const low = line.toLowerCase();
  for (const word of deny) if (low.includes(word)) hits.push(`${where}: "${word}"`);
}

// 그림·압축 파일 같은 바이너리: 화면 캡처에 회사 정보가 찍혀 있어도 글 검사로는 못 잡는다. 직접 열어 보고 괜찮으면
// data/public-allow.txt 에 경로를 한 줄씩 적어 통과시킨다
const allowFile = join(root, 'data', 'public-allow.txt');
const allow = new Set(existsSync(allowFile) ? readFileSync(allowFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : []);
function binary(where: string, file: string) {
  if (!allow.has(file)) hits.push(`${where}: 바이너리 파일(그림 등) — 열어서 확인한 뒤 data/public-allow.txt 에 경로를 적으면 통과`);
}

// 검사 자체가 걸리지 않게: 키 모양을 일부러 적어 둔 검사 코드·시험은 키 검사에서 뺀다(금지어 검사는 한다)
const SECRET_FIXTURES = new Set(['src/shared.ts', 'test/shared.test.ts', 'test/remote.test.ts', 'scripts/check-public.ts']);

for (const file of git('ls-files').split('\n').filter(Boolean)) {
  if (file === 'LICENSE') continue;
  let text: string;
  try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
  if (text.includes('\0')) { binary(file, file); continue; } // 그림 같은 바이너리는 글로 못 읽으니 사람이 보게 한다
  text.split('\n').forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    if (SECRET_FIXTURES.has(file)) { const low = line.toLowerCase(); for (const word of deny) if (low.includes(word)) hits.push(`${where}: "${word}"`); }
    else check(where, line);
  });
}

// 아직 안 올린 커밋의 메시지(작성자 이름·메일은 git 설정이라 여기서 보지 않는다)
let upstream = '';
try { upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim(); } catch {}
if (upstream) {
  for (const block of git('log', '--format=%h%x00%B%x01', `${upstream}..HEAD`).split('\x01')) {
    const [hash, body] = block.trim().split('\0');
    if (hash) (body ?? '').split('\n').forEach((line) => check(`커밋 ${hash} 메시지`, line));
  }
  // 아직 안 올린 커밋 하나하나가 더한 줄: 마지막 파일만 보면 중간 커밋에 들어갔다가 지운 말이 기록째 올라간다
  const seen = new Set(hits);
  for (const hash of git('rev-list', `${upstream}..HEAD`).split('\n').filter(Boolean)) {
    // 중간 커밋에 들어갔다가 지운 바이너리도 기록째 올라간다(numstat 의 "-\t-\t경로")
    for (const line of git('show', '--format=', '--numstat', '--no-renames', hash).split('\n')) {
      const m = /^-\t-\t(.+)$/.exec(line);
      if (m) binary(`커밋 ${hash.slice(0, 7)} ${m[1]}`, m[1]);
    }
    let file = '';
    for (const line of git('show', '--format=', '--unified=0', '--no-color', hash).split('\n')) {
      if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
      if (!line.startsWith('+') || line.startsWith('+++') || file === 'LICENSE') continue;
      const before = hits.length;
      if (SECRET_FIXTURES.has(file)) { const low = line.toLowerCase(); for (const word of deny) if (low.includes(word)) hits.push(`커밋 ${hash.slice(0, 7)} ${file}: "${word}"`); }
      else check(`커밋 ${hash.slice(0, 7)} ${file}`, line.slice(1));
      // 같은 커밋·파일·말은 한 번만
      for (const h of hits.splice(before)) if (!seen.has(h)) { seen.add(h); hits.push(h); }
    }
  }
}

if (!deny.length) console.log(`(금지어 목록 없음: ${denyFile} 에 회사·고객 이름, 사내 주소를 한 줄에 하나씩 적어 두면 함께 검사합니다)`);
if (hits.length) {
  console.error(`공개 레포에 올리면 안 되는 내용 ${hits.length}곳:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`공개 검사 통과 (금지어 ${deny.length}개, 키·토큰 검사)`);
