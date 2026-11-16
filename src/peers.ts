import { createSocket, type Socket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { isPrivateAddress, type RemoteAccess } from './remote.ts';

/**
 * 다른 PC 의 Agent Hub 모으기(왼쪽 "연결"). 사무실 네트워크의 Agent Hub 를 찾아 작업 목록을 모아 보이고, 작업끼리 PC 를 넘어 보낸다.
 *  - 찾기: 원격 접속이 켜진 Agent Hub 는 30초마다 UDP 브로드캐스트(PORT)로 "여기 있음"(이름·원격 포트)을 알린다. 듣는 것은 원격 접속과 상관없이 늘.
 *    방화벽 등으로 안 보이면 주소(http://사설IPv4:포트)를 손으로 더한다(data/peers.json).
 *  - 상대는 그 PC 의 원격 접속 서버(비밀번호 없음, 사무실 네트워크만)다 — 같은 망이면 그 PC 앞과 같은 권한이라 따로 열쇠를 두지 않는다.
 *  - 주소는 사설 IPv4 글자 그대로 + 포트만 받는다(이름·경로 안 됨, 이 PC 자신은 뺌).
 */
export const PEER_PORT = 47317;
const ANNOUNCE_MS = 30_000;
const FORGET_MS = 120_000; // 이만큼 안 들리면 찾은 목록에서 뺀다(손으로 더한 것은 남음)
const TIMEOUT_MS = 3000;

export interface PeerTask { name: string; id: string; status: string; rank?: number; remoteParent?: { url: string; id: string; pc: string }; about?: string; recent?: string; splitFrom?: string; forkedFrom?: string; schedules?: number; doing?: string; since?: number }
export interface PeerSummary { name: string; url?: string; version?: string; tasks: PeerTask[] }
export interface PeerView { url: string; manual: boolean; seenAt?: number; name?: string; ok: boolean; error?: string; summary?: PeerSummary; intake?: { model: string } | null; memory?: { items: number; guide: boolean } | null }

/** "http://192.168.0.5:4319" 꼴만(사설 IPv4 + 포트). 아니면 null */
export function peerUrl(v: unknown): string | null {
  const m = String(v ?? '').trim().match(/^(?:http:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\/?$/i);
  if (!m) return null;
  const port = Number(m[2]);
  if (m[1].split('.').some((x) => Number(x) > 255) || port < 1025 || port > 65535) return null;
  if (!isPrivateAddress(m[1]) || m[1].startsWith('127.') || m[1].startsWith('169.254.')) return null;
  return `http://${m[1]}:${port}`;
}

function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const n of list ?? []) out.add(n.address);
  return out;
}

export class Peers {
  private file: string;
  private manual: string[] = [];
  private found = new Map<string, { name: string; seenAt: number }>();
  private cache = new Map<string, { at: number; view: PeerView }>();
  private sock: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** 이 PC 의 요약(GET /peer/summary 와 같은 것) — main 이 채운다 */
  summary: () => PeerSummary = () => ({ name: hostname(), tasks: [] });

  private remote?: RemoteAccess;

  constructor(file: string, remote?: RemoteAccess) {
    this.file = file;
    this.remote = remote;
    try { if (existsSync(file)) this.manual = (JSON.parse(readFileSync(file, 'utf8')).manual ?? []).map(peerUrl).filter(Boolean); } catch {}
  }

  /** UDP 로 듣고(늘), 원격 접속이 켜져 있으면 알린다 */
  start() {
    try {
      const s = createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => { s.close(); this.sock = null; });
      s.on('message', (buf, rinfo) => this.heard(buf, rinfo.address));
      s.bind(PEER_PORT, () => { try { s.setBroadcast(true); } catch {} this.announce(); });
      this.sock = s;
    } catch {}
    this.timer = setInterval(() => this.announce(), ANNOUNCE_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    try { this.sock?.close(); } catch {}
    this.sock = null;
  }

  private announce() {
    if (!this.sock || !this.remote?.enabled) return;
    const msg = Buffer.from(JSON.stringify({ t: 'agent-hub', v: 1, name: hostname(), port: this.remote.port }));
    try { this.sock.send(msg, PEER_PORT, '255.255.255.255'); } catch {}
  }

  private heard(buf: Buffer, from: string) {
    if (buf.length > 512 || ownAddresses().has(from)) return;
    let m: any;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (m?.t !== 'agent-hub') return;
    const url = peerUrl(`${from}:${Number(m.port)}`);
    if (!url) return;
    this.found.set(url, { name: String(m.name ?? '').slice(0, 60), seenAt: Date.now() });
  }

  /** 모든 상대 주소(손으로 더한 것 + 최근에 들린 것) */
  urls(): string[] {
    const now = Date.now();
    for (const [u, f] of this.found) if (now - f.seenAt > FORGET_MS) this.found.delete(u);
    return [...new Set([...this.manual, ...this.found.keys()])];
  }

  add(v: unknown): string {
    const url = peerUrl(v);
    if (!url) throw new Error('주소는 http://사설IPv4:포트 (그 PC 설정 → 연동 → 원격 접속에 보이는 주소)');
    if (ownAddresses().has(new URL(url).hostname) && Number(new URL(url).port) === this.remote?.port) throw new Error('이 PC 주소입니다');
    if (!this.manual.includes(url)) this.manual.push(url);
    this.save();
    this.cache.delete(url);
    return url;
  }

  remove(v: unknown) {
    const url = peerUrl(v);
    this.manual = this.manual.filter((u) => u !== url);
    if (url) { this.found.delete(url); this.cache.delete(url); }
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ manual: this.manual }, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** 상대 하나의 요약(3초 동안은 다시 묻지 않음 — 화면이 5초마다 읽어 그 PC 작업의 상태가 몇 초 안에 따라오게) */
  async view(url: string, fresh = false): Promise<PeerView> {
    const hit = this.cache.get(url);
    if (!fresh && hit && Date.now() - hit.at < 3_000) return hit.view;
    const base = { url, manual: this.manual.includes(url), seenAt: this.found.get(url)?.seenAt, name: this.found.get(url)?.name };
    let view: PeerView;
    try {
      const r = await fetch(`${url}/peer/summary`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.status === 404) throw new Error('그 PC 의 Agent Hub 가 옛 버전(업데이트 필요)');
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
      const s = (await r.json()) as PeerSummary;
      const tasks = (Array.isArray(s.tasks) ? s.tasks : []).slice(0, 300).map((t) => ({
        name: String(t.name ?? '').slice(0, 120), id: String(t.id ?? '').slice(0, 40), status: String(t.status ?? '').slice(0, 20),
        ...(Number.isFinite(Number(t.rank)) ? { rank: Number(t.rank) } : {}), ...(t.remoteParent && peerUrl(t.remoteParent.url) ? { remoteParent: { url: peerUrl(t.remoteParent.url)!, id: String(t.remoteParent.id).slice(0, 60), pc: String(t.remoteParent.pc ?? '').slice(0, 60) } } : {}), ...(t.about ? { about: String(t.about).slice(0, 500) } : {}), ...(t.recent ? { recent: String(t.recent).slice(0, 120) } : {}),
        ...(t.splitFrom ? { splitFrom: String(t.splitFrom).slice(0, 120) } : {}), ...(t.forkedFrom ? { forkedFrom: String(t.forkedFrom).slice(0, 120) } : {}),
        schedules: Number(t.schedules) || 0,
        ...(t.doing ? { doing: String(t.doing).slice(0, 160) } : {}), ...(Number.isFinite(Number(t.since)) && Number(t.since) > 0 ? { since: Number(t.since) } : {}),
      }));
      // 그 PC 의 입력 세션·기억(옛 버전이면 없음)
      const extra = async (path: string) => { try { const x = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }); return x.ok ? await x.json() : null; } catch { return null; } };
      const [ik, mem] = await Promise.all([extra('/intake'), extra('/memory')]);
      view = { ...base, name: String(s.name ?? base.name ?? '').slice(0, 60), ok: true, summary: { name: String(s.name ?? '').slice(0, 60), version: s.version ? String(s.version).slice(0, 40) : undefined, url, tasks },
        intake: ik && typeof ik.model === 'string' ? { model: ik.model.slice(0, 80) } : null,
        memory: mem && Array.isArray(mem.items) ? { items: mem.items.length, guide: Boolean(mem.guide) } : null };
    } catch (err) {
      const e = err as Error;
      view = { ...base, ok: false, error: e.name === 'TimeoutError' ? '응답 없음(꺼졌거나 원격 접속이 꺼짐)' : e.message.includes('fetch failed') ? '연결 안 됨(꺼졌거나 원격 접속이 꺼짐)' : e.message };
    }
    this.cache.set(url, { at: Date.now(), view });
    return view;
  }

  async all(fresh = false): Promise<PeerView[]> {
    return Promise.all(this.urls().map((u) => this.view(u, fresh)));
  }

  /** "PC이름/작업" 의 PC 찾기: 이름이나 주소(ip:port) */
  async find(pc: string): Promise<PeerView> {
    const k = pc.trim().toLowerCase();
    const views = await this.all();
    const v = views.find((x) => x.ok && (x.name?.toLowerCase() === k || x.url.toLowerCase().endsWith(`//${k}`)));
    if (!v) throw new Error(`연결된 PC 가 아님: ${pc} (있는 PC: ${views.filter((x) => x.ok).map((x) => x.name).join(', ') || '없음'})`);
    return v;
  }

  /** 그 PC 의 /intake·/memory 로 보내기(설정 맞추기) */
  async post(url: string, path: '/intake' | '/memory' | '/peer/parent' | '/peer/share' | '/peer/hello' | '/peer/bye', body: unknown): Promise<unknown> {
    const u = peerUrl(url);
    if (!u) throw new Error('주소가 맞지 않음');
    const r = await fetch(`${u}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
    if (r.status === 404) throw new Error('그 PC 의 Agent Hub 가 옛 버전(업데이트 필요)');
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    this.cache.delete(u);
    return r.json();
  }

  /** 양방향 연결: 주소를 더하거나 빼면 상대에게도 알린다(상대가 이 PC 를 목록에 더하거나 뺀다). 이 PC 원격 접속이 꺼져 있으면 알리지 않는다 */
  async hello(url: string, bye = false): Promise<boolean> {
    if (!this.remote?.enabled) return false;
    try { await this.post(url, bye ? '/peer/bye' : '/peer/hello', { port: this.remote.port, name: hostname() }); return true; } catch { return false; }
  }

  /** 상대가 알려 와서 목록에 더하기·빼기(상대 주소는 요청이 온 IP + 알려 준 원격 포트) */
  greeted(ip: string, port: unknown, bye = false): string | null {
    const url = peerUrl(`${ip.replace(/^::ffff:/i, '')}:${Number(port)}`);
    if (!url) return null;
    if (bye) { if (!this.manual.includes(url)) return null; this.manual = this.manual.filter((u) => u !== url); }
    else { if (this.manual.includes(url)) return null; this.manual.push(url); }
    this.cache.delete(url);
    this.save();
    return url;
  }

  /** 이 PC 의 원격 접속 주소(다른 PC 가 이 PC 로 공유를 보낼 곳). 원격 접속이 꺼져 있으면 없음 */
  myUrl(): string | undefined { return this.remote?.enabled ? this.remote.urls()[0] : undefined; }

  /** 다른 PC 의 위 작업으로 하위 작업 공유 보내기 */
  async shareUp(rp: { url: string; id: string }, body: { fromPc: string; fromId: string; title: string; text: string }) {
    await this.post(rp.url, '/peer/share', { to: rp.id, ...body });
  }

  /** 그 PC 의 작업을 이 PC 작업 아래로(parentId 없으면 풀기) */
  async setParent(url: string, taskId: string, parentId: string | null, myName: string) {
    const me = this.myUrl();
    if (parentId && !me) throw new Error('이 PC 의 원격 접속이 꺼져 있어 그 PC 가 공유를 보낼 곳이 없음(설정 → 연동 → 원격 접속을 켠다)');
    await this.post(url, '/peer/parent', { taskId, parent: parentId ? { url: me, id: parentId, pc: myName } : null });
  }

  /** 그 PC 의 공통 지침·회사 기억(맞추기 비교용) */
  async shared(url: string): Promise<{ guide: string; items: { text: string; at: string }[] } | null> {
    const u = peerUrl(url);
    if (!u) return null;
    try {
      const r = await fetch(`${u}/memory`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) return null;
      const m = (await r.json()) as { guide?: string; items?: { text: string; at: string; scope?: string }[] };
      return { guide: String(m.guide ?? ''), items: (m.items ?? []).filter((x) => x.scope === 'company').map((x) => ({ text: String(x.text), at: String(x.at ?? '') })) };
    } catch { return null; }
  }

  /** 사람이 화면에서 다른 PC 작업들에 보내기(id 로). 보낸 곳은 "Agent Hub <이 PC> · 사람" */
  async sendIds(url: string, ids: string[], text: string): Promise<number> {
    const v = await this.view(peerUrl(url) ?? '', true);
    if (!v.ok) throw new Error(`${v.name || url}: ${v.error}`);
    const known = new Set(v.summary!.tasks.map((t) => t.id));
    let n = 0;
    for (const id of ids.filter((x) => known.has(x))) {
      const r = await fetch(`${v.url}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.message', sessionId: id, text, via: { app: `Agent Hub ${hostname()}`.slice(0, 40), label: '사람' } }),
        signal: AbortSignal.timeout(TIMEOUT_MS * 3),
      });
      if (r.ok) n++;
    }
    this.cache.delete(v.url);
    return n;
  }

  /** 다른 PC 의 작업에 보내기: 그 PC 의 원격 접속으로 user.message, 보낸 곳(via)은 "Agent Hub <이 PC> · 작업 <이름>" */
  async send(pc: string, task: string, text: string, fromTask: string): Promise<string> {
    const v = await this.find(pc);
    const k = task.trim().toLowerCase();
    const t = v.summary!.tasks.find((x) => x.name.toLowerCase() === k || x.id.toLowerCase().startsWith(k));
    if (!t) throw new Error(`${v.name} 에 없는 작업: ${task} (session_list 로 확인)`);
    const id = t.id;
    const r = await fetch(`${v.url}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user.message', sessionId: id, text, via: { app: `Agent Hub ${hostname()}`.slice(0, 40), label: `작업 ${fromTask}`.slice(0, 80) } }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
    if (!r.ok) throw new Error(`${v.name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    this.cache.delete(v.url);
    return `${v.name} 의 ${t.name} 에 보냄`;
  }
}
