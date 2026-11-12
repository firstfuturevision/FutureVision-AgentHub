// RDP8 벌크 압축 풀기(ZGFX, MS-RDPEGFX 3.1.9.1) + RDP_SEGMENTED_DATA
const HISTORY = 2500000;

// [길이, 접두 비트, 값 비트, 종류(0 글자 1 거리), 기준]
const TABLE: number[][] = [
  [1, 0, 8, 0, 0], [5, 17, 5, 1, 0], [5, 18, 7, 1, 32], [5, 19, 9, 1, 160], [5, 20, 10, 1, 672], [5, 21, 12, 1, 1696],
  [5, 24, 0, 0, 0x00], [5, 25, 0, 0, 0x01], [6, 44, 14, 1, 5792], [6, 45, 15, 1, 22176], [6, 52, 0, 0, 0x02], [6, 53, 0, 0, 0x03],
  [6, 54, 0, 0, 0xff], [7, 92, 18, 1, 54944], [7, 93, 20, 1, 317088], [7, 110, 0, 0, 0x04], [7, 111, 0, 0, 0x05], [7, 112, 0, 0, 0x06],
  [7, 113, 0, 0, 0x07], [7, 114, 0, 0, 0x08], [7, 115, 0, 0, 0x09], [7, 116, 0, 0, 0x0a], [7, 117, 0, 0, 0x0b], [7, 118, 0, 0, 0x3a],
  [7, 119, 0, 0, 0x3b], [7, 120, 0, 0, 0x3c], [7, 121, 0, 0, 0x3d], [7, 122, 0, 0, 0x3e], [7, 123, 0, 0, 0x3f], [7, 124, 0, 0, 0x40],
  [7, 125, 0, 0, 0x80], [8, 188, 20, 1, 1365664], [8, 189, 21, 1, 2414240], [8, 252, 0, 0, 0x0c], [8, 253, 0, 0, 0x38],
  [8, 254, 0, 0, 0x39], [8, 255, 0, 0, 0x66],
];

export class Zgfx {
  private hist = Buffer.alloc(HISTORY);
  private hi = 0;

  private push(b: number) { this.hist[this.hi] = b; this.hi = (this.hi + 1) % HISTORY; }

  private segment(seg: Buffer, out: number[]) {
    const flags = seg[0];
    if ((flags & 0x0f) !== 0x04) throw new Error('ZGFX: RDP8 아님');
    const data = seg.subarray(1);
    if (!(flags & 0x20)) { for (const b of data) { out.push(b); this.push(b); } return; }
    if (!data.length) return;
    const end = (data.length - 1) * 8 - data[data.length - 1];
    let pos = 0;
    const bits = (n: number) => { let v = 0; for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
    while (pos < end) {
      let code = 0, l = 0, tok: number[] | undefined;
      for (const t of TABLE) {
        while (l < t[0]) { code = (code << 1) | bits(1); l++; }
        if (code === t[1]) { tok = t; break; }
      }
      if (!tok) throw new Error('ZGFX: 모르는 토큰');
      if (tok[3] === 0) {
        const v = tok[2] ? bits(tok[2]) : tok[4];
        out.push(v); this.push(v);
        continue;
      }
      const dist = tok[4] + bits(tok[2]);
      if (dist) {
        let count: number;
        if (bits(1) === 0) count = 3;
        else {
          count = 4; let extra = 2;
          while (bits(1) === 1) { count *= 2; extra++; }
          count += bits(extra);
        }
        let src = (this.hi - dist + HISTORY) % HISTORY;
        for (let i = 0; i < count; i++) { const b = this.hist[src]; out.push(b); this.push(b); src = (src + 1) % HISTORY; }
      } else {
        const count = bits(15);
        pos = (pos + 7) & ~7; // 남은 비트 버리고 바이트 경계로
        for (let i = 0; i < count; i++) { const b = data[pos >> 3]; out.push(b); this.push(b); pos += 8; }
      }
    }
  }

  /** RDP_SEGMENTED_DATA → 풀린 바이트 */
  decode(d: Buffer): Buffer {
    const out: number[] = [];
    if (d[0] === 0xe0) this.segment(d.subarray(1), out);
    else if (d[0] === 0xe1) {
      const n = d.readUInt16LE(1);
      let o = 7;
      for (let i = 0; i < n; i++) { const s = d.readUInt32LE(o); this.segment(d.subarray(o + 4, o + 4 + s), out); o += 4 + s; }
    } else throw new Error('ZGFX: 모르는 묶음');
    return Buffer.from(out);
  }
}
