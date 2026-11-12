// 기본(baseline) JPEG 압축기 — 라이브러리 없이. 4:2:0 색 줄임, 표준 양자화·허프만 표, AAN 실수 DCT.
// 리눅스 화면 제어가 PNG 대신 이것을 쓴다(같은 화면이 5~10배 작다).

const ZIGZAG = [0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];
const Y_QT = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const C_QT = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const AASF = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

const DC_Y_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_Y_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_Y_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_Y_VAL = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const DC_C_BITS = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_C_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_C_BITS = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VAL = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

/** 허프만 표 → [코드, 길이] (값으로 찾기) */
function huff(bits: number[], vals: number[]): [number, number][] {
  const out: [number, number][] = [];
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) out[vals[k++]] = [code++, len];
    code <<= 1;
  }
  return out;
}
const HT = { dcY: huff(DC_Y_BITS, DC_Y_VAL), acY: huff(AC_Y_BITS, AC_Y_VAL), dcC: huff(DC_C_BITS, DC_C_VAL), acC: huff(AC_C_BITS, AC_C_VAL) };

/** 값 → [비트 수(범주), 비트] — -32767..32767 */
const CAT = new Uint8Array(65535), BITS = new Uint16Array(65535);
for (let v = -32767; v <= 32767; v++) {
  const a = Math.abs(v);
  let n = 0;
  while (a >> n) n++;
  CAT[v + 32767] = n;
  BITS[v + 32767] = v < 0 ? (v - 1 + (1 << n)) & ((1 << n) - 1) : v;
}

const tables = new Map<number, { qY: number[]; qC: number[]; fY: Float64Array; fC: Float64Array }>();
function quant(quality: number) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  let t = tables.get(q);
  if (t) return t;
  const sf = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const make = (std: number[]) => { const o = new Array(64); for (let i = 0; i < 64; i++) o[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((std[i] * sf + 50) / 100))); return o; };
  const qY = make(Y_QT), qC = make(C_QT);
  const fY = new Float64Array(64), fC = new Float64Array(64);
  for (let r = 0, k = 0; r < 8; r++) for (let c = 0; c < 8; c++, k++) {
    fY[k] = 1 / (qY[ZIGZAG[k]] * AASF[r] * AASF[c] * 8);
    fC[k] = 1 / (qC[ZIGZAG[k]] * AASF[r] * AASF[c] * 8);
  }
  t = { qY, qC, fY, fC };
  tables.set(q, t);
  return t;
}

class Bits {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private acc = 0;
  private cnt = 0;
  private grow(k: number) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; } }
  byte(b: number) { this.grow(1); this.buf[this.n++] = b; }
  bytes(a: number[]) { for (const b of a) this.byte(b); }
  word(w: number) { this.byte(w >> 8); this.byte(w & 255); }
  put(code: number, len: number) {
    this.acc = (this.acc << len) | code;
    this.cnt += len;
    while (this.cnt >= 8) {
      const b = (this.acc >> (this.cnt - 8)) & 255;
      this.grow(2);
      this.buf[this.n++] = b;
      if (b === 255) this.buf[this.n++] = 0;
      this.cnt -= 8;
    }
    this.acc &= (1 << this.cnt) - 1;
  }
  flush() { if (this.cnt > 0) this.put((1 << (8 - this.cnt)) - 1, 8 - this.cnt); }
}

const tmp = new Float64Array(64);
const du = new Int32Array(64);
/** 8×8 블록 하나: DCT → 양자화 → 지그재그 → 허프만. 새 DC 를 돌려준다 */
function block(out: Bits, data: Float64Array, f: Float64Array, prevDC: number, dc: [number, number][], ac: [number, number][]): number {
  const d = data;
  for (let o = 0; o < 64; o += 8) { // 가로
    const t0 = d[o] + d[o + 7], t7 = d[o] - d[o + 7], t1 = d[o + 1] + d[o + 6], t6 = d[o + 1] - d[o + 6];
    const t2 = d[o + 2] + d[o + 5], t5 = d[o + 2] - d[o + 5], t3 = d[o + 3] + d[o + 4], t4 = d[o + 3] - d[o + 4];
    let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
    d[o] = t10 + t11; d[o + 4] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781;
    d[o + 2] = t13 + z1; d[o + 6] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
    const z11 = t7 + z3, z13 = t7 - z3;
    d[o + 5] = z13 + z2; d[o + 3] = z13 - z2; d[o + 1] = z11 + z4; d[o + 7] = z11 - z4;
  }
  for (let o = 0; o < 8; o++) { // 세로
    const t0 = d[o] + d[o + 56], t7 = d[o] - d[o + 56], t1 = d[o + 8] + d[o + 48], t6 = d[o + 8] - d[o + 48];
    const t2 = d[o + 16] + d[o + 40], t5 = d[o + 16] - d[o + 40], t3 = d[o + 24] + d[o + 32], t4 = d[o + 24] - d[o + 32];
    let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
    d[o] = t10 + t11; d[o + 32] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781;
    d[o + 16] = t13 + z1; d[o + 48] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
    const z11 = t7 + z3, z13 = t7 - z3;
    d[o + 40] = z13 + z2; d[o + 24] = z13 - z2; d[o + 8] = z11 + z4; d[o + 56] = z11 - z4;
  }
  for (let i = 0; i < 64; i++) { const v = d[i] * f[i]; du[ZIGZAG[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0; }
  const diff = du[0] - prevDC;
  if (diff === 0) out.put(dc[0][0], dc[0][1]);
  else { const k = diff + 32767; out.put(dc[CAT[k]][0], dc[CAT[k]][1]); out.put(BITS[k], CAT[k]); }
  let end = 63;
  while (end > 0 && du[end] === 0) end--;
  if (end === 0) { out.put(ac[0][0], ac[0][1]); return du[0]; }
  for (let i = 1; i <= end;) {
    const start = i;
    while (du[i] === 0 && i <= end) i++;
    let run = i - start;
    if (run >= 16) { for (let r = 0; r < run >> 4; r++) out.put(ac[0xf0][0], ac[0xf0][1]); run &= 15; }
    const k = du[i] + 32767;
    const sym = (run << 4) + CAT[k];
    out.put(ac[sym][0], ac[sym][1]);
    out.put(BITS[k], CAT[k]);
    i++;
  }
  if (end !== 63) out.put(ac[0][0], ac[0][1]);
  return du[0];
}

/** RGB(한 칸 3바이트) → JPEG */
export function encodeJpeg(rgb: Uint8Array, w: number, h: number, quality = 70): Buffer {
  const { qY, qC, fY, fC } = quant(quality);
  const out = new Bits();
  out.word(0xffd8);
  out.bytes([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF
  out.word(0xffdb); out.word(132);
  out.byte(0); for (let i = 0; i < 64; i++) out.byte(qY[i]);
  out.byte(1); for (let i = 0; i < 64; i++) out.byte(qC[i]);
  out.word(0xffc0); out.word(17); out.byte(8); out.word(h); out.word(w); out.byte(3);
  out.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]); // Y 2×2, Cb·Cr 1×1 (4:2:0)
  out.word(0xffc4); out.word(418);
  for (const [cls, bits, vals] of [[0x00, DC_Y_BITS, DC_Y_VAL], [0x10, AC_Y_BITS, AC_Y_VAL], [0x01, DC_C_BITS, DC_C_VAL], [0x11, AC_C_BITS, AC_C_VAL]] as const) {
    out.byte(cls); for (let i = 1; i <= 16; i++) out.byte(bits[i]); for (const v of vals) out.byte(v);
  }
  out.word(0xffda); out.word(12); out.byte(3); out.bytes([1, 0, 2, 0x11, 3, 0x11]); out.bytes([0, 0x3f, 0]);

  let dY = 0, dCb = 0, dCr = 0;
  const cb = new Float64Array(64), cr = new Float64Array(64);
  const cbAcc = new Float64Array(64), crAcc = new Float64Array(64);
  for (let my = 0; my < h; my += 16) {
    for (let mx = 0; mx < w; mx += 16) {
      cbAcc.fill(0); crAcc.fill(0);
      for (let b = 0; b < 4; b++) {
        const bx = mx + (b & 1) * 8, by = my + (b >> 1) * 8;
        for (let y = 0; y < 8; y++) {
          const py = Math.min(h - 1, by + y);
          for (let x = 0; x < 8; x++) {
            const px = Math.min(w - 1, bx + x), o = (py * w + px) * 3;
            const R = rgb[o], G = rgb[o + 1], B = rgb[o + 2];
            tmp[y * 8 + x] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
            const ci = ((b >> 1) * 4 + (y >> 1)) * 8 + (b & 1) * 4 + (x >> 1);
            cbAcc[ci] += -0.16874 * R - 0.33126 * G + 0.5 * B;
            crAcc[ci] += 0.5 * R - 0.41869 * G - 0.08131 * B;
          }
        }
        dY = block(out, tmp, fY, dY, HT.dcY, HT.acY);
      }
      for (let i = 0; i < 64; i++) { cb[i] = cbAcc[i] / 4; cr[i] = crAcc[i] / 4; }
      dCb = block(out, cb, fC, dCb, HT.dcC, HT.acC);
      dCr = block(out, cr, fC, dCr, HT.dcC, HT.acC);
    }
  }
  out.flush();
  out.word(0xffd9);
  return Buffer.from(out.buf.buffer, 0, out.n);
}
