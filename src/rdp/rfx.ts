// RemoteFX(MS-RDPRFX) 타일 디코더 + Progressive 컨테이너(MS-RDPEGFX 2.2.4.2).
// GNOME 원격 데스크톱은 RFX_PROGRESSIVE_TILE_SIMPLE(RLGR1, 일반 DWT)만 보낸다 — FreeRDP rfx 디코더와 같은 순서로 푼다.

/** RLGR1 → 4096 계수 */
export function rlgr1(src: Buffer, out: Int16Array) {
  const total = src.length * 8;
  let pos = 0;
  const bit = () => (src[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  const bits = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v; };
  let k = 1, kp = 8, kr = 1, krp = 8;
  let o = 0;
  const N = out.length;
  out.fill(0);
  while (pos < total && o < N) {
    if (k) {
      // 0 이 이어지는 동안 run 을 (1<<k) 씩 늘린다
      let vk = 0;
      while (pos < total && !((src[pos >> 3] >> (7 - (pos & 7))) & 1)) { pos++; vk++; }
      if (pos >= total) break;
      pos++;
      let run = 0;
      while (vk--) { run += 1 << k; kp = Math.min(80, kp + 4); k = kp >> 3; }
      if (total - pos < k) break;
      run += bits(k);
      if (total - pos < 1) break;
      const sign = bit();
      vk = 0;
      while (pos < total && ((src[pos >> 3] >> (7 - (pos & 7))) & 1)) { pos++; vk++; }
      if (pos >= total) break;
      pos++;
      if (total - pos < kr) break;
      let code = kr ? bits(kr) : 0;
      code |= vk << kr;
      if (!vk) { krp = Math.max(0, krp - 2); kr = krp >> 3; }
      else if (vk !== 1) { krp = Math.min(80, krp + vk); kr = krp >> 3; }
      kp = Math.max(0, kp - 6); k = kp >> 3;
      const mag = sign ? -(code + 1) : code + 1;
      o += Math.min(run, N - o);
      if (o < N) out[o++] = mag;
    } else {
      let vk = 0;
      while (pos < total && ((src[pos >> 3] >> (7 - (pos & 7))) & 1)) { pos++; vk++; }
      if (pos >= total) break;
      pos++;
      if (total - pos < kr) break;
      let code = kr ? bits(kr) : 0;
      code |= vk << kr;
      if (!vk) { krp = Math.max(0, krp - 2); kr = krp >> 3; }
      else if (vk !== 1) { krp = Math.min(80, krp + vk); kr = krp >> 3; }
      let mag: number;
      if (!code) { kp = Math.min(80, kp + 3); k = kp >> 3; mag = 0; }
      else { kp = Math.max(0, kp - 3); k = kp >> 3; mag = code & 1 ? -((code + 1) >> 1) : code >> 1; }
      out[o++] = mag;
    }
  }
}

/** 역양자화(RDPRFX 순서 q: LL3 LH3 HL3 HH3 LH2 HL2 HH2 LH1 HL1 HH1) */
function dequant(b: Int16Array, q: number[]) {
  const sh = (off: number, n: number, f: number) => { if (f > 0) for (let i = off; i < off + n; i++) b[i] = b[i] << f; };
  sh(0, 1024, q[8] - 1); sh(1024, 1024, q[7] - 1); sh(2048, 1024, q[9] - 1);
  sh(3072, 256, q[5] - 1); sh(3328, 256, q[4] - 1); sh(3584, 256, q[6] - 1);
  sh(3840, 64, q[2] - 1); sh(3904, 64, q[1] - 1); sh(3968, 64, q[3] - 1); sh(4032, 64, q[0] - 1);
}

const idwt = new Int16Array(4096);
function dwtBlock(buf: Int16Array, base: number, w: number) {
  const tw = w * 2, ww = w * w;
  // 가로: L = (LL, HL), H = (LH, HH) → idwt[0..], idwt[2ww..]
  const horiz = (lOff: number, hOff: number, dOff: number) => {
    for (let y = 0; y < w; y++) {
      const l = lOff + y * w, h = hOff + y * w, d = dOff + y * tw;
      idwt[d] = buf[l] - ((buf[h] + buf[h] + 1) >> 1);
      for (let n = 1; n < w; n++) idwt[d + 2 * n] = buf[l + n] - ((buf[h + n - 1] + buf[h + n] + 1) >> 1);
      let n = 0;
      for (; n < w - 1; n++) idwt[d + 2 * n + 1] = (buf[h + n] << 1) + ((idwt[d + 2 * n] + idwt[d + 2 * n + 2]) >> 1);
      idwt[d + 2 * n + 1] = (buf[h + n] << 1) + ((idwt[d + 2 * n] + idwt[d + 2 * n]) >> 1);
    }
  };
  horiz(base + ww * 3, base, 0);
  horiz(base + ww, base + ww * 2, ww * 2);
  // 세로: idwt(L, H) → buf
  const L = 0, H = ww * 2;
  for (let x = 0; x < tw; x++) buf[base + x] = idwt[L + x] - ((idwt[H + x] + idwt[H + x] + 1) >> 1);
  for (let n = 1; n < w; n++) {
    const y = n << 1;
    for (let x = 0; x < tw; x++) buf[base + y * tw + x] = idwt[L + n * tw + x] - ((idwt[H + (n - 1) * tw + x] + idwt[H + n * tw + x] + 1) >> 1);
  }
  let n = 0;
  for (; n < w - 1; n++) {
    const y = n << 1;
    for (let x = 0; x < tw; x++) buf[base + (y + 1) * tw + x] = (idwt[H + n * tw + x] << 1) + ((buf[base + y * tw + x] + buf[base + (y + 2) * tw + x]) >> 1);
  }
  const y = n << 1;
  for (let x = 0; x < tw; x++) buf[base + (y + 1) * tw + x] = (idwt[H + n * tw + x] << 1) + ((buf[base + y * tw + x] + buf[base + y * tw + x]) >> 1);
}

/** 성분 하나: RLGR1 → LL3 차분 → 역양자화 → 역 DWT */
export function decodeComponent(data: Buffer, q: number[], out: Int16Array) {
  rlgr1(data, out);
  for (let i = 4033; i < 4096; i++) out[i] = out[i] + out[i - 1];
  dequant(out, q);
  dwtBlock(out, 3840, 8);
  dwtBlock(out, 3072, 16);
  dwtBlock(out, 0, 32);
}

const CRR = Math.trunc(Math.fround(Math.fround(1.402525) * 65536));
const CRG = Math.trunc(Math.fround(Math.fround(0.714401) * 65536));
const CBG = Math.trunc(Math.fround(Math.fround(0.34373) * 65536));
const CBB = Math.trunc(Math.fround(Math.fround(1.769905) * 65536));
const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const i16 = (v: number) => (v << 16) >> 16;

/** YCbCr(11.5 고정소수) 64×64 → BGRX 를 표면에 (클립 사각형 안만) */
export function writeTile(y: Int16Array, cb: Int16Array, cr: Int16Array, dst: Buffer, stride: number, dstW: number, dstH: number, tx: number, ty: number, clips: number[][]) {
  for (const [cx, cy, cw, ch] of clips) {
    const x0 = Math.max(tx, cx, 0), y0 = Math.max(ty, cy, 0);
    const x1 = Math.min(tx + 64, cx + cw, dstW), y1 = Math.min(ty + 64, cy + ch, dstH);
    for (let py = y0; py < y1; py++) {
      let o = py * stride + x0 * 4;
      let s = (py - ty) * 64 + (x0 - tx);
      for (let px = x0; px < x1; px++, s++, o += 4) {
        const Y = (y[s] + 4096) * 65536;
        const Cb = cb[s], Cr = cr[s];
        const R = i16(Math.floor((Cr * CRR + Y) / 65536)) >> 5;
        const G = i16(Math.floor((Y - Cb * CBG - Cr * CRG) / 65536)) >> 5;
        const B = i16(Math.floor((Cb * CBB + Y) / 65536)) >> 5;
        dst[o] = clip(B); dst[o + 1] = clip(G); dst[o + 2] = clip(R); dst[o + 3] = 255;
      }
    }
  }
}

const cy = new Int16Array(4096), ccb = new Int16Array(4096), ccr = new Int16Array(4096);

/**
 * Progressive 묶음 하나를 표면(BGRX)에 그린다. 바뀐 사각형들을 돌려준다.
 * 지원: SYNC·CONTEXT·FRAME_BEGIN·FRAME_END·REGION(TILE_SIMPLE·TILE_FIRST(전 품질)). TILE_UPGRADE 는 건너뛴다.
 */
export function decodeProgressive(data: Buffer, dst: Buffer, stride: number, w: number, h: number): number[][] {
  const changed: number[][] = [];
  let o = 0;
  while (o + 6 <= data.length) {
    const type = data.readUInt16LE(o), blen = data.readUInt32LE(o + 2);
    if (blen < 6 || o + blen > data.length) break;
    if (type === 0xccc4) {
      const b = data.subarray(o, o + blen);
      const numRects = b.readUInt16LE(7), numQuant = b[9], numProg = b[10], nTiles = b.readUInt16LE(12);
      let p = 18;
      const rects: number[][] = [];
      for (let i = 0; i < numRects; i++, p += 8) rects.push([b.readUInt16LE(p), b.readUInt16LE(p + 2), b.readUInt16LE(p + 4), b.readUInt16LE(p + 6)]);
      const quants: number[][] = [];
      for (let i = 0; i < numQuant; i++, p += 5) {
        const q = new Array(10);
        q[0] = b[p] & 15; q[2] = b[p] >> 4; q[1] = b[p + 1] & 15; q[3] = b[p + 1] >> 4;
        q[5] = b[p + 2] & 15; q[4] = b[p + 2] >> 4; q[6] = b[p + 3] & 15; q[8] = b[p + 3] >> 4;
        q[7] = b[p + 4] & 15; q[9] = b[p + 4] >> 4;
        quants.push(q);
      }
      p += numProg * 16;
      for (let t = 0; t < nTiles && p + 6 <= b.length; t++) {
        const tt = b.readUInt16LE(p), tl = b.readUInt32LE(p + 2);
        if (tt === 0xccc5 || tt === 0xccc6) {
          const qy = quants[b[p + 6]], qcb = quants[b[p + 7]], qcr = quants[b[p + 8]];
          const xIdx = b.readUInt16LE(p + 9), yIdx = b.readUInt16LE(p + 11);
          let q = p + 14;
          if (tt === 0xccc6) q += 1; // TILE_FIRST: quality
          const yl = b.readUInt16LE(q), cbl = b.readUInt16LE(q + 2), crl = b.readUInt16LE(q + 4);
          q += 8; // + tailLen
          if (qy && qcb && qcr) {
            decodeComponent(b.subarray(q, q + yl), qy, cy);
            decodeComponent(b.subarray(q + yl, q + yl + cbl), qcb, ccb);
            decodeComponent(b.subarray(q + yl + cbl, q + yl + cbl + crl), qcr, ccr);
            writeTile(cy, ccb, ccr, dst, stride, w, h, xIdx * 64, yIdx * 64, rects);
          }
        }
        p += tl;
      }
      changed.push(...rects);
    }
    o += blen;
  }
  return changed;
}
