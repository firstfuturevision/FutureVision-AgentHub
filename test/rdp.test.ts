import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md4, Rc4 } from '../src/rdp/crypto.ts';
import { Zgfx } from '../src/rdp/zgfx.ts';
import { decodeProgressive } from '../src/rdp/rfx.ts';
import { SCANCODE } from '../src/rdp/client.ts';

test('MD4·RC4: 표준 시험 값(RFC 1320, MS-NLMP)', () => {
  assert.equal(md4(Buffer.alloc(0)).toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.equal(md4(Buffer.from('abc')).toString('hex'), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.equal(md4(Buffer.from('message digest')).toString('hex'), 'd9130a8164549fe818874806e1c7014b');
  // NT 해시 = MD4(UTF-16LE 비밀번호) — MS-NLMP 4.2.1 의 "Password"
  assert.equal(md4(Buffer.from('Password', 'utf16le')).toString('hex'), 'a4f49c406510bdcab6824ee7c30fd852');
  assert.equal(new Rc4(Buffer.from('Key')).update(Buffer.from('Plaintext')).toString('hex'), 'bbf316e8d940af0ad3');
  // 이어 쓰기: 두 번에 나눠도 한 번과 같다
  const a = new Rc4(Buffer.from('Wiki')), b = new Rc4(Buffer.from('Wiki'));
  assert.equal(Buffer.concat([a.update(Buffer.from('ped')), a.update(Buffer.from('ia'))]).toString('hex'), b.update(Buffer.from('pedia')).toString('hex'));
});

test('ZGFX: 압축 안 한 묶음, 글자·거리 토큰, 여러 조각', () => {
  const z = new Zgfx();
  assert.equal(z.decode(Buffer.from([0xe0, 0x04, ...Buffer.from('hello')])).toString(), 'hello');
  // "AB" + (거리 2, 3개) → "ABABA" : 0+8비트 글자 두 개, 10001+5비트 거리, 0(=3개)
  const bits = '0' + (0x41).toString(2).padStart(8, '0') + '0' + (0x42).toString(2).padStart(8, '0') + '10001' + '00010' + '0';
  const pad = (8 - (bits.length % 8)) % 8;
  const bytes = (bits + '0'.repeat(pad)).match(/.{8}/g)!.map((b) => parseInt(b, 2));
  assert.equal(new Zgfx().decode(Buffer.from([0xe0, 0x24, ...bytes, pad])).toString(), 'ABABA');
  // 여러 조각(MULTIPART)
  const seg = (s: string) => { const d = Buffer.from([0x04, ...Buffer.from(s)]); const h = Buffer.alloc(4); h.writeUInt32LE(d.length); return Buffer.concat([h, d]); };
  const head = Buffer.alloc(7); head[0] = 0xe1; head.writeUInt16LE(2, 1); head.writeUInt32LE(6, 3);
  assert.equal(new Zgfx().decode(Buffer.concat([head, seg('foo'), seg('bar')])).toString(), 'foobar');
});

test('RemoteFX Progressive: 영역·타일을 풀어 바뀐 사각형 안만 칠한다', () => {
  // 계수가 모두 0 인 타일 = 회색(128). 64×64 타일 하나, 영역은 (8,8)-(24,24)
  const tile = Buffer.alloc(22);
  tile.writeUInt16LE(0xccc5, 0); tile.writeUInt32LE(22, 2);
  tile[6] = 0; tile[7] = 0; tile[8] = 0; // 양자화 번호
  tile.writeUInt16LE(0, 9); tile.writeUInt16LE(0, 11); // 타일 위치 0,0
  const region = Buffer.alloc(18 + 8 + 5);
  region.writeUInt16LE(0xccc4, 0); region.writeUInt32LE(region.length + tile.length, 2);
  region[6] = 64; region.writeUInt16LE(1, 7); region[9] = 1; region[10] = 0; region[11] = 0; region.writeUInt16LE(1, 12); region.writeUInt32LE(tile.length, 14);
  region.writeUInt16LE(8, 18); region.writeUInt16LE(8, 20); region.writeUInt16LE(16, 22); region.writeUInt16LE(16, 24);
  region.fill(0x66, 26, 31); // 양자화 값 6
  const w = 64, h = 64, dst = Buffer.alloc(w * h * 4);
  const rects = decodeProgressive(Buffer.concat([region, tile]), dst, w * 4, w, h);
  assert.deepEqual(rects, [[8, 8, 16, 16]]);
  const px = (x: number, y: number) => [...dst.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];
  assert.deepEqual(px(10, 10), [128, 128, 128]);
  assert.deepEqual(px(0, 0), [0, 0, 0]); // 영역 밖은 그대로
  assert.deepEqual(px(30, 30), [0, 0, 0]);
});

test('키 → 스캔코드: 글자·숫자·방향키(확장)·한영', () => {
  assert.deepEqual(SCANCODE[65], [0x1e, false]); // A
  assert.deepEqual(SCANCODE[90], [0x2c, false]); // Z
  assert.deepEqual(SCANCODE[48], [0x0b, false]); // 0
  assert.deepEqual(SCANCODE[13], [0x1c, false]); // Enter
  assert.deepEqual(SCANCODE[37], [0x4b, true]); // ←
  assert.deepEqual(SCANCODE[46], [0x53, true]); // Delete
  assert.deepEqual(SCANCODE[21], [0x72, false]); // 한/영
  assert.deepEqual(SCANCODE[123], [0x58, false]); // F12
});
