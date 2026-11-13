import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clipboard, CLIP_MAX } from '../src/clipboard.ts';

// 진짜 X 화면 대신: get 은 파일을 읽고, serve 는 받은 글을 파일에 쓰고 "ok" 뒤에도 잠깐 살아 있는 가짜 도우미
function fakeHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'agent hub clip '));
  const store = join(dir, 'store.txt');
  const script = join(dir, 'fake-clip.py');
  writeFileSync(store, '');
  writeFileSync(script, `import sys, time
store = ${JSON.stringify(store)}
if sys.argv[1] == 'get':
    sys.stdout.write(open(store, encoding='utf-8').read())
else:
    open(store, 'w', encoding='utf-8').write(sys.stdin.read())
    print('ok', flush=True)
    time.sleep(30)
`);
  return { script };
}

test('클립보드(리눅스 길): 넣은 글을 그대로 가져오고, 새로 넣으면 앞 도우미는 끈다', { skip: process.platform !== 'linux' }, async () => {
  const { script } = fakeHelper();
  const c = new Clipboard({ script, platform: 'linux' });
  assert.equal(await c.get(), '');
  await c.set('안녕 클립보드 · 123');
  assert.equal(await c.get(), '안녕 클립보드 · 123');
  await c.set('두 번째');
  assert.equal(await c.get(), '두 번째');
  await assert.rejects(c.set('x'.repeat(CLIP_MAX + 1)), /너무 김/);
  await assert.rejects(c.set(undefined as any), /글이 없음/);
  c.stop();
});
