import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore 화면 모듈(브라우저용 JS)
import { serverUrl } from '../ui/md.js';

test('그림 · 첨부 주소는 서버 기준 상대 주소로: 중계 접두어 · 다른 PC · 예전 사내망 주소', () => {
  (globalThis as any).location = { origin: 'http://127.0.0.1:4317' };
  const peers = [{ url: 'http://192.168.0.47:4319' }];
  assert.equal(serverUrl('/images/abc-1/f-2.png', peers), 'images/abc-1/f-2.png');
  assert.equal(serverUrl('/attachment?sessionId=a&path=%EC%B2%A8%EB%B6%80%2Fx.png', peers), 'attachment?sessionId=a&path=%EC%B2%A8%EB%B6%80%2Fx.png');
  // 같은 서버의 절대 주소
  assert.equal(serverUrl('http://127.0.0.1:4317/images/a/b.jpg', peers), 'images/a/b.jpg');
  // 연결된 PC 주소로 걸린 그림 → 이 서버를 거쳐
  assert.equal(serverUrl('http://192.168.0.47:4319/images/a/b.png', peers), `peers/file?url=${encodeURIComponent('http://192.168.0.47:4319')}&path=${encodeURIComponent('/images/a/b.png')}`);
  // 예전 버전이 보낸 이 PC 의 다른 주소(사내망 IP) → 이 서버에서
  assert.equal(serverUrl('http://192.168.0.45:4319/images/a/b.webp', peers), 'images/a/b.webp');
  // 바깥 주소 · 그림이 아닌 길 · 이미 상대 주소 · blob 은 그대로
  assert.equal(serverUrl('https://example.com/docs/page', peers), 'https://example.com/docs/page');
  assert.equal(serverUrl('peers/file?url=x&path=y', peers), 'peers/file?url=x&path=y');
  assert.equal(serverUrl('blob:http://x/1', peers), 'blob:http://x/1');
  assert.equal(serverUrl('//cdn.example.com/a.png', peers), '//cdn.example.com/a.png');
});
