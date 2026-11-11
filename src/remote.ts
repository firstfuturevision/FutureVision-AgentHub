import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';

/**
 * 원격 접속(사무실 네트워크만) — 같은 망의 다른 PC·폰에서 공용 비밀번호로 들어온다.
 *  - 끄면(기본) 이 PC 에서만(127.0.0.1). 켜면 사설 주소(192.168·10·172.16-31·169.254, fe80·fc/fd)의 접속만 받는 서버를 하나 더 연다.
 *  - 비밀번호는 scrypt 해시로만 저장(data/remote.json). 로그인하면 이 서버가 기억하는 쿠키(다시 켜면 다시 로그인).
 *  - 원격 사람은 작업만 한다. 설정·키·자동 실행은 PC 앞에서만.
 *    권한 묻지 않기 켜기·뿌리 밖 폴더·터미널은 "PC 앞과 같은 권한"(full)을 켰을 때만 원격에도 된다(기본 꺼짐).
 */
interface Saved { enabled: boolean; full: boolean; port: number; salt?: string; hash?: string }
export interface RemoteSession { name: string; ip: string; at: number }

const DAY = 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
/** 가상 네트워크 어댑터 이름(VMware·VirtualBox·Hyper-V·WSL·Docker·VPN) */
const VIRTUAL_NIC = /vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|hamachi|tailscale|zerotier|wireguard|tap-|tun\d|utun|loopback/i;

/** 사설·자기 주소인가(인터넷 주소는 받지 않는다) */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '').toLowerCase();
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  return /^(fe8|fe9|fea|feb|fc|fd)/.test(a); // 링크 로컬·고유 로컬
}

export class RemoteAccess {
  private file: string;
  private s: Saved;
  private sessions = new Map<string, RemoteSession>();
  private fails = new Map<string, { n: number; until: number }>();

  constructor(file: string, defaultPort: number) {
    this.file = file;
    let v: Partial<Saved> = {};
    try { if (existsSync(file)) v = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    const port = Number(v.port);
    this.s = {
      enabled: v.enabled === true && typeof v.hash === 'string',
      full: v.full === true,
      port: Number.isInteger(port) && port > 1024 && port < 65536 ? port : defaultPort,
      ...(typeof v.salt === 'string' && typeof v.hash === 'string' ? { salt: v.salt, hash: v.hash } : {}),
    };
  }

  get enabled() { return this.s.enabled; }
  get port() { return this.s.port; }
  get full() { return this.s.enabled && this.s.full; }

  /** 화면에 보낼 상태(비밀번호는 있는지만) */
  public() {
    return { enabled: this.s.enabled, full: this.s.full, port: this.s.port, hasPassword: Boolean(this.s.hash), urls: this.urls(), people: this.sessions.size };
  }

  /** 이 PC 의 사설 주소로 만든 접속 주소들(가상 머신·VPN 용 가상 네트워크는 빼고 — 사무실 PC·폰은 그 주소로 못 들어온다) */
  urls(): string[] {
    const out: string[] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (VIRTUAL_NIC.test(name)) continue;
      for (const n of list ?? []) {
        if (n.family === 'IPv4' && !n.internal && isPrivateAddress(n.address)) out.push(`http://${n.address}:${this.s.port}`);
      }
    }
    return out;
  }

  /** 켜기·끄기·비밀번호 바꾸기. 비밀번호를 바꾸거나 끄면 들어와 있던 사람은 모두 나간다 */
  set(v: { enabled?: unknown; password?: unknown; full?: unknown }) {
    if (typeof v.full === 'boolean') this.s.full = v.full;
    if (typeof v.password === 'string' && v.password !== '') {
      if (v.password.length < 8) throw new Error('비밀번호는 8자 이상');
      const salt = randomBytes(16).toString('hex');
      this.s.salt = salt;
      this.s.hash = scryptSync(v.password, salt, 32).toString('hex');
      this.sessions.clear();
    }
    if (typeof v.enabled === 'boolean') {
      if (v.enabled && !this.s.hash) throw new Error('비밀번호를 먼저 정하세요');
      this.s.enabled = v.enabled;
      if (!v.enabled) this.sessions.clear();
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** 로그인 — 맞으면 쿠키 토큰. 한 주소에서 5번 틀리면 1분 막는다 */
  login(password: unknown, name: unknown, ip: string): string {
    if (!this.s.enabled || !this.s.hash || !this.s.salt) throw new Error('원격 접속이 꺼져 있음');
    const f = this.fails.get(ip);
    if (f && f.until > Date.now()) throw new Error('여러 번 틀려서 잠시 막힘. 1분 뒤에 다시');
    const given = scryptSync(typeof password === 'string' ? password : '', this.s.salt, 32);
    if (!timingSafeEqual(given, Buffer.from(this.s.hash, 'hex'))) {
      const n = (f && f.until <= Date.now() && f.n >= MAX_FAILS ? 0 : f?.n ?? 0) + 1;
      this.fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      throw new Error('비밀번호가 맞지 않음');
    }
    this.fails.delete(ip);
    const token = randomBytes(24).toString('hex');
    const who = typeof name === 'string' ? name.trim().replace(/[\x00-\x1f]/g, '').slice(0, 20) : '';
    this.sessions.set(token, { name: who || ip, ip, at: Date.now() });
    return token;
  }

  /** 쿠키 → 들어와 있는 사람(7일 지나면 다시 로그인) */
  who(cookie: string | undefined): RemoteSession | undefined {
    if (!this.s.enabled) return undefined;
    const token = cookie?.split(/;\s*/).find((c) => c.startsWith('ahs='))?.slice(4);
    const s = token ? this.sessions.get(token) : undefined;
    if (!s) return undefined;
    if (Date.now() - s.at > 7 * DAY) { this.sessions.delete(token!); return undefined; }
    return s;
  }

  logout(cookie: string | undefined) {
    const token = cookie?.split(/;\s*/).find((c) => c.startsWith('ahs='))?.slice(4);
    if (token) this.sessions.delete(token);
  }
}
