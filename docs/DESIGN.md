# Agent Hub — 기본 구조 설계

회사 AX(AI 전환)의 기초로, Claude·Gemini·Codex 에이전트를 한 곳에서 부리고 기록하는 체계.

## 1. 목적 (하나)

**에이전트에게 일을 맡기고 → 실시간으로 지켜보며 대화하고 → 검수하고 → 기록한다.**
기록(누가·어느 AI에게·무엇을·얼마나 걸려·얼마 들었고·승인됐는지)이 AX 효과의 근거가 된다.

## 2. 정한 것

| 항목 | 결정 |
|---|---|
| 실행 위치 | 회사 공용 PC 한 대(Windows/Mac)에 설치해 켜 둔다. CLI는 여기서만 돈다 |
| 들어오는 길 | ① FV 대시보드(work.vision-share.com) = 원격 **실시간** 작업, ② 공용 PC 앞 = 직접 작업. 그 외 경로 없음 |
| 로그인·권한 | 대시보드 기존 로그인을 그대로 쓴다. 호스트에는 로그인 기능을 만들지 않는다 |
| 네트워크 | 호스트가 대시보드로 **먼저** 접속(아웃바운드). 회사 PC에 들어오는 포트를 열지 않는다. 직접 작업 화면은 `127.0.0.1` 에서만 열린다 |
| 계정·요금 | 공용 PC라 개인 구독 공유 금지 → API 키(시범, 작업별 비용 기록) 또는 팀 플랜. 대시보드에는 워커 전용 계정 |
| 화면 | 터미널이 아니라 **대화 화면**. 폰에서도 같은 모양으로 보이도록 같은 화면 코드를 로컬과 대시보드가 같이 쓴다 |

## 3. 구조

```
[폰·노트북 브라우저] ⇄ [FV 대시보드: 로그인·중계·기록] ⇄(호스트가 먼저 연결)⇄ ┐
                                                                         │
[공용 PC 브라우저 127.0.0.1] ⇄ 로컬 연결 ⇄────────────────────────────────┤
                                                                         ▼
                                              ┌──────── Agent Host (이 저장소) ────────┐
                                              │ SessionManager  세션 생성·입력·종료·기록  │
                                              │   ├─ ClaudeAdapter  claude -p stream-json │
                                              │   ├─ GeminiAdapter  gemini --experimental-acp │
                                              │   └─ CodexAdapter   (미설치, ACP 어댑터 예정) │
                                              │ Transports                              │
                                              │   ├─ local     HTTP + SSE (직접 작업)      │
                                              │   └─ dashboard 아웃바운드 WebSocket (스텁) │
                                              └────────────────────────────────────────┘
```

**핵심 경계: 모든 것은 `protocol` 의 이벤트 하나로 흐른다.**
어댑터는 각 CLI의 출력을 공통 이벤트로 바꾸고, 전송 계층은 이벤트를 화면까지 나르기만 한다.
그래서 화면이 로컬이든 대시보드든, AI가 셋 중 무엇이든 같은 코드를 탄다.

## 4. 공통 이벤트 (protocol)

호스트 → 화면
- `session.created {session}` / `session.ended {sessionId, reason}`
- `agent.text {sessionId, text, partial}` — 에이전트의 말
- `agent.tool {sessionId, toolId, name, input}` / `agent.tool_result {sessionId, toolId, ok, summary}` — 지금 하는 행동
- `permission.request {sessionId, requestId, tool, detail}` — 승인 대기
- `turn.done {sessionId, durationMs, costUsd?}` — 한 차례 끝, 기록용 수치
- `error {sessionId?, message}`

화면 → 호스트
- `session.create {agent, workdir, title, requestedBy}`
- `user.message {sessionId, text}`
- `permission.respond {sessionId, requestId, allow}`
- `session.stop {sessionId}`

모든 이벤트는 세션 기록(JSONL)에도 그대로 쌓인다 → 나중에 대시보드로 올린다.

## 5. 에이전트별 연결 방식 (2026-11-09 이 PC에서 확인)

| AI | 버전 | 방식 | 상태 |
|---|---|---|---|
| Claude Code | 2.1.283 | `claude -p --input-format stream-json --output-format stream-json --verbose`, 프로세스를 세션 동안 유지 | 첫 버전 구현 |
| Gemini CLI | 0.23.0 | `--experimental-acp` (Agent Client Protocol, JSON-RPC over stdio) 기본 지원 | ACP 어댑터 구현·가짜 에이전트로 검증. 설정 오류는 고침(백업 `settings.json.bak-2026-11-09`). **Google 로그인 만료(2026-01)로 실제 응답은 미확인** — `gemini -p` 도 출력 없이 멈춤 |
| Codex | 0.167.0 | `@agentclientprotocol/codex-acp` 2.6.0 (옛 `@zed-industries/codex-acp` 는 폐기됨)로 같은 ACP 어댑터 사용 | `initialize` 응답 확인, 로그인 전이라 `session/new` 가 -32000 Authentication required |

ACP 어댑터(`src/adapters/acp.ts`) 동작:
- `initialize` → `session/new` 를 `startTimeoutMs`(기본 60초) 안에 못 받으면 "로그인 확인" 안내와 함께 세션을 끝낸다(로그인 만료 CLI 가 조용히 멈추는 문제 대응).
- `session/prompt` 는 한 번에 하나만 보낸다(Gemini 는 새 prompt 가 앞 것을 취소한다) → 줄 세우기.
- `session/request_permission` → `permission.request` → 화면 허용·거부 → `allow_once`/`reject_once` 로 답. "항상 허용"은 고르지 않는다.
- Claude: `--permission-prompt-tool stdio` 로 띄우면 물어야 하는 도구가 stdout `control_request {subtype: can_use_tool, tool_name, input, description, decision_reason_type}` 로 온다 → `permission.request` → 답은 stdin `control_response {subtype: success, request_id, response: {behavior: allow, updatedInput} | {behavior: deny, message}}`. 허용은 한 번만(`permission_suggestions` 의 세션 규칙은 넣지 않는다). 2.1.283 에서 확인. 권한 묻지 않기면 이 인자를 붙이지 않는다.
- PC·대시보드가 같은 승인 요청에 동시에 답하면 먼저 온 답만 받고 `permission.resolved {by}` 로 모든 화면에 알린다.
- 광고하지 않은 `fs/*`·`terminal/*` 요청은 거절한다 — 파일은 에이전트가 작업 폴더 안에서 직접 다룬다.

방향: ACP는 세션·스트리밍·**승인 요청**을 표준으로 다룬다. 장기적으로 세 AI 모두 ACP로 통일하면 어댑터가 하나로 줄어든다. 첫 버전은 추가 설치 없이 되는 Claude stream-json 으로 흐름을 먼저 연다.

## 5-1. 메인 에이전트 (2026-11-09 추가)

사람은 **메인 에이전트 하나**와만 대화하고, 메인이 AI·모델을 지정해 작업자에게 일을 맡긴다. 팀장–팀원 구조.

**설계 출처**: PAL MCP Server(구 Zen MCP)의 `clink` 도구 — "CLI 가 다른 CLI 를 독립된 작업자로 띄우고 최종 결과만 받는다".
도구 모양(`prompt`, `cli_name`, `continuation_id`)과 흐름만 가져오고, 그 프로젝트는 설치하지 않는다. **외부 의존성 0** 유지(MCP 도 손으로 구현).

```
사람 ⇄ 메인 세션 (기본 Claude Code, 설정으로 변경)
          │ MCP 도구 하나 — Agent Hub 가 제공: http://127.0.0.1:<port>/mcp/<메인별 비밀 토큰>
          │ clink(prompt, cli_name, model?, continuation_id?)
          │   → 작업자가 이번 차례를 끝낼 때까지 기다렸다가 최종 답만 돌려준다
          │   → continuation_id 를 주면 같은 작업자에게 이어서 지시
          ▼
       작업자 세션 (role=worker, parentId=메인) — 기존 어댑터 그대로
```

clink 와 다른 점 (이 시스템의 목적에 맞춘 것)
- `model` 인자 추가 — 사용자가 "모델을 지정해서" 시키기 때문.
- clink 는 작업자를 권한 완화 플래그로 띄우지만, 여기서는 **승인을 사람에게** 넘긴다: 작업자의 승인 요청은 화면 카드에 뜨고, 사람이 누를 때까지 도구 호출이 기다린다.
- 작업자 대화도 전부 기록·화면에 남긴다(clink 는 결과만 돌려줌).
- **에이전트 프리셋**(clink 의 role 에 해당, 2026-11-09 추가): `clink(prompt, preset)` 이면 프리셋의 AI·모델(clink 의 model 이 우선)을 쓰고, 역할 지침을 첫 지시 앞에 `[역할: 이름]\n지침\n\n[맡긴 일]\n…` 로 붙인다. 시스템 프롬프트 대신 이 방식을 쓰는 이유: CLI 마다 시스템 프롬프트 넣는 방법이 달라(ACP 는 표준 없음) 세 AI 에 똑같이 통하는 방법이 이것뿐. 프리셋 목록은 MCP `initialize` 지침과 `tools/list` 의 `preset` enum 으로 메인에게 알린다. 프리셋별 도구·스킬 제한(Claude `--allowedTools`, `--plugin-dir` 등)은 다음 단계.
- **대화로 프리셋 관리**: 메인 MCP 도구 `preset_list` / `preset_save` / `preset_delete`. 저장·삭제는 호스트가 메인 대화에 `permission.request`(requestId `hub*`)를 직접 띄우고 사람의 `permission.respond` 를 기다린다(`SessionManager.askHuman`). 형식 오류는 묻기 전에 걸러 돌려준다. 바뀌면 `presets.changed` 로 모든 화면에 알린다.
- **작업 폴더는 세션마다**: 새 메인을 만들 때 뿌리 바로 아래 폴더를 고른다(`GET/POST /folders`). 작업자는 메인의 폴더를 그대로 쓴다.

- **작업자는 더 맡길 수 없다**(MCP 를 주지 않음) — 깊이 1. 무한 위임·비용 폭주 방지.
- 여러 작업자를 동시에 쓰려면 메인이 clink 를 한 번에 여러 개 부른다.
- 토큰은 메인 세션마다 새로 만들고, 그 메인의 작업만 보고·조작할 수 있다. 서버는 127.0.0.1 만 받는다.
- 메인을 끝내면 그 작업자도 모두 끝낸다.
- 기록: 작업자 세션은 `session.created` 에 `parentId`·`model` 이 남고, 비용은 메인 몫·작업자 몫이 세션별로 따로 쌓인다.
- 모델 지정: Claude 는 `--model`, ACP 는 `session/set_model`(지원 안 하면 기본 모델 + 알림).
- 메인에 붙이는 방법: Claude 는 `--mcp-config <파일> --allowedTools mcp__hub`, ACP 는 `session/new` 의 `mcpServers`.
- 사람이 각 AI를 직접 보고 싶을 때를 위해 세 칸 "직접" 화면은 보조로 남긴다(role=direct).

## 6. 안전 규칙

- 직접 작업 서버는 `127.0.0.1` 에만 바인딩한다.
- 세션 작업 폴더는 설정의 `workspaceRoot` 아래로만 허용한다(경로 탈출 거부).
- 권한 모드 기본값은 `default`(위험한 행동은 거부됨). 물어야 하는 도구는 승인 카드로 묻는다.
- API 키·대시보드 토큰은 환경 변수로만 받고 기록·로그에 쓰지 않는다.

## 7. 첫 버전 범위

넣는 것: 프로토콜, 세션 관리, Claude 어댑터, 로컬 직접 작업 화면(세 칸), 세션 기록 JSONL, 대시보드 연결 스텁·설정.
빼는 것: 대시보드 쪽 구현(중계·화면·작업 기록 API — 대시보드 저장소에서 할 일), 승인 버튼 흐름, Gemini·Codex 실제 연결, 작업 폴더 자동 분리(git worktree).

## 8. 확인 기준

- `npm start` 후 `http://127.0.0.1:4317` 에서 Claude 칸에 말을 걸면 답이 실시간으로 흘러나온다.
- 같은 세션에서 두 번째 질문이 앞 대화를 기억한다(프로세스 유지 확인).
- `data/sessions/<id>.jsonl` 에 모든 이벤트가 남는다.
- Gemini·Codex 칸은 "연결 안 됨" 이유를 화면에 보여 준다.

## 9. 다음 단계

1. 대시보드: 실시간 중계(WebSocket) + 에이전트 화면 + 기록 API — 대시보드 소스 위치 확인 필요
2. ~~승인 흐름~~ 완료(ACP `session/request_permission`, Claude `--permission-prompt-tool stdio`)
3. Gemini ACP 연결(설정 파일 수정 후), Codex 설치 + ACP
4. 작업별 폴더 분리, 비용·시간 집계 화면
