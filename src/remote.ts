import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname } from 'node:path';

/**
 * 원격 접속(사무실 네트워크만) — 같은 망의 다른 PC·폰에서 이 PC 화면과 똑같이 쓴다.
 *  - 끄면(기본) 이 PC 에서만(127.0.0.1). 켜면 사설 주소(192.168·10·172.16-31·169.254, fe80·fc/fd)의 접속만 받는 서버를 하나 더 연다.
 *  - 비밀번호도 권한 구분도 없다(사용자 결정 2026-11-12: "구분하지 말고"). 같은 네트워크의 누구나 이 PC 앞과 같은 권한.
 *  - 그래서 문은 둘: 인터넷 주소는 받지 않고(isPrivateAddress), Host 는 이 PC 의 주소·이름이어야 한다(isOwnHost, DNS 리바인딩 차단).
 *  - 켜져 있으면 이 PC 화면도 사무실 주소로 연다(127.0.0.1 → 302).
 */
interface Saved { enabled: boolean; port: number }

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

/**
 * Host 머리말이 이 PC 를 가리키는가 — 이 PC 의 주소(127.0.0.1·네트워크 주소)나 컴퓨터 이름, 그리고 원격 포트.
 * 다른 이름이면 받지 않는다: 남의 사이트가 자기 이름을 이 PC 주소로 바꿔 사람 브라우저로 들어오는 것(DNS 리바인딩)을 막는다.
 */
export function isOwnHost(host: string | undefined, port: number): boolean {
  const h = (host ?? '').toLowerCase();
  const i = h.lastIndexOf(':');
  if (i < 0 || h.slice(i + 1) !== String(port)) return false;
  const name = h.slice(0, i).replace(/^\[|\]$/g, '');
  const me = hostname().toLowerCase();
  if (name === 'localhost' || name === me || name === `${me}.local`) return true;
  for (const list of Object.values(networkInterfaces())) for (const n of list ?? []) if (n.address.toLowerCase() === name) return true;
  return false;
}

export class RemoteAccess {
  private file: string;
  private s: Saved;

  constructor(file: string, defaultPort: number) {
    this.file = file;
    let v: Partial<Saved> = {};
    try { if (existsSync(file)) v = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    const port = Number(v.port);
    this.s = {
      enabled: v.enabled === true,
      port: Number.isInteger(port) && port > 1024 && port < 65536 ? port : defaultPort,
    };
  }

  get enabled() { return this.s.enabled; }
  get port() { return this.s.port; }

  /** 화면에 보낼 상태 */
  public() {
    return { enabled: this.s.enabled, port: this.s.port, urls: this.urls() };
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

  /** 켜기·끄기 */
  set(v: { enabled?: unknown }) {
    if (typeof v.enabled === 'boolean') this.s.enabled = v.enabled;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
