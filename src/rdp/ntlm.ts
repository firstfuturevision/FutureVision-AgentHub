// NTLMv2(MS-NLMP) — CredSSP(NLA) 안에서 쓴다. 확장 세션 보안 + 키 교환 + 봉인.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { md4, Rc4 } from './crypto.ts';

const SIG = Buffer.from('NTLMSSP\0', 'latin1');
// UNICODE | REQUEST_TARGET | SIGN | SEAL | NTLM | ALWAYS_SIGN | EXTENDED_SESSIONSECURITY | VERSION | 128 | KEY_EXCH | 56
const FLAGS = 0xe2088235;
const VERSION = Buffer.from([6, 1, 0xb1, 0x1d, 0, 0, 0, 0x0f]);

const utf16 = (s: string) => Buffer.from(s, 'utf16le');
const hmac = (key: Buffer, ...data: Buffer[]) => { const h = createHmac('md5', key); for (const d of data) h.update(d); return h.digest(); };
const md5 = (...data: Buffer[]) => { const h = createHash('md5'); for (const d of data) h.update(d); return h.digest(); };

export class Ntlm {
  private negotiateMsg = Buffer.alloc(0);
  private challengeMsg = Buffer.alloc(0);
  private sendSign = Buffer.alloc(0);
  private recvSign = Buffer.alloc(0);
  private sendSeal!: Rc4;
  private recvSeal!: Rc4;
  private sendSeq = 0;
  private recvSeq = 0;

  private user: string;
  private password: string;
  private domain: string;

  constructor(user: string, password: string, domain = '') {
    this.user = user;
    this.password = password;
    this.domain = domain;
  }

  negotiate(): Buffer {
    const b = Buffer.alloc(40);
    SIG.copy(b, 0);
    b.writeUInt32LE(1, 8);
    b.writeUInt32LE(FLAGS, 12);
    VERSION.copy(b, 32);
    this.negotiateMsg = b;
    return b;
  }

  /** 서버의 CHALLENGE → AUTHENTICATE */
  authenticate(challenge: Buffer): Buffer {
    this.challengeMsg = challenge;
    if (!challenge.subarray(0, 8).equals(SIG) || challenge.readUInt32LE(8) !== 2) throw new Error('NTLM CHALLENGE 가 아님');
    const flags = (challenge.readUInt32LE(20) & FLAGS) >>> 0;
    const serverChallenge = challenge.subarray(24, 32);
    const tiLen = challenge.readUInt16LE(40), tiOff = challenge.readUInt32LE(44);
    const targetInfo = challenge.subarray(tiOff, tiOff + tiLen);
    // 서버 시각(MsvAvTimestamp=7)이 있으면 그것을 쓴다
    let timestamp: Buffer | null = null;
    for (let o = 0; o + 4 <= targetInfo.length;) {
      const id = targetInfo.readUInt16LE(o), l = targetInfo.readUInt16LE(o + 2);
      if (id === 0) break;
      if (id === 7) timestamp = targetInfo.subarray(o + 4, o + 4 + l);
      o += 4 + l;
    }
    if (!timestamp) {
      timestamp = Buffer.alloc(8);
      const t = BigInt(Date.now() + 11644473600000) * 10000n;
      timestamp.writeBigUInt64LE(t);
    }
    const ntHash = md4(utf16(this.password));
    const responseKey = hmac(ntHash, utf16(this.user.toUpperCase() + this.domain));
    const clientChallenge = randomBytes(8);
    const temp = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), timestamp, clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4)]);
    const ntProof = hmac(responseKey, serverChallenge, temp);
    const ntResponse = Buffer.concat([ntProof, temp]);
    const lmResponse = Buffer.alloc(24); // 시각이 있으면 LM 응답은 0(MS-NLMP 3.3.2)
    const sessionBaseKey = hmac(responseKey, ntProof);
    const exported = randomBytes(16);
    const encryptedKey = new Rc4(sessionBaseKey).update(exported);

    const domain = utf16(this.domain), user = utf16(this.user), ws = utf16('AGENTHUB');
    const fields = [lmResponse, ntResponse, domain, user, ws, encryptedKey];
    const head = Buffer.alloc(72);
    SIG.copy(head, 0);
    head.writeUInt32LE(3, 8);
    let off = 72;
    const fieldPos = [12, 20, 28, 36, 44, 52];
    fields.forEach((f, i) => {
      head.writeUInt16LE(f.length, fieldPos[i]);
      head.writeUInt16LE(f.length, fieldPos[i] + 2);
      head.writeUInt32LE(off, fieldPos[i] + 4);
      off += f.length;
    });
    head.writeUInt32LE(flags, 60);
    VERSION.copy(head, 64);
    // 키
    const magic = (s: string) => Buffer.from(s + '\0', 'latin1');
    this.sendSign = md5(exported, magic('session key to client-to-server signing key magic constant'));
    this.recvSign = md5(exported, magic('session key to server-to-client signing key magic constant'));
    this.sendSeal = new Rc4(md5(exported, magic('session key to client-to-server sealing key magic constant')));
    this.recvSeal = new Rc4(md5(exported, magic('session key to server-to-client sealing key magic constant')));
    return Buffer.concat([head, ...fields]);
  }

  /** 봉인: 서명(16) + 암호문 */
  seal(msg: Buffer): Buffer {
    const seq = Buffer.alloc(4);
    seq.writeUInt32LE(this.sendSeq++);
    const mac = hmac(this.sendSign, seq, msg).subarray(0, 8);
    const enc = this.sendSeal.update(msg);
    const sig = Buffer.concat([Buffer.from([1, 0, 0, 0]), this.sendSeal.update(mac), seq]);
    return Buffer.concat([sig, enc]);
  }

  unseal(data: Buffer): Buffer {
    const sig = data.subarray(0, 16), enc = data.subarray(16);
    const msg = this.recvSeal.update(enc);
    const mac = this.recvSeal.update(sig.subarray(4, 12));
    const seq = Buffer.alloc(4);
    seq.writeUInt32LE(this.recvSeq++);
    if (!hmac(this.recvSign, seq, msg).subarray(0, 8).equals(mac)) throw new Error('NTLM 서명이 맞지 않음');
    return msg;
  }
}
