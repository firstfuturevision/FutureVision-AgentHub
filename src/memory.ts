import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 모든 작업이 함께 아는 것(설정 → 기억) — AI 가 무엇이든(Claude·Codex·Gemini) 같은 것을 받는다.
 *  - 기억: 사람의 취향·성향·고쳐 준 것. 에이전트가 사람이 결과를 고치거나 "그게 아니라" 할 때 memory_save 로 한 줄씩 남긴다. 두 번 말하지 않게.
 *  - 공통 지침: 사람이 쓰는 글 하나(예: 지시를 받으면 먼저 하는 확인 절차). 회사마다 다른 내용은 여기(이 PC 의 data)에 두고 코드에는 두지 않는다.
 * 작업마다 처음 지시에 전부, 그 뒤로는 새로 생기거나 바뀐 것만 지시 앞에 붙는다(rev 로 센다).
 */
export interface MemoryItem { id: string; text: string; at: string; by: string; rev?: number; scope?: 'company' } // rev: 더하거나 고친 때의 rev. scope: company = 회사 기억(연결된 PC 와 맞춤), 없으면 개인 기억(이 PC 를 쓰는 사람의 취향 — 맞추지 않음)
interface Saved { rev: number; items: MemoryItem[]; guide: string; guideRev: number }

const MAX_ITEMS = 80;
const MAX_TEXT = 300;
/** 기억 전체가 이만큼(글자) 안이면 지시마다 전부 붙인다 — 긴 대화에서 CLI 가 스스로 줄이며 앞에 받은 기억을 잃어도 다음 지시에 다시 받게 */
export const FULL_EVERY_TIME = 3000;
/** 이만큼 차면 남길 때 곧 가득 찬다고 알린다 */
const WARN_ITEMS = MAX_ITEMS - 5;
const MAX_GUIDE = 6000;

export class MemoryStore {
  private file: string;
  private s: Saved = { rev: 0, items: [], guide: '', guideRev: 0 };
  onChange?: () => void;

  constructor(file: string) {
    this.file = file;
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.s = {
          rev: Number(raw.rev) || 0,
          items: (Array.isArray(raw.items) ? raw.items : []).filter((x: any) => typeof x?.text === 'string' && typeof x?.id === 'string').slice(-MAX_ITEMS),
          guide: typeof raw.guide === 'string' ? raw.guide.slice(0, MAX_GUIDE) : '',
          guideRev: Number(raw.guideRev) || 0,
        };
      }
    } catch {}
  }

  public() { return { items: this.s.items, guide: this.s.guide, rev: this.s.rev, guideRev: this.s.guideRev }; }
  get rev() { return this.s.rev; }
  get guideRev() { return this.s.guideRev; }

  add(text: unknown, by: string, scope?: unknown): MemoryItem {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!t) throw new Error('기억할 글이 비어 있음');
    const same = this.s.items.find((x) => x.text === t);
    if (same) return same;
    // 가득 차면 오래된 것을 몰래 버리지 않고 받지 않는다 — 남기는 쪽이 합치거나 지운 뒤 다시
    if (this.s.items.length >= MAX_ITEMS) throw new Error(`기억이 ${MAX_ITEMS}개로 가득 참. 같은 뜻을 합치거나(memory_list 로 보고 memory_delete 뒤 합친 한 줄을 memory_save) 낡은 것을 지운 뒤 다시 남긴다`);
    this.s.rev++;
    const item: MemoryItem = { id: randomUUID().slice(0, 8), text: t, at: new Date().toISOString(), by: String(by).slice(0, 60), rev: this.s.rev, ...(scope === 'company' ? { scope: 'company' as const } : {}) };
    this.s.items = [...this.s.items, item];
    this.save();
    return item;
  }

  edit(id: unknown, text: unknown) {
    const item = this.s.items.find((x) => x.id === id);
    if (!item) throw new Error('없는 기억');
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!t) return this.remove(id);
    this.s.rev++;
    item.text = t;
    item.rev = this.s.rev;
    this.save();
  }

  remove(id: unknown) {
    const n = this.s.items.length;
    this.s.items = this.s.items.filter((x) => x.id !== id);
    if (this.s.items.length === n) throw new Error('없는 기억');
    this.s.rev++;
    this.save();
  }

  /** 회사 기억 ↔ 개인 기억 */
  setScope(id: unknown, scope: unknown) {
    const item = this.s.items.find((x) => x.id === id);
    if (!item) throw new Error('없는 기억');
    if (scope === 'company') item.scope = 'company';
    else delete item.scope;
    this.s.rev++;
    item.rev = this.s.rev;
    this.save();
  }

  /** 연결된 PC 끼리 맞추는 것: 공통 지침과 회사 기억(개인 기억은 빼고) */
  shared() { return { guide: this.s.guide, items: this.s.items.filter((x) => x.scope === 'company').map((x) => ({ text: x.text, at: x.at })) }; }

  /** 남길 때 덧붙일 알림: 곧 가득 참 */
  fullness(): string {
    const n = this.s.items.length;
    return n >= WARN_ITEMS ? ` (기억 ${n}/${MAX_ITEMS}개 — 곧 가득 참. 같은 뜻을 합쳐 줄인다)` : '';
  }

  /**
   * 맞춘 결과로 바꾸기: 공통 지침과 회사 기억을 그대로(같은 글은 그대로 두고), 개인 기억은 건드리지 않는다.
   * dates(글 → 처음 남긴 때): 다른 PC 에서 온 같은 글은 그 날짜를 지킨다(오늘로 바꾸면 "어긋나면 최근 것"을 가릴 수 없다)
   */
  replaceShared(guide: unknown, texts: unknown, by: string, dates?: unknown) {
    const when = (t: string) => {
      const d = dates && typeof dates === 'object' ? (dates as Record<string, unknown>)[t] : undefined;
      return typeof d === 'string' && !Number.isNaN(Date.parse(d)) && Date.parse(d) <= Date.now() + 86_400_000 ? new Date(d).toISOString() : new Date().toISOString();
    };
    const want = [...new Set((Array.isArray(texts) ? texts : []).map((t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)).filter(Boolean))];
    const now = this.s.items.filter((x) => x.scope === 'company').map((x) => x.text);
    const changed = want.length !== now.length || want.some((t) => !now.includes(t));
    if (changed) {
      // 넘치면 아무것도 바꾸지 않고 알린다(개인 기억 + 합친 회사 기억; 같은 글의 개인 기억은 회사 기억으로 바뀐다)
      const personal = this.s.items.filter((x) => x.scope !== 'company');
      const total = personal.length + want.filter((t) => !personal.some((x) => x.text === t)).length;
      if (total > MAX_ITEMS) throw new Error(`합친 결과가 기억 ${MAX_ITEMS}개를 넘음(${total}개, 개인 기억 포함). 같은 뜻을 더 합쳐 다시 맞춘다`);
      this.s.rev++;
      const keep = this.s.items.filter((x) => x.scope !== 'company' || want.includes(x.text));
      const have = new Set(keep.filter((x) => x.scope === 'company').map((x) => x.text));
      for (const t of want) {
        const personal = keep.find((x) => x.text === t && x.scope !== 'company');
        if (personal) { personal.scope = 'company'; personal.rev = this.s.rev; continue; }
        if (!have.has(t)) keep.push({ id: randomUUID().slice(0, 8), text: t, at: when(t), by: String(by).slice(0, 60), rev: this.s.rev, scope: 'company' });
      }
      this.s.items = keep;
    }
    const g = String(guide ?? '').trim().slice(0, MAX_GUIDE);
    if (g !== this.s.guide) { this.s.guide = g; this.s.guideRev++; }
    this.save();
  }

  setGuide(text: unknown) {
    const t = String(text ?? '').trim().slice(0, MAX_GUIDE);
    if (t === this.s.guide) return;
    this.s.guide = t;
    this.s.guideRev++;
    this.save();
  }

  /**
   * 이번 지시 앞에 붙일 것. seen = 그 작업이 지난번에 받은 것(없으면 처음 — 전부).
   * 기억은 전체가 짧으면(FULL_EVERY_TIME 글자 안) 지시마다 전부. 길면 처음이거나 지운 것이 있으면 전부, 아니면 그사이 더하거나 고친 것만. 공통 지침은 바뀌었을 때만.
   */
  noteFor(seen?: { rev: number; guideRev: number; ids: string[] }): { text: string; seen: { rev: number; guideRev: number; ids: string[] } } {
    const parts: string[] = [];
    const ids = this.s.items.map((x) => x.id);
    if (this.s.guide && (!seen || seen.guideRev !== this.s.guideRev)) parts.push(`[공통 지침 — 모든 작업이 따른다]\n${this.s.guide}`);
    const line = (x: MemoryItem) => `- ${x.scope === 'company' ? '(회사) ' : ''}${x.text}`;
    const short = this.s.items.length > 0 && this.s.items.map(line).join('\n').length <= FULL_EVERY_TIME;
    if (!seen || seen.rev !== this.s.rev || short) {
      const all = !seen || short || seen.ids.some((id) => !ids.includes(id));
      const list = all ? this.s.items : this.s.items.filter((x) => (x.rev ?? 0) > seen!.rev);
      if (list.length) parts.push(`[기억 — 회사 규칙과 이 PC 를 쓰는 사람의 취향·고쳐 준 것${all ? (seen ? '(전부, 앞의 기억 대신)' : '') : '(새로 더하거나 고친 것)'}. 두 번 말하게 하지 않는다]\n${list.map(line).join('\n')}`);
      else if (all && seen) parts.push('[기억 — 모두 지워짐. 앞의 기억은 따르지 않는다]');
    }
    return { text: parts.join('\n\n'), seen: { rev: this.s.rev, guideRev: this.s.guideRev, ids } };
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    this.onChange?.();
  }
}
