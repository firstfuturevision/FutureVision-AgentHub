import type { HostEvent, SessionInfo } from '../protocol.ts';
import type { Tool } from '../tools.ts';

/** 어댑터가 내보내는 이벤트 — sessionId 는 SessionManager 가 붙인다. */
export type AdapterEvent = HostEvent extends infer E
  ? E extends { sessionId: string }
    ? Omit<E, 'sessionId'>
    : never
  : never;

export type Emit = (event: AdapterEvent) => void;

export interface ImagePart { mime: string; data: string } // data = base64

/**
 * 세션을 띄울 때 함께 주는 것.
 *  - mcp  : 메인 에이전트에게만 — clink·프리셋 도구(Agent Hub MCP) 주소
 *  - tools: 설정의 "툴"에서 켠 MCP 서버 — 모든 세션에
 *  - configDir: CLI 에게 줄 MCP 설정 파일을 둘 곳
 */
export interface StartContext {
  mcp?: { name: string; url: string };
  tools?: Tool[];
  configDir?: string;
  env?: Record<string, string>; // 연동: 이 CLI 에만 넣을 환경 변수(API 키 등)
  authMethod?: string; // 연동: ACP authenticate 로 고를 인증 방식(예: Codex 의 api-key)
  extraDirs?: string[]; // 작업 폴더 말고 더 쓸 수 있게 연결한 폴더
  pluginDir?: string; // Claude: 이 세션에만 꽂을 플러그인 폴더(Agent Hub 스킬)
}

/**
 * CLI 하나를 세션 하나로 감싼다. 각 CLI의 출력 형식은 여기서 끝나고,
 * 바깥으로는 공통 이벤트만 나간다.
 */
export interface AgentAdapter {
  start(session: SessionInfo, emit: Emit, ctx?: StartContext): Promise<void>;
  /** 사람(또는 메인)의 말. images 는 붙여 넣은 이미지(base64) — 세 CLI 모두 이미지 입력을 받는다 */
  send(text: string, images?: ImagePart[]): void;
  respondPermission(requestId: string, allow: boolean): void;
  stop(): void;
}

/** 아직 연결 못 하는 AI — 이유를 화면에 보여 주고 끝낸다. */
export class UnavailableAdapter implements AgentAdapter {
  private reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
  async start(_session: SessionInfo, emit: Emit) {
    emit({ type: 'session.ended', reason: this.reason });
  }
  send() {}
  respondPermission() {}
  stop() {}
}
