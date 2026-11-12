// CredSSP(MS-CSSP) — NLA. TLS 위에서 TSRequest 를 주고받아 NTLM 으로 인증하고 비밀번호를 봉인해 넘긴다.
import { createHash, randomBytes } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { Ntlm } from './ntlm.ts';

// ── DER ──
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.from([0x83, n >> 16, (n >> 8) & 255, n & 255]);
}
export const der = (tag: number, ...content: Buffer[]) => { const c = Buffer.concat(content); return Buffer.concat([Buffer.from([tag]), len(c.length), c]); };
const seq = (...c: Buffer[]) => der(0x30, ...c);
const ctx = (n: number, ...c: Buffer[]) => der(0xa0 + n, ...c);
const octet = (b: Buffer) => der(0x04, b);
const int = (n: number) => { const b: number[] = []; let v = n; do { b.unshift(v & 255); v >>= 8; } while (v > 0); if (b[0] & 0x80) b.unshift(0); return der(0x02, Buffer.from(b)); };

/** DER 하나 풀기: [태그, 내용, 다음 위치] */
function read(b: Buffer, o: number): [number, Buffer, number] {
  const tag = b[o];
  let l = b[o + 1], p = o + 2;
  if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = l * 256 + b[p++]; }
  return [tag, b.subarray(p, p + l), p + l];
}

interface TsRequest { version: number; nego?: Buffer; pubKeyAuth?: Buffer; error?: number }

function parseTs(b: Buffer): TsRequest {
  const [, body] = read(b, 0);
  const out: TsRequest = { version: 0 };
  for (let o = 0; o < body.length;) {
    const [tag, c, next] = read(body, o);
    o = next;
    if (tag === 0xa0) out.version = read(c, 0)[1].reduce((v, x) => v * 256 + x, 0);
    else if (tag === 0xa1) { // negoTokens: SEQ OF SEQ { [0] OCTET }
      const [, list] = read(c, 0);
      const [, item] = read(list, 0);
      const [, t0] = read(item, 0);
      out.nego = read(t0, 0)[1];
    } else if (tag === 0xa3) out.pubKeyAuth = read(c, 0)[1];
    else if (tag === 0xa4) out.error = read(c, 0)[1].reduce((v, x) => v * 256 + x, 0) | 0;
  }
  return out;
}

const VERSION = 6;

/** TLS 위 DER 메시지 하나 받기 */
function reader(sock: TLSSocket) {
  let buf = Buffer.alloc(0);
  const waiters: ((b: Buffer) => void)[] = [];
  const pump = () => {
    while (waiters.length && buf.length >= 2) {
      let l = buf[1], h = 2;
      if (l & 0x80) { const n = l & 0x7f; if (buf.length < 2 + n) return; l = 0; for (let i = 0; i < n; i++) l = l * 256 + buf[2 + i]; h = 2 + n; }
      if (buf.length < h + l) return;
      const m = buf.subarray(0, h + l);
      buf = buf.subarray(h + l);
      waiters.shift()!(m);
    }
  };
  const onData = (d: Buffer) => { buf = Buffer.concat([buf, d]); pump(); };
  sock.on('data', onData);
  return {
    next: () => new Promise<Buffer>((ok) => { waiters.push(ok); pump(); }),
    done: () => { sock.off('data', onData); return buf; }, // 남은 바이트(RDP 로 넘긴다)
  };
}

/** NLA. 끝나면 TLS 소켓에 남은 바이트를 돌려준다 */
export async function credssp(sock: TLSSocket, user: string, password: string, domain = ''): Promise<Buffer> {
  const ntlm = new Ntlm(user, password, domain);
  const r = reader(sock);
  const nego = (token: Buffer, extra: Buffer[] = []) => seq(ctx(0, int(VERSION)), ctx(1, seq(seq(ctx(0, octet(token))))), ...extra);

  sock.write(nego(ntlm.negotiate()));
  const ch = parseTs(await r.next());
  if (ch.error) throw new Error(`NLA 오류 0x${(ch.error >>> 0).toString(16)}`);
  if (!ch.nego) throw new Error('NLA: CHALLENGE 없음');
  const auth = ntlm.authenticate(ch.nego);

  // 서버 인증서의 공개 키에 묶기(중간자 방지 — 버전 5+: 해시 + 클라이언트 난수)
  const cert = sock.getPeerX509Certificate();
  if (!cert) throw new Error('서버 인증서 없음');
  const pub = cert.publicKey.export({ type: 'pkcs1', format: 'der' }) as Buffer;
  const nonce = randomBytes(32);
  const peerVersion = ch.version || 2;
  const useHash = peerVersion >= 5;
  const pubKeyAuth = useHash
    ? ntlm.seal(createHash('sha256').update(Buffer.from('CredSSP Client-To-Server Binding Hash\0', 'latin1')).update(nonce).update(pub).digest())
    : ntlm.seal(pub);
  sock.write(nego(auth, [ctx(3, octet(pubKeyAuth)), ...(useHash ? [ctx(5, octet(nonce))] : [])]));

  const pk = parseTs(await r.next());
  if (pk.error) throw new Error(pk.error === -1073741715 /* STATUS_LOGON_FAILURE */ ? '원격 데스크톱 로그인 실패(아이디·비밀번호)' : `NLA 오류 0x${(pk.error >>> 0).toString(16)}`);
  if (!pk.pubKeyAuth) throw new Error('NLA: 서버 확인 없음');
  const got = ntlm.unseal(pk.pubKeyAuth);
  const want = useHash
    ? createHash('sha256').update(Buffer.from('CredSSP Server-To-Client Binding Hash\0', 'latin1')).update(nonce).update(pub).digest()
    : (() => { const p = Buffer.from(pub); p[0] = (p[0] + 1) & 255; return p; })();
  if (!got.equals(want)) throw new Error('NLA: 서버 확인 값이 다름');

  // 비밀번호 넘기기(TSPasswordCreds)
  const u16 = (s: string) => Buffer.from(s, 'utf16le');
  const creds = seq(ctx(0, octet(u16(domain))), ctx(1, octet(u16(user))), ctx(2, octet(u16(password))));
  const tsCreds = seq(ctx(0, int(1)), ctx(1, octet(creds)));
  sock.write(seq(ctx(0, int(VERSION)), ctx(2, octet(ntlm.seal(tsCreds)))));
  return r.done();
}
