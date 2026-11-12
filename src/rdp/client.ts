// 작은 RDP 클라이언트 — GNOME 원격 데스크톱(gnome-remote-desktop, FreeRDP3 서버)에 붙어 화면을 받고 입력을 넣는다.
// 라이브러리 없이: X.224 → TLS → CredSSP(NLA, NTLMv2) → MCS/GCC → 능력 교환 → 동적 채널(DRDYNVC) → 그래픽 파이프라인(RDPGFX)
// 화면: RDPGFX + ZGFX + RemoteFX Progressive(TILE_SIMPLE). 입력: 빠른 경로(마우스·스캔코드·유니코드).
import { connect as tcp, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { credssp } from './credssp.ts';
import { Zgfx } from './zgfx.ts';
import { decodeProgressive } from './rfx.ts';

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const be16 = (n: number) => Buffer.from([(n >> 8) & 255, n & 255]);
const utf16z = (s: string) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
const perLen = (n: number) => (n < 0x80 ? Buffer.from([n]) : Buffer.from([0x80 | (n >> 8), n & 255]));
function berLen(n: number) { return n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]); }
const ber = (tag: number[], c: Buffer) => Buffer.concat([Buffer.from(tag), berLen(c.length), c]);
const berInt = (n: number) => { const b: number[] = []; let v = n; do { b.unshift(v & 255); v >>= 8; } while (v > 0); if (b[0] & 0x80) b.unshift(0); return ber([0x02], Buffer.from(b)); };
const tpkt = (p: Buffer) => Buffer.concat([Buffer.from([3, 0]), be16(p.length + 4), p]);
const x224Data = (p: Buffer) => tpkt(Buffer.concat([Buffer.from([2, 0xf0, 0x80]), p]));

const GFX_NAME = 'Microsoft::Windows::RDS::Graphics';
const IO_CHANNEL = 1003;

interface Surface { w: number; h: number; buf: Buffer; ox: number; oy: number; mapped: boolean }

export class RdpClient {
  width = 0;
  height = 0;
  fb = Buffer.alloc(0); // 화면 출력(BGRX)
  frames = 0;
  onClose?: (err: Error) => void;
  log: (m: string) => void = () => {};

  private sock!: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  private waiters: ((p: Buffer) => void)[] = [];
  private closedErr: Error | null = null;
  private userId = 0;
  private channels = new Map<string, number>(); // 이름 → MCS 채널
  private shareId = 0;
  private user = '';
  private vcBuf = new Map<number, Buffer[]>();
  private dvcGfx = -1;
  private dvcBuf = new Map<number, { total: number; parts: Buffer[]; got: number }>();
  private zgfx = new Zgfx();
  private surfaces = new Map<number, Surface>();
  private cache = new Map<number, { w: number; h: number; buf: Buffer }>();
  private active = false;
  private ready!: () => void;
  private readyP = new Promise<void>((ok) => { this.ready = ok; });

  async connect(host: string, port: number, user: string, password: string, opts: { width?: number; height?: number; timeoutMs?: number } = {}) {
    this.user = user;
    const width = opts.width ?? 1280, height = opts.height ?? 800;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, fail) => { timer = setTimeout(() => { fail(new Error('원격 데스크톱이 답하지 않음')); this.close(); }, opts.timeoutMs ?? 15000); });
    try {
      await Promise.race([this.handshake(host, port, user, password, width, height), timeout]);
      await Promise.race([this.readyP, timeout]); // 첫 화면 크기를 받을 때까지
    } finally {
      clearTimeout(timer);
    }
  }

  close() { this.sock?.destroy(); }
  get closed() { return this.closedErr !== null; }

  // ── 읽기: TPKT 또는 빠른 경로 PDU 하나씩 ──
  private onData = (d: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const p = this.cut();
      if (!p) break;
      if (this.waiters.length) this.waiters.shift()!(p);
      else { try { this.handle(p); } catch (e) { this.log(`처리 오류: ${(e as Error).message}`); } }
    }
  };

  private cut(): Buffer | null {
    const b = this.buf;
    if (b.length < 2) return null;
    let n: number;
    if (b[0] === 3) { if (b.length < 4) return null; n = b.readUInt16BE(2); }
    else if (b[1] & 0x80) { if (b.length < 3) return null; n = ((b[1] & 0x7f) << 8) | b[2]; }
    else n = b[1];
    if (n < 2 || b.length < n) return null;
    this.buf = b.subarray(n);
    return b.subarray(0, n);
  }

  private next(): Promise<Buffer> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((ok, fail) => {
      this.waiters.push(ok);
      const t = setInterval(() => { if (this.closedErr) { clearInterval(t); fail(this.closedErr); } }, 200);
      const orig = ok;
      this.waiters[this.waiters.length - 1] = (p) => { clearInterval(t); orig(p); };
    });
  }

  private watch(s: Socket | TLSSocket) {
    const close = (err: Error) => {
      if (this.closedErr) return;
      this.closedErr = err;
      this.onClose?.(err);
    };
    s.on('error', close);
    s.on('close', () => close(new Error('원격 데스크톱 연결이 끊김')));
  }

  /** MCS SDin 의 데이터 부분: [채널, 데이터] */
  private mcsData(p: Buffer): [number, Buffer] | null {
    if (p[0] !== 3) return null;
    const m = p.subarray(7);
    const type = m[0] >> 2;
    if (type === 26) { // Send Data Indication
      const ch = m.readUInt16BE(3);
      let o = 6, l = m[o++];
      if (l & 0x80) l = ((l & 0x3f) << 8) | m[o++];
      return [ch, m.subarray(o, o + l)];
    }
    if (type === 8) throw new Error('원격 데스크톱이 연결을 끊음(MCS)');
    return null;
  }

  private send(channel: number, data: Buffer) {
    const m = Buffer.concat([Buffer.from([0x64]), be16(this.userId - 1001), be16(channel), Buffer.from([0x70]), perLen(data.length), data]);
    this.sock.write(x224Data(m));
  }

  // ── 연결 ──
  private async handshake(host: string, port: number, user: string, password: string, width: number, height: number) {
    const raw = tcp({ host, port });
    raw.setNoDelay(true);
    await new Promise<void>((ok, fail) => { raw.once('connect', ok); raw.once('error', fail); });
    // X.224 Connection Request: TLS|NLA 요청
    const cookie = Buffer.from(`Cookie: mstshash=${user.slice(0, 9)}\r\n`, 'latin1');
    const neg = Buffer.concat([Buffer.from([1, 0]), u16(8), u32(0x3)]);
    const cr = Buffer.concat([Buffer.from([0xe0, 0, 0, 0, 0, 0]), cookie, neg]);
    raw.write(tpkt(Buffer.concat([Buffer.from([cr.length]), cr])));
    const cc = await new Promise<Buffer>((ok, fail) => {
      let b = Buffer.alloc(0);
      const on = (d: Buffer) => { b = Buffer.concat([b, d]); if (b.length >= 4 && b.length >= b.readUInt16BE(2)) { raw.off('data', on); ok(b); } };
      raw.on('data', on);
      raw.once('error', fail);
    });
    const negType = cc[11];
    if (negType === 3) throw new Error(`원격 데스크톱이 연결 방식을 거절함(${cc.readUInt32LE(15)})`);
    const selected = negType === 2 ? cc.readUInt32LE(15) : 0;
    if (!(selected & 2)) throw new Error('원격 데스크톱이 NLA 를 고르지 않음');

    const tls = tlsConnect({ socket: raw, rejectUnauthorized: false });
    await new Promise<void>((ok, fail) => { tls.once('secureConnect', ok); tls.once('error', fail); });
    this.sock = tls;
    this.watch(tls);
    const rest = await credssp(tls, user, password);
    tls.on('data', this.onData);
    if (rest.length) this.onData(rest);

    // MCS Connect Initial + GCC
    const ud = this.clientData(width, height, selected);
    const gccInner = Buffer.concat([Buffer.from([0, 8, 0, 0x10, 0, 1, 0xc0, 0, 0x44, 0x75, 0x63, 0x61]), perLen(ud.length), ud]);
    const gcc = Buffer.concat([Buffer.from([0, 5, 0, 0x14, 0x7c, 0, 1]), perLen(gccInner.length), gccInner]);
    const params = (a: number[]) => ber([0x30], Buffer.concat(a.map(berInt)));
    const ci = ber([0x7f, 0x65], Buffer.concat([
      ber([0x04], Buffer.from([1])), ber([0x04], Buffer.from([1])), ber([0x01], Buffer.from([0xff])),
      params([34, 2, 0, 1, 0, 1, 65535, 2]), params([1, 1, 1, 1, 0, 1, 1056, 2]), params([65535, 64535, 65535, 1, 0, 1, 65535, 2]),
      ber([0x04], gcc),
    ]));
    tls.write(x224Data(ci));
    const resp = await this.next();
    const at = resp.indexOf(Buffer.from('McDn', 'latin1'));
    if (at < 0) throw new Error('MCS 연결 응답이 이상함');
    let o = at + 4;
    let l = resp[o++];
    if (l & 0x80) l = ((l & 0x7f) << 8) | resp[o++];
    const blocks = resp.subarray(o, o + l);
    const ids: number[] = [];
    let msgChannel = 0;
    for (let p = 0; p + 4 <= blocks.length;) {
      const t = blocks.readUInt16LE(p), bl = blocks.readUInt16LE(p + 2);
      if (bl < 4) break;
      if (t === 0x0c03) { const n = blocks.readUInt16LE(p + 6); for (let i = 0; i < n; i++) ids.push(blocks.readUInt16LE(p + 8 + i * 2)); }
      if (t === 0x0c04) msgChannel = blocks.readUInt16LE(p + 4);
      p += bl;
    }
    if (ids[0]) this.channels.set('drdynvc', ids[0]);

    tls.write(x224Data(Buffer.from([0x04, 0x01, 0x00, 0x01, 0x00]))); // Erect Domain
    tls.write(x224Data(Buffer.from([0x28]))); // Attach User
    const auc = (await this.next()).subarray(7);
    if ((auc[0] >> 2) !== 11 || auc[1] !== 0) throw new Error('MCS 사용자 붙이기 실패');
    this.userId = auc.readUInt16BE(2) + 1001;
    for (const ch of [this.userId, IO_CHANNEL, ...ids, ...(msgChannel ? [msgChannel] : [])]) {
      tls.write(x224Data(Buffer.concat([Buffer.from([0x38]), be16(this.userId - 1001), be16(ch)])));
      const cj = (await this.next()).subarray(7);
      if ((cj[0] >> 2) !== 15 || cj[1] !== 0) throw new Error(`MCS 채널 ${ch} 참가 실패`);
    }

    // Client Info(자동 로그온)
    this.send(IO_CHANNEL, Buffer.concat([u16(0x0040), u16(0), this.clientInfo(user, password)]));
    // 나머지(라이선스·Demand Active·…)는 handle 이 받는다
    const w = this.waiters;
    w.length = 0;
  }

  private clientData(width: number, height: number, selected: number): Buffer {
    const name = Buffer.alloc(32);
    Buffer.from('agenthub', 'utf16le').copy(name);
    const core = Buffer.concat([
      u32(0x00080004), u16(width), u16(height), u16(0xca01), u16(0xaa03), u32(0x409), u32(2600), name,
      u32(4), u32(0), u32(12), Buffer.alloc(64), u16(0xca01), u16(1), u32(0), u16(24), u16(0x000f),
      u16(0x0001 | 0x0002 | 0x0020 | 0x0100), Buffer.alloc(64), Buffer.from([6, 0]), u32(selected),
      u32(0), u32(0), u16(0), u32(100), u32(100), // 실제 크기·방향·배율
    ]);
    const blk = (t: number, d: Buffer) => Buffer.concat([u16(t), u16(d.length + 4), d]);
    const ch = (n: string) => { const b = Buffer.alloc(8); b.write(n, 'latin1'); return Buffer.concat([b, u32(0xc0000000)]); };
    return Buffer.concat([
      blk(0xc001, core),
      blk(0xc002, Buffer.concat([u32(0), u32(0)])),
      blk(0xc003, Buffer.concat([u32(1), ch('drdynvc')])),
      blk(0xc004, Buffer.concat([u32(0x0d), u32(0)])),
    ]);
  }

  private clientInfo(user: string, password: string): Buffer {
    const flags = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x100 | 0x80000;
    const addr = utf16z('127.0.0.1'), dir = utf16z('C:\\agenthub');
    return Buffer.concat([
      u32(0), u32(flags), u16(0), u16(user.length * 2), u16(password.length * 2), u16(0), u16(0),
      utf16z(''), utf16z(user), utf16z(password), utf16z(''), utf16z(''),
      u16(2), u16(addr.length), addr, u16(dir.length), dir, Buffer.alloc(172), u32(0), u32(0x7), u16(0),
    ]);
  }

  // ── 받은 PDU ──
  private handle(p: Buffer) {
    if (p[0] !== 3) return; // 빠른 경로 출력(포인터 등) — 쓰지 않는다
    const md = this.mcsData(p);
    if (!md) return;
    const [ch, d] = md;
    if (ch === this.channels.get('drdynvc')) return this.staticVc(ch, d, (m) => this.dvc(m));
    if (d.length >= 4 && d.readUInt16LE(0) !== d.length && (d.readUInt16LE(0) & 0x0080)) return; // 라이선스
    this.shareControl(d);
  }

  private shareControl(d: Buffer) {
    for (let o = 0; o + 6 <= d.length;) {
      const total = d.readUInt16LE(o);
      if (total === 0x8000) { o += 8; continue; } // 흐름 PDU
      const pdu = d.subarray(o, o + total);
      const type = pdu.readUInt16LE(2) & 0x0f;
      if (type === 1) this.demandActive(pdu);
      else if (type === 7) {
        const t2 = pdu[14];
        if (t2 === 0x2f) { const e = pdu.readUInt32LE(18); if (e) this.log(`서버 오류 정보 0x${e.toString(16)}`); }
      }
      if (total < 6) break;
      o += total;
    }
  }

  private demandActive(pdu: Buffer) {
    this.shareId = pdu.readUInt32LE(6);
    const srcLen = pdu.readUInt16LE(10);
    let o = 14 + srcLen;
    const n = pdu.readUInt16LE(o);
    o += 4;
    for (let i = 0; i < n && o + 4 <= pdu.length; i++) {
      const t = pdu.readUInt16LE(o), l = pdu.readUInt16LE(o + 2);
      if (t === 2 && !this.width) { this.width = pdu.readUInt16LE(o + 12); this.height = pdu.readUInt16LE(o + 14); }
      o += l;
    }
    this.confirmActive();
  }

  private confirmActive() {
    const cap = (t: number, d: Buffer) => Buffer.concat([u16(t), u16(d.length + 4), d]);
    const w = this.width || 1280, h = this.height || 800;
    const caps = [
      cap(1, Buffer.concat([u16(1), u16(3), u16(0x200), u16(0), u16(0), u16(0x041d), u16(0), u16(0), u16(0), Buffer.from([0, 1])])),
      cap(2, Buffer.concat([u16(32), u16(1), u16(1), u16(1), u16(w), u16(h), u16(0), u16(1), u16(1), Buffer.from([0, 0]), u16(1), u16(0)])),
      cap(3, Buffer.concat([Buffer.alloc(16), u32(0), u16(1), u16(20), u16(0), u16(1), u16(0), u16(0x2a), Buffer.alloc(32), u16(0), u16(0), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0)])),
      cap(8, Buffer.concat([u16(1), u16(25), u16(25)])),
      cap(13, Buffer.concat([u16(0x35), u16(0), u32(0x409), u32(4), u32(0), u32(12), Buffer.alloc(64)])),
      cap(15, u32(0)),
      cap(16, Buffer.concat([Buffer.alloc(40), u32(0), u16(0), u16(0)])),
      cap(17, Buffer.concat([u32(0), u16(0), u16(0)])),
      cap(20, Buffer.concat([u32(0), u32(1600)])),
      cap(12, Buffer.concat([u16(0), u16(0)])),
      cap(14, Buffer.concat([u16(1), u16(0)])),
      cap(5, Buffer.concat([u16(0), u16(0), u16(2), u16(2)])),
      cap(7, Buffer.concat([u16(0), u16(0), u16(0), u16(0)])),
      cap(26, u32(0x800000)),
      cap(27, u16(1)),
      cap(28, Buffer.concat([u32(0x52), u32(0)])),
      cap(29, Buffer.from([0])),
      cap(30, u32(2)),
    ];
    const capsBuf = Buffer.concat(caps);
    const src = Buffer.from('MSTSC\0', 'latin1');
    const body = Buffer.concat([u32(this.shareId), u16(0x03ea), u16(src.length), u16(capsBuf.length + 4), src, u16(caps.length), u16(0), capsBuf]);
    this.send(IO_CHANNEL, Buffer.concat([u16(body.length + 6), u16(0x13), u16(this.userId), body]));
    // 마무리: Synchronize, Cooperate, Request Control, Font List
    const data = (t2: number, payload: Buffer) => {
      const total = 18 + payload.length;
      return Buffer.concat([u16(total), u16(0x17), u16(this.userId), u32(this.shareId), Buffer.from([0, 1]), u16(payload.length + 4), Buffer.from([t2, 0]), u16(0), payload]);
    };
    this.send(IO_CHANNEL, data(0x1f, Buffer.concat([u16(1), u16(0x03ea)])));
    this.send(IO_CHANNEL, data(0x14, Buffer.concat([u16(4), u16(0), u32(0)])));
    this.send(IO_CHANNEL, data(0x14, Buffer.concat([u16(1), u16(0), u32(0)])));
    this.send(IO_CHANNEL, data(0x27, Buffer.concat([u16(0), u16(0), u16(3), u16(0x32)])));
    this.active = true;
  }

  // ── 고정 가상 채널(drdynvc) 조각 모으기 ──
  private staticVc(ch: number, d: Buffer, done: (m: Buffer) => void) {
    const total = d.readUInt32LE(0), flags = d.readUInt32LE(4);
    const chunk = d.subarray(8);
    if (flags & 1) this.vcBuf.set(ch, []);
    const parts = this.vcBuf.get(ch) ?? [];
    parts.push(chunk);
    if (flags & 2) {
      this.vcBuf.delete(ch);
      const msg = Buffer.concat(parts);
      if (msg.length === total) done(msg);
    } else this.vcBuf.set(ch, parts);
  }

  private sendVc(name: string, data: Buffer) {
    const ch = this.channels.get(name);
    if (!ch) return;
    for (let o = 0; o < data.length || o === 0; o += 1600) {
      const part = data.subarray(o, o + 1600);
      const flags = (o === 0 ? 1 : 0) | (o + 1600 >= data.length ? 2 : 0);
      this.send(ch, Buffer.concat([u32(data.length), u32(flags), part]));
      if (!data.length) break;
    }
  }

  // ── 동적 채널 ──
  private idLen(cb: number) { return cb === 0 ? 1 : cb === 1 ? 2 : 4; }
  private readId(d: Buffer, o: number, cb: number) { return cb === 0 ? d[o] : cb === 1 ? d.readUInt16LE(o) : d.readUInt32LE(o); }
  private writeId(id: number): [number, Buffer] { return id < 256 ? [0, Buffer.from([id])] : id < 65536 ? [1, u16(id)] : [2, u32(id)]; }

  private dvc(d: Buffer) {
    const cmd = d[0] >> 4, sp = (d[0] >> 2) & 3, cb = d[0] & 3;
    if (cmd === 5) { // 능력
      const ver = d.readUInt16LE(2);
      this.sendVc('drdynvc', Buffer.concat([Buffer.from([0x50, 0]), u16(Math.min(ver, 2))]));
      return;
    }
    const id = this.readId(d, 1, cb);
    let o = 1 + this.idLen(cb);
    if (cmd === 1) { // 만들기
      const name = d.subarray(o, d.indexOf(0, o)).toString('latin1');
      const ok = name === GFX_NAME;
      const [c, idb] = this.writeId(id);
      this.sendVc('drdynvc', Buffer.concat([Buffer.from([0x10 | c]), idb, u32(ok ? 0 : 0xc0000001)]));
      if (ok) { this.dvcGfx = id; this.gfxCaps(); }
      return;
    }
    if (cmd === 2) { // 첫 조각
      const total = sp === 0 ? d[o] : sp === 1 ? d.readUInt16LE(o) : d.readUInt32LE(o);
      o += this.idLen(sp);
      const part = d.subarray(o);
      if (part.length >= total) return this.dvcMessage(id, part);
      this.dvcBuf.set(id, { total, parts: [Buffer.from(part)], got: part.length });
      return;
    }
    if (cmd === 3) {
      const part = d.subarray(o);
      const b = this.dvcBuf.get(id);
      if (!b) return this.dvcMessage(id, part);
      b.parts.push(Buffer.from(part));
      b.got += part.length;
      if (b.got >= b.total) { this.dvcBuf.delete(id); this.dvcMessage(id, Buffer.concat(b.parts)); }
      return;
    }
    if (cmd === 4) { if (id === this.dvcGfx) this.dvcGfx = -1; return; }
    if (cmd === 6 || cmd === 7) this.log('압축된 동적 채널 데이터(지원 안 함)');
  }

  private sendDvc(id: number, data: Buffer) {
    const [c, idb] = this.writeId(id);
    this.sendVc('drdynvc', Buffer.concat([Buffer.from([0x30 | c]), idb, data]));
  }

  private dvcMessage(id: number, data: Buffer) {
    if (id !== this.dvcGfx) return;
    this.gfx(this.zgfx.decode(data));
  }

  // ── 그래픽 파이프라인 ──
  private gfxCaps() {
    const set = (v: number, f: number) => Buffer.concat([u32(v), u32(4), u32(f)]);
    const sets = [set(0x000a0002, 0x20), set(0x00080105, 0), set(0x00080004, 0)];
    const body = Buffer.concat([u16(sets.length), ...sets]);
    this.sendDvc(this.dvcGfx, Buffer.concat([u16(0x12), u16(0), u32(body.length + 8), body]));
  }

  private gfx(d: Buffer) {
    for (let o = 0; o + 8 <= d.length;) {
      const cmd = d.readUInt16LE(o), len = d.readUInt32LE(o + 4);
      if (len < 8) break;
      const p = d.subarray(o, o + len);
      try { this.gfxPdu(cmd, p); } catch (e) { this.log(`그래픽 PDU 0x${cmd.toString(16)} 오류: ${(e as Error).message}`); }
      o += len;
    }
  }

  private gfxPdu(cmd: number, p: Buffer) {
    switch (cmd) {
      case 0x0e: { // ResetGraphics
        this.resize(p.readUInt32LE(8), p.readUInt32LE(12));
        break;
      }
      case 0x09: { // CreateSurface
        const id = p.readUInt16LE(8), w = p.readUInt16LE(10), h = p.readUInt16LE(12);
        this.surfaces.set(id, { w, h, buf: Buffer.alloc(w * h * 4), ox: 0, oy: 0, mapped: false });
        break;
      }
      case 0x0a: this.surfaces.delete(p.readUInt16LE(8)); break;
      case 0x0f: { // MapSurfaceToOutput
        const s = this.surfaces.get(p.readUInt16LE(8));
        if (s) { s.ox = p.readUInt32LE(12); s.oy = p.readUInt32LE(16); s.mapped = true; }
        break;
      }
      case 0x0c: { // EndFrame → 확인
        const frameId = p.readUInt32LE(8);
        this.frames++;
        this.sendDvc(this.dvcGfx, Buffer.concat([u16(0x0d), u16(0), u32(20), u32(0), u32(frameId), u32(this.frames)]));
        break;
      }
      case 0x02: { // WireToSurface2
        const s = this.surfaces.get(p.readUInt16LE(8));
        const codec = p.readUInt16LE(10), dl = p.readUInt32LE(17);
        if (s && codec === 0x0009) {
          const rects = decodeProgressive(p.subarray(21, 21 + dl), s.buf, s.w * 4, s.w, s.h);
          this.compose(s, rects);
        }
        break;
      }
      case 0x01: { // WireToSurface1
        const s = this.surfaces.get(p.readUInt16LE(8));
        const codec = p.readUInt16LE(10);
        const l = p.readUInt16LE(13), t = p.readUInt16LE(15), r = p.readUInt16LE(17), b = p.readUInt16LE(19);
        const dl = p.readUInt32LE(21), data = p.subarray(25, 25 + dl);
        if (s && codec === 0) {
          const w = r - l;
          for (let y = 0; y < b - t; y++) data.copy(s.buf, ((t + y) * s.w + l) * 4, y * w * 4, (y + 1) * w * 4);
          this.compose(s, [[l, t, w, b - t]]);
        } else if (s) this.log(`모르는 코덱 0x${codec.toString(16)}`);
        break;
      }
      case 0x04: { // SolidFill
        const s = this.surfaces.get(p.readUInt16LE(8));
        if (!s) break;
        const px = p.subarray(10, 14), n = p.readUInt16LE(14);
        const rects: number[][] = [];
        for (let i = 0; i < n; i++) {
          const q = 16 + i * 8, l = p.readUInt16LE(q), t = p.readUInt16LE(q + 2), r = Math.min(s.w, p.readUInt16LE(q + 4)), b = Math.min(s.h, p.readUInt16LE(q + 6));
          for (let y = t; y < b; y++) for (let x = l; x < r; x++) { const o = (y * s.w + x) * 4; s.buf[o] = px[0]; s.buf[o + 1] = px[1]; s.buf[o + 2] = px[2]; s.buf[o + 3] = 255; }
          rects.push([l, t, r - l, b - t]);
        }
        this.compose(s, rects);
        break;
      }
      case 0x05: { // SurfaceToSurface
        const src = this.surfaces.get(p.readUInt16LE(8)), dst = this.surfaces.get(p.readUInt16LE(10));
        if (!src || !dst) break;
        const l = p.readUInt16LE(12), t = p.readUInt16LE(14), w = p.readUInt16LE(16) - l, h = p.readUInt16LE(18) - t;
        const tmp = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) src.buf.copy(tmp, y * w * 4, ((t + y) * src.w + l) * 4, ((t + y) * src.w + l + w) * 4);
        const n = p.readUInt16LE(20);
        const rects: number[][] = [];
        for (let i = 0; i < n; i++) {
          const dx = p.readUInt16LE(22 + i * 4), dy = p.readUInt16LE(24 + i * 4);
          for (let y = 0; y < h && dy + y < dst.h; y++) tmp.copy(dst.buf, ((dy + y) * dst.w + dx) * 4, y * w * 4, y * w * 4 + Math.min(w, dst.w - dx) * 4);
          rects.push([dx, dy, w, h]);
        }
        this.compose(dst, rects);
        break;
      }
      case 0x06: { // SurfaceToCache
        const s = this.surfaces.get(p.readUInt16LE(8));
        if (!s) break;
        const slot = p.readUInt16LE(18), l = p.readUInt16LE(20), t = p.readUInt16LE(22), w = p.readUInt16LE(24) - l, h = p.readUInt16LE(26) - t;
        const buf = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) s.buf.copy(buf, y * w * 4, ((t + y) * s.w + l) * 4, ((t + y) * s.w + l + w) * 4);
        this.cache.set(slot, { w, h, buf });
        break;
      }
      case 0x07: { // CacheToSurface
        const c = this.cache.get(p.readUInt16LE(8)), s = this.surfaces.get(p.readUInt16LE(10));
        if (!c || !s) break;
        const n = p.readUInt16LE(12);
        const rects: number[][] = [];
        for (let i = 0; i < n; i++) {
          const dx = p.readUInt16LE(14 + i * 4), dy = p.readUInt16LE(16 + i * 4);
          for (let y = 0; y < c.h && dy + y < s.h; y++) c.buf.copy(s.buf, ((dy + y) * s.w + dx) * 4, y * c.w * 4, y * c.w * 4 + Math.min(c.w, s.w - dx) * 4);
          rects.push([dx, dy, c.w, c.h]);
        }
        this.compose(s, rects);
        break;
      }
      case 0x08: this.cache.delete(p.readUInt16LE(8)); break;
    }
  }

  private resize(w: number, h: number) {
    if (w === this.width && h === this.height && this.fb.length) { this.ready(); return; }
    this.width = w;
    this.height = h;
    this.fb = Buffer.alloc(w * h * 4);
    this.ready();
  }

  /** 출력에 묶인 표면의 바뀐 곳을 화면으로 */
  private compose(s: Surface, rects: number[][]) {
    if (!s.mapped || !this.fb.length) return;
    for (const [x, y, w, h] of rects) {
      const x0 = Math.max(0, x), y0 = Math.max(0, y);
      const x1 = Math.min(s.w, x + w, this.width - s.ox), y1 = Math.min(s.h, y + h, this.height - s.oy);
      if (x1 <= x0) continue;
      for (let yy = y0; yy < y1; yy++) s.buf.copy(this.fb, ((s.oy + yy) * this.width + s.ox + x0) * 4, (yy * s.w + x0) * 4, (yy * s.w + x1) * 4);
    }
  }

  // ── 입력(빠른 경로) ──
  private input(events: Buffer[]) {
    if (!this.active || this.closedErr) return;
    const body = Buffer.concat(events);
    const n = events.length;
    const head = n < 16 ? n << 2 : 0;
    const extra = n < 16 ? Buffer.alloc(0) : Buffer.from([n]);
    const total = 1 + body.length + extra.length;
    const lenB = total + 1 < 0x80 ? Buffer.from([total + 1]) : Buffer.from([0x80 | ((total + 2) >> 8), (total + 2) & 255]);
    this.sock.write(Buffer.concat([Buffer.from([head]), lenB, extra, body]));
  }

  private mouse(flags: number, x: number, y: number) {
    const cx = Math.max(0, Math.min(this.width - 1, Math.round(x))), cy = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    return Buffer.concat([Buffer.from([1 << 5]), u16(flags), u16(cx), u16(cy)]);
  }

  pointer(x: number, y: number) { this.input([this.mouse(0x0800, x, y)]); }

  /** b: 0 왼 1 오른 2 가운데 */
  button(x: number, y: number, b: number, down: boolean) {
    const bit = [0x1000, 0x2000, 0x4000][b] ?? 0x1000;
    this.input([this.mouse(0x0800, x, y), this.mouse(bit | (down ? 0x8000 : 0), x, y)]);
  }

  /** dy: 120 = 위로 한 칸 */
  wheel(x: number, y: number, dy: number) {
    const ev: Buffer[] = [this.mouse(0x0800, x, y)];
    const steps = Math.max(1, Math.min(10, Math.floor(Math.abs(dy) / 120) || 1));
    for (let i = 0; i < steps; i++) ev.push(this.mouse(0x0200 | (dy < 0 ? 0x0100 | 0x0088 : 0x0078), x, y));
    this.input(ev);
  }

  scancode(code: number, extended: boolean, down: boolean) {
    this.input([Buffer.from([(0 << 5) | (down ? 0 : 1) | (extended ? 2 : 0), code])]);
  }

  unicode(ch: number, down: boolean) {
    this.input([Buffer.concat([Buffer.from([(4 << 5) | (down ? 0 : 1)]), u16(ch)])]);
  }

  /**
   * 글자 그대로 넣기. 자판에 있는 글자(영문·숫자·기호)는 유니코드 키로,
   * 없는 글자(한글 등)는 GTK·ibus 의 유니코드 입력(Ctrl+Shift+U, 16진수, 스페이스)으로.
   * GNOME 은 자판에 없는 글자의 유니코드 키를 버리고, 클립보드는 GNOME 원격 데스크톱 50 이 한글을 이스케이프 글자로 바꿔서 이 길을 쓴다(2026-11-12 확인).
   */
  typeText(text: string) {
    const hexKey: Record<string, number> = { a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21 };
    const tap = (sc: number) => { this.scancode(sc, false, true); this.scancode(sc, false, false); };
    for (const ch of text.replace(/\r/g, '')) {
      const cp = ch.codePointAt(0)!;
      if (ch === '\n') { tap(0x1c); continue; }
      if (cp >= 0x20 && cp <= 0x7e) { this.unicode(cp, true); this.unicode(cp, false); continue; }
      this.scancode(0x1d, false, true); this.scancode(0x2a, false, true); tap(0x16);
      this.scancode(0x2a, false, false); this.scancode(0x1d, false, false);
      for (const h of cp.toString(16)) tap(h >= '0' && h <= '9' ? (h === '0' ? 0x0b : 1 + Number(h)) : hexKey[h]);
      tap(0x39);
    }
  }
}

/** 윈도우 가상 키 → [스캔코드, 확장] */
export const SCANCODE: Record<number, [number, boolean]> = (() => {
  const m: Record<number, [number, boolean]> = {};
  const letters = 'QWERTYUIOP'.split('').map((c, i) => [c, 0x10 + i] as const)
    .concat('ASDFGHJKL'.split('').map((c, i) => [c, 0x1e + i] as const))
    .concat('ZXCVBNM'.split('').map((c, i) => [c, 0x2c + i] as const));
  for (const [c, s] of letters) m[c.charCodeAt(0)] = [s, false];
  for (let i = 1; i <= 9; i++) m[48 + i] = [1 + i, false];
  m[48] = [0x0b, false];
  const plain: [number, number][] = [[8, 0x0e], [9, 0x0f], [13, 0x1c], [16, 0x2a], [160, 0x2a], [161, 0x36], [17, 0x1d], [162, 0x1d], [18, 0x38], [164, 0x38],
    [20, 0x3a], [27, 0x01], [32, 0x39], [106, 0x37], [107, 0x4e], [109, 0x4a], [110, 0x53], [144, 0x45], [145, 0x46],
    [186, 0x27], [187, 0x0d], [188, 0x33], [189, 0x0c], [190, 0x34], [191, 0x35], [192, 0x29], [219, 0x1a], [220, 0x2b], [221, 0x1b], [222, 0x28],
    [21, 0x72], [25, 0x71]];
  for (const [v, s] of plain) m[v] = [s, false];
  const ext: [number, number][] = [[163, 0x1d], [165, 0x38], [33, 0x49], [34, 0x51], [35, 0x4f], [36, 0x47], [37, 0x4b], [38, 0x48], [39, 0x4d], [40, 0x50],
    [44, 0x37], [45, 0x52], [46, 0x53], [91, 0x5b], [92, 0x5c], [93, 0x5d], [111, 0x35]];
  for (const [v, s] of ext) m[v] = [s, true];
  const np = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49];
  np.forEach((s, i) => { m[96 + i] = [s, false]; });
  for (let i = 0; i < 10; i++) m[112 + i] = [0x3b + i, false];
  m[122] = [0x57, false];
  m[123] = [0x58, false];
  return m;
})();
