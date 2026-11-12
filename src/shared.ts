import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parsePreset, type Preset, type PresetStore } from './presets.ts';
import { parseWorkPreset, type WorkPreset, type WorkPresetStore } from './workpresets.ts';
import { parseTool, type Tool, type ToolStore } from './tools.ts';
import { readSkills, type HubSkillStore } from './hubskills.ts';

/**
 * 공유 레포 — 프리셋·에이전트·스킬·툴을 회사 GitHub 레포로 주고받는다.
 *  - 받기: 레포를 data/shared/repo 에 받아(git, 연동의 GitHub 로그인) 켠 종류만 각 저장소에 "공유본"으로 끼운다.
 *          공유본은 읽기 전용이고 같은 이름이면 이긴다(이 PC 것은 "(내 것)"·-mine 을 붙여 남긴다).
 *  - 올리기: 이 PC 것을 레포 파일로 써서 커밋·푸시하고, 이 PC 것은 공유본으로 갈아끼운다(가리키던 곳도 따라간다).
 *  - 레포 안에서는 서로를 id 가 아니라 이름으로 가리킨다(PC 마다 id 가 다르다). 키·토큰은 올리지 않는다(올리기 전에 검사).
 * 레포 구조: presets/<이름>.json, agents/<이름>.json, tools/<이름>.json, skills/<이름>/SKILL.md
 */
export type SharedKind = 'presets' | 'agents' | 'skills' | 'tools';
export const SHARED_KINDS: SharedKind[] = ['presets', 'agents', 'skills', 'tools'];
const LABEL: Record<SharedKind, string> = { presets: '프리셋', agents: '에이전트', skills: '스킬', tools: '툴' };
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,38}\/[\w.-]{1,100}$/;

interface Saved { repo: string; kinds: Record<SharedKind, boolean>; lastPull?: string; error?: string }

export interface SharedOptions {
  file: string; // 설정: data/shared.json
  dir: string; // 받은 레포: data/shared/repo
  presets: PresetStore; // 에이전트
  workPresets: WorkPresetStore; // 프리셋
  tools: ToolStore;
  skills: HubSkillStore;
  gitEnv?: () => Record<string, string>; // GitHub 로그인(gh 자격 증명)
  author?: () => Promise<string | undefined>; // 커밋에 쓸 GitHub 계정 이름
  remoteUrl?: (repo: string) => string; // 시험용: 로컬 bare 레포
  onChange?: () => void; // 저장소가 바뀜 — 화면이 다시 읽게
}

/** 공유본 id: 종류와 이름으로 정한다(모든 PC 에서 같다) */
export const sharedId = (kind: SharedKind, name: string) => 's' + createHash('sha1').update(`${kind}\n${name.toLowerCase()}`).digest('hex').slice(0, 11);
const fileName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'item';

export class SharedRepo {
  private o: SharedOptions;
  private s: Saved;
  private queue: Promise<unknown> = Promise.resolve();
  private pulling = false;

  constructor(o: SharedOptions) {
    this.o = o;
    let saved: Partial<Saved> = {};
    try { saved = JSON.parse(readFileSync(o.file, 'utf8')); } catch {}
    this.s = {
      repo: typeof saved.repo === 'string' && REPO_RE.test(saved.repo) ? saved.repo : '',
      kinds: Object.fromEntries(SHARED_KINDS.map((k) => [k, saved.kinds?.[k] !== false])) as Record<SharedKind, boolean>,
      lastPull: saved.lastPull,
      error: saved.error,
    };
    // 켤 때는 이미 받아 둔 것부터 끼운다(네트워크 없이). 새로 받기는 tick 에서
    try { this.apply(); } catch {}
  }

  public() {
    const on = this.ready();
    const counts = Object.fromEntries(SHARED_KINDS.map((k) => [k, on && this.s.kinds[k] ? this.names(k).length : 0]));
    return { repo: this.s.repo, kinds: { ...this.s.kinds }, lastPull: this.s.lastPull ?? null, error: this.s.error ?? null, pulling: this.pulling, counts };
  }

  /** 레포·종류 정하기. 레포가 바뀌면 받은 것을 지우고 새로 받는다 */
  set(v: { repo?: unknown; kinds?: unknown }): Promise<void> {
    return this.serial(async () => {
      if (v.repo !== undefined) {
        const repo = String(v.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
        if (repo && !REPO_RE.test(repo)) throw new Error('레포는 "조직/이름" 형식 (예: my-company/agent-hub-shared)');
        if (repo !== this.s.repo) {
          rmSync(this.o.dir, { recursive: true, force: true });
          this.s.repo = repo;
          this.s.lastPull = undefined;
          this.s.error = undefined;
        }
      }
      if (v.kinds && typeof v.kinds === 'object') for (const k of SHARED_KINDS) if (typeof (v.kinds as any)[k] === 'boolean') this.s.kinds[k] = (v.kinds as any)[k];
      this.save();
      if (this.s.repo) await this.fetchAndApply();
      else this.apply();
    });
  }

  /** 지금 받기 */
  pull(): Promise<void> {
    return this.serial(() => this.fetchAndApply());
  }

  /** 정해 둔 레포가 있으면 받는다(켤 때·몇 시간마다). 실패는 상태에만 남긴다 */
  async tick() {
    if (!this.s.repo) return;
    try { await this.pull(); } catch {}
  }

  /** 이 PC 것을 공유 레포에 올린다. 올리면 이 PC 것은 공유본으로 바뀐다 */
  push(kind: SharedKind, id: string): Promise<void> {
    return this.serial(async () => {
      this.needKind(kind);
      await this.fetch();
      const { path, content, name } = this.serialize(kind, id);
      const hit = findSecret(content);
      if (hit) throw new Error(`${hit}로 보이는 값이 있어 올리지 않음. 키·토큰은 빼고 각 PC 의 환경 변수로 넣으세요`);
      const full = join(this.o.dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      await this.commitAndPush([path], `${LABEL[kind]} 공유: ${name}`);
      this.adopt(kind, id, name);
      this.apply();
      this.o.onChange?.();
    });
  }

  /** 공유에서 내린다. 이 PC 에는 내 것으로 남긴다 */
  unshare(kind: SharedKind, id: string): Promise<void> {
    return this.serial(async () => {
      this.needKind(kind);
      await this.fetch();
      const item = this.sharedItem(kind, id);
      if (!item) throw new Error('공유본이 아님');
      const path = this.pathOf(kind, item.name);
      if (!path) throw new Error(`레포에 없음: ${item.name}`);
      rmSync(join(this.o.dir, path), { recursive: true, force: true });
      await this.commitAndPush([path], `${LABEL[kind]} 공유 내림: ${item.name}`);
      this.apply();
      this.keepLocal(kind, id, item);
      this.o.onChange?.();
    });
  }

  // ── 안쪽 ─────────────────────────────

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private ready() {
    return Boolean(this.s.repo) && existsSync(join(this.o.dir, '.git'));
  }

  private needKind(kind: SharedKind) {
    if (!SHARED_KINDS.includes(kind)) throw new Error('알 수 없는 종류');
    if (!this.s.repo) throw new Error('연동에서 공유 레포를 먼저 정하세요');
    if (!this.s.kinds[kind]) throw new Error(`${LABEL[kind]} 공유가 꺼져 있음`);
  }

  private save() {
    mkdirSync(dirname(this.o.file), { recursive: true });
    writeFileSync(`${this.o.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.o.file}.tmp`, this.o.file);
  }

  private git(args: string[]): Promise<string> {
    return new Promise((ok, fail) => {
      execFile('git', args, { env: { ...process.env, ...(this.o.gitEnv?.() ?? {}), GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }, (e, out, err) => {
        if (!e) return ok(String(out));
        const lines = String(err).split('\n').map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l));
        fail(new Error(lines.find((l) => /^(fatal|error|remote):/i.test(l)) ?? lines.at(-1) ?? e.message));
      });
    });
  }

  private remote() {
    return this.o.remoteUrl ? this.o.remoteUrl(this.s.repo) : `https://github.com/${this.s.repo}.git`;
  }

  /** 레포를 받거나 최신으로. 받아 둔 사본은 이 PC 가 고치지 않으므로 원격에 그대로 맞춘다 */
  private async fetch() {
    const d = this.o.dir;
    this.pulling = true;
    try {
      if (!existsSync(join(d, '.git'))) {
        rmSync(d, { recursive: true, force: true });
        mkdirSync(dirname(d), { recursive: true });
        await this.git(['clone', '--depth', '1', this.remote(), d]);
      } else {
        // 아직 아무도 안 올린 빈 레포면 받을 게 없다(fetch 가 실패한다)
        if (!(await this.git(['-C', d, 'ls-remote', '--heads', 'origin'])).trim()) return;
        await this.git(['-C', d, 'fetch', '--depth', '1', 'origin']);
        const head = await this.remoteHead();
        if (head) await this.git(['-C', d, 'reset', '--hard', head]);
        await this.git(['-C', d, 'clean', '-fdq']);
      }
    } finally {
      this.pulling = false;
    }
  }

  /** 원격 기본 브랜치(빈 레포면 null) */
  private async remoteHead(): Promise<string | null> {
    const d = this.o.dir;
    for (let i = 0; i < 2; i++) {
      try { return (await this.git(['-C', d, 'rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim(); } catch {}
      try { await this.git(['-C', d, 'remote', 'set-head', 'origin', '-a']); } catch { return null; }
    }
    return null;
  }

  private async fetchAndApply() {
    try {
      await this.fetch();
      this.s.lastPull = new Date().toISOString();
      this.s.error = undefined;
    } catch (err) {
      this.s.error = `받지 못함: ${(err as Error).message}`;
      this.save();
      throw new Error(this.s.error);
    }
    this.save();
    this.apply();
    this.o.onChange?.();
  }

  private async commitAndPush(paths: string[], message: string) {
    const d = this.o.dir;
    await this.git(['-C', d, 'add', '--all', '--', ...paths]);
    try {
      await this.git(['-C', d, 'diff', '--cached', '--quiet']);
      return; // 바뀐 게 없다(이미 같은 내용)
    } catch {}
    const who = (await this.o.author?.()) || 'agent-hub';
    // 이 명령에만 작성자를 정한다(전역 git 설정은 건드리지 않는다)
    await this.git(['-C', d, '-c', `user.name=${who}`, '-c', `user.email=${who}@users.noreply.github.com`, 'commit', '-q', '-m', message]);
    try {
      await this.git(['-C', d, 'push', '-q', 'origin', 'HEAD']);
    } catch (err) {
      // 못 올렸으면 받아 둔 사본을 원격으로 되돌린다
      const head = await this.remoteHead();
      await this.git(['-C', d, 'reset', '--hard', head ?? 'HEAD~1']).catch(() => {});
      const m = (err as Error).message;
      throw new Error(/403|denied|permission/i.test(m) ? '이 레포에 올릴 권한이 없음 (쓰기 권한이 있는 계정으로 GitHub 로그인)' : `올리지 못함: ${m}`);
    }
    await this.git(['-C', d, 'remote', 'set-head', 'origin', '-a']).catch(() => {}); // 빈 레포에 처음 올렸을 때
  }

  /** 레포의 <종류>/*.json 을 읽는다(깨진 파일은 건너뜀) */
  private readJson(kind: 'presets' | 'agents' | 'tools'): any[] {
    const dir = join(this.o.dir, kind);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
    const out: any[] = [];
    for (const f of files) {
      try {
        const v = JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^﻿/, ''));
        if (v && typeof v.name === 'string' && v.name.trim() && !out.some((x) => x.name.toLowerCase() === v.name.trim().toLowerCase())) out.push({ ...v, name: v.name.trim() });
      } catch {}
    }
    return out;
  }

  private names(kind: SharedKind): string[] {
    return kind === 'skills' ? readSkills(join(this.o.dir, 'skills')).map((s) => s.name) : this.readJson(kind).map((v) => v.name);
  }

  /** 받아 둔 레포를 저장소에 끼운다. 꺼진 종류는 뗀다 */
  private apply() {
    const on = (k: SharedKind) => this.ready() && this.s.kinds[k];
    const { presets, workPresets, tools, skills } = this.o;

    // 툴
    const tl: Tool[] = [];
    for (const v of on('tools') ? this.readJson('tools') : []) {
      const t = parseTool(v, sharedId('tools', v.name));
      if (t && !tl.some((x) => x.name === t.name)) tl.push(t);
    }
    for (const t of tl) tools.renameLocal(t.name);
    tools.setShared(tl);

    // 스킬
    const skillDir = join(this.o.dir, 'skills');
    if (on('skills')) {
      for (const s of readSkills(skillDir)) skills.renameLocal(s.name);
      skills.setSharedDir(skillDir);
    } else skills.setSharedDir(null);

    // 에이전트: 이름 → id (공유본 먼저, 없으면 이 PC 것)
    const agentDefs = on('agents') ? this.readJson('agents') : [];
    for (const v of agentDefs) presets.renameLocal(v.name);
    const localAgents = presets.list().filter((p) => !p.shared);
    const agentId = (name: unknown) => {
      if (typeof name !== 'string') return undefined;
      if (agentDefs.some((v) => v.name.toLowerCase() === name.toLowerCase())) return sharedId('agents', name);
      return localAgents.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id;
    };
    const toolId = (name: unknown) => (typeof name === 'string' ? tools.list().find((t) => t.name === name)?.id : undefined);
    const al: Preset[] = [];
    for (const v of agentDefs) {
      const p = parsePreset({ ...v, agents: refs(v.agents, agentId), tools: refs(v.tools, toolId), autoApprove: false }, sharedId('agents', v.name));
      if (p) al.push(p);
    }
    presets.setShared(al);

    // 프리셋
    const presetDefs = on('presets') ? this.readJson('presets') : [];
    for (const v of presetDefs) workPresets.renameLocal(v.name);
    const pl: WorkPreset[] = [];
    for (const v of presetDefs) {
      const p = parseWorkPreset({ ...v, mainAgent: agentId(v.mainAgent), agents: refs(v.agents, agentId) }, sharedId('presets', v.name));
      if (p) pl.push(p);
    }
    workPresets.setShared(pl);
  }

  /** 레포에 쓸 내용. 서로는 이름으로 가리킨다. 권한 묻지 않기는 올리지 않는다(PC 앞에서만 켜는 설정) */
  private serialize(kind: SharedKind, id: string): { path: string; content: string; name: string } {
    const { presets, workPresets, tools, skills } = this.o;
    const agentName = (x: string) => presets.list().find((p) => p.id === x)?.name;
    const toolName = (x: string) => tools.list().find((t) => t.id === x)?.name;
    const names = (ids: string[] | undefined, f: (x: string) => string | undefined) => (ids ? ids.map(f).filter((n): n is string => Boolean(n)) : undefined);
    const json = (v: object) => JSON.stringify(v, (_k, x) => (x === undefined ? undefined : x), 2) + '\n';
    if (kind === 'agents') {
      const p = presets.list().find((x) => x.id === id && !x.shared);
      if (!p) throw new Error('이 PC 의 에이전트가 아님');
      const v = { name: p.name, agent: p.agent, model: p.model, description: p.description, instructions: p.instructions, agents: names(p.agents, agentName), tools: names(p.tools, toolName), skills: p.skills };
      return { path: `agents/${fileName(p.name)}.json`, content: json(v), name: p.name };
    }
    if (kind === 'presets') {
      const p = workPresets.list().find((x) => x.id === id && !x.shared);
      if (!p) throw new Error('이 PC 의 프리셋이 아님');
      const v = { name: p.name, description: p.description, folder: p.folder, extraDirs: p.extraDirs, guidelines: p.guidelines, mainAgent: p.mainAgent ? agentName(p.mainAgent) : undefined, agents: names(p.agents, agentName) };
      return { path: `presets/${fileName(p.name)}.json`, content: json(v), name: p.name };
    }
    if (kind === 'tools') {
      const t = tools.list().find((x) => x.id === id && !x.shared);
      if (!t) throw new Error('이 PC 의 툴이 아님');
      const v = { name: t.name, type: t.type, url: t.url, command: t.command, args: t.args, description: t.description, enabled: t.enabled };
      return { path: `tools/${fileName(t.name)}.json`, content: json(v), name: t.name };
    }
    const s = skills.list().find((x) => x.name === id && !x.shared);
    if (!s) throw new Error('이 PC 의 스킬이 아님');
    return { path: `skills/${s.name}/SKILL.md`, content: readFileSync(join(skills.dir, s.name, 'SKILL.md'), 'utf8'), name: s.name };
  }

  /** 올린 뒤: 이 PC 것을 지우고, 그것을 가리키던 곳을 공유본으로 */
  private adopt(kind: SharedKind, id: string, name: string) {
    const { presets, workPresets, tools, skills } = this.o;
    const to = sharedId(kind, name);
    if (kind === 'agents') {
      presets.remove(id);
      presets.remap('agents', id, to);
      workPresets.remapAgent(id, to);
    } else if (kind === 'tools') {
      tools.remove(id);
      presets.remap('tools', id, to);
    } else if (kind === 'presets') {
      workPresets.remove(id);
    } else {
      rmSync(join(skills.dir, name), { recursive: true, force: true });
    }
  }

  private sharedItem(kind: SharedKind, id: string): any {
    const { presets, workPresets, tools, skills } = this.o;
    const list: any[] = kind === 'agents' ? presets.list() : kind === 'presets' ? workPresets.list() : kind === 'tools' ? tools.list() : skills.list();
    return list.find((x) => x.shared && (kind === 'skills' ? x.name === id : x.id === id));
  }

  /** 레포 안의 파일 위치(이름이 같은 파일) */
  private pathOf(kind: SharedKind, name: string): string | null {
    if (kind === 'skills') return existsSync(join(this.o.dir, 'skills', name)) ? `skills/${name}` : null;
    const guess = `${kind}/${fileName(name)}.json`;
    if (existsSync(join(this.o.dir, guess))) return guess;
    try {
      for (const f of readdirSync(join(this.o.dir, kind))) {
        try { if (JSON.parse(readFileSync(join(this.o.dir, kind, f), 'utf8')).name?.trim() === name) return `${kind}/${f}`; } catch {}
      }
    } catch {}
    return null;
  }

  /** 내린 뒤: 같은 내용을 이 PC 것으로 저장하고, 공유본을 가리키던 곳을 새 id 로 */
  private keepLocal(kind: SharedKind, oldId: string, item: any) {
    const { presets, workPresets, tools, skills } = this.o;
    const { id: _id, shared: _s, ...rest } = item;
    if (kind === 'skills') {
      skills.save({ name: item.name, description: item.description, body: item.body });
    } else if (kind === 'agents') {
      const p = presets.save(rest);
      presets.remap('agents', oldId, p.id);
      workPresets.remapAgent(oldId, p.id);
    } else if (kind === 'tools') {
      const t = tools.save(rest);
      presets.remap('tools', oldId, t.id);
    } else {
      workPresets.save(rest);
    }
  }
}

/** 이름 목록 → id 목록. 하나도 못 찾으면 제한 없음(undefined) — 골라 둔 것이 모두 없을 때와 같은 규칙 */
function refs(v: unknown, f: (name: unknown) => string | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (!v.length) return [];
  const ids = v.map(f).filter((x): x is string => Boolean(x));
  return ids.length ? ids : undefined;
}

const SECRETS: [RegExp, string][] = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API 키'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub 토큰'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS 키'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'Google API 키'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack 토큰'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '개인 키'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, 'Bearer 토큰'],
  [/[?&](?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|auth|key)=[^&\s"']{8,}/i, '주소에 든 키·토큰'],
  [/--?(?:api[_-]?key|token|secret|password|passwd|access[_-]?token)(?:=|"\s*,\s*")[^\s"']{8,}/i, '명령 인자에 든 키·토큰'],
  [/\b(?:api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}/i, '키·토큰 값'],
];

/** 올리기 전 비밀값 검사 — 걸리면 무엇인지(값은 말하지 않음) */
export function findSecret(text: string): string | null {
  for (const [re, what] of SECRETS) if (re.test(text)) return what;
  return null;
}
