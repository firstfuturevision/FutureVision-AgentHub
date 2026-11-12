// RDP(NTLM) 에 필요한데 Node 의 OpenSSL 3 에는 빠진 MD4·RC4 를 직접 둔다.

/** MD4(RFC 1320) */
export function md4(input: Buffer): Buffer {
  const len = input.length;
  const padLen = ((len + 8) >> 6) * 64 + 64;
  const m = Buffer.alloc(padLen);
  input.copy(m);
  m[len] = 0x80;
  m.writeUInt32LE((len * 8) >>> 0, padLen - 8);
  m.writeUInt32LE(Math.floor((len * 8) / 0x100000000), padLen - 4);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const x = new Int32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = m.readInt32LE(off + i * 4);
    const aa = a, bb = b, cc = c, dd = d;
    const f = (p: number, q: number, r: number) => (p & q) | (~p & r);
    const g = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
    const h = (p: number, q: number, r: number) => p ^ q ^ r;
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + f(b, c, d) + x[i]) | 0, 3);
      d = rotl((d + f(a, b, c) + x[i + 1]) | 0, 7);
      c = rotl((c + f(d, a, b) + x[i + 2]) | 0, 11);
      b = rotl((b + f(c, d, a) + x[i + 3]) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + g(b, c, d) + x[i] + 0x5a827999) | 0, 3);
      d = rotl((d + g(a, b, c) + x[i + 4] + 0x5a827999) | 0, 5);
      c = rotl((c + g(d, a, b) + x[i + 8] + 0x5a827999) | 0, 9);
      b = rotl((b + g(c, d, a) + x[i + 12] + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + h(b, c, d) + x[i] + 0x6ed9eba1) | 0, 3);
      d = rotl((d + h(a, b, c) + x[i + 8] + 0x6ed9eba1) | 0, 9);
      c = rotl((c + h(d, a, b) + x[i + 4] + 0x6ed9eba1) | 0, 11);
      b = rotl((b + h(c, d, a) + x[i + 12] + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0); out.writeInt32LE(b, 4); out.writeInt32LE(c, 8); out.writeInt32LE(d, 12);
  return out;
}

/** RC4 — 한 번 만들면 이어서 쓴다(NTLM 봉인은 방향마다 하나의 흐름) */
export class Rc4 {
  private s = new Uint8Array(256);
  private i = 0;
  private j = 0;
  constructor(key: Buffer) {
    for (let k = 0; k < 256; k++) this.s[k] = k;
    let j = 0;
    for (let k = 0; k < 256; k++) {
      j = (j + this.s[k] + key[k % key.length]) & 255;
      const t = this.s[k]; this.s[k] = this.s[j]; this.s[j] = t;
    }
  }
  update(data: Buffer): Buffer {
    const out = Buffer.alloc(data.length);
    let { i, j } = this;
    const s = this.s;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      j = (j + s[i]) & 255;
      const t = s[i]; s[i] = s[j]; s[j] = t;
      out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
    }
    this.i = i; this.j = j;
    return out;
  }
}
