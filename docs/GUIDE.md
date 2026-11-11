# Agent Hub 자세한 동작

처음 쓰는 법은 [README](../README.md). 여기는 기능마다 실제로 어떻게 움직이는지 적는다. 설계와 결정 근거는 [DESIGN.md](DESIGN.md).

## 실행

Node 22.6 이상. 외부 패키지 없음.

```bash
git clone https://github.com/firstfuturevision/FutureVision-AgentHub agent-hub   # 업데이트를 받으려면 clone 한 폴더에서
npm start      # http://127.0.0.1:4317  (공용 PC에서만 열림). 실행기가 서버를 띄우고, 업데이트를 받으면 다시 띄운다
npm run start:direct   # 서버만 바로(업데이트를 받아도 스스로 다시 켜지 않음)
npm run setup  # 시작 아이콘 + 로그인하면 자동 시작(Windows·macOS·리눅스, 관리자 권한 불필요). 지우기: npm run setup -- --remove
npm run stop   # 뒤에서 도는 Agent Hub 끄기
npm test       # 가짜 CLI로 세션 흐름 시험
```

**시작 아이콘**(`scripts/setup.mjs`): 아이콘을 누르면 꺼져 있을 때만 창 없이 뒤에서 켜고(`launch.mjs --background --open`, 출력은 `data/logs/hub.log`) 브라우저로 연다. 이미 켜져 있으면 브라우저만 연다.

| | 시작 아이콘 | 로그인하면 자동 시작 |
|---|---|---|
| Windows | 바탕화면·시작 메뉴 바로가기 "Agent Hub" | 시작프로그램 바로가기 |
| macOS | 바탕화면 `Agent Hub.command` | `~/Library/LaunchAgents/com.firstfuturevision.agenthub.plist` |
| 리눅스(Ubuntu 등) | 앱 목록·바탕화면 `agent-hub.desktop` | `~/.config/autostart/agent-hub.desktop` |

가짜 Claude 로 화면만 볼 때:

```bash
node --experimental-strip-types src/main.ts --config test/config.fake.json   # http://127.0.0.1:4318
```

설정은 `config.json`(없으면 기본값). 예:

```json
{
  "port": 4317,
  "workspaceRoot": "D:/agent-work",
  "claude": { "command": "claude", "permissionMode": "default" },
  "dashboard": { "enabled": false, "url": "wss://<대시보드 주소>/ws/agent-host/", "tokenEnv": "AGENT_HUB_DASHBOARD_TOKEN" }
}
```

- `workspaceRoot` 밖의 폴더에서는 세션을 열 수 없다.
- 칸마다 **터미널** 버튼: 공용 PC에 진짜 터미널 창(Windows Terminal / macOS Terminal / 리눅스는 gnome-terminal·konsole·xfce4-terminal·xterm 등 있는 것)을 열어 CLI 를 대화형으로 실행한다. 로그인(`codex` 첫 실행, `gemini`, `claude` → `/login`)이나 손으로 직접 만질 때 쓴다. 대시보드에서는 열 수 없다. 이 창에서 한 작업은 Agent Hub 기록에 남지 않는다.
- **권한**: 에이전트와 터미널은 호스트와 같은 권한으로 돈다. 호스트는 일반 사용자로 실행한다. 관리자 권한으로 실행하면 화면 위에 경고가 뜬다(관리자로 올리는 기능은 일부러 없음).
- **업데이트**(`src/update.ts`, `scripts/launch.mjs`, 설정 `data/update.json`): 연동 화면의 업데이트 칸에서 레포 주소(비우면 기본 `https://github.com/firstfuturevision/FutureVision-AgentHub`, `config.json` 의 `updateRepo`)와 자동/수동을 고른다. 매일 정한 시각(기본 4시, 그 시각에 꺼져 있었으면 켜진 뒤)에 레포의 기본 브랜치를 확인한다. 자동이면 받고, 진행 중인 작업이 없을 때 다시 켠다(쉬고 있던 세션은 끝남으로 복원). 수동이면 "새 버전 있음"만 보이고 업데이트 버튼으로 받는다. 앞으로 감기만 하므로 이 PC 에서 고친 파일이나 레포에 없는 커밋이 있으면 받지 않고 이유를 보여 준다. 레포 설정(origin)은 바꾸지 않고 `refs/remotes/hub-update/*` 에만 받는다. `data/`·`workspace/`·`config.json` 은 레포에 없어 그대로 남는다. 비공개 레포는 연동의 GitHub 계정으로 받는다.
- 공용 PC는 개인 구독을 같이 쓰면 안 된다 → `ANTHROPIC_API_KEY` 등 API 키나 팀 플랜 계정으로 CLI 를 로그인해 둔다.

## 쓰는 법: 메인 에이전트

화면은 Claude 앱과 비슷하다 — 왼쪽 작업 목록, 가운데 대화, 아래 입력창.

1. 입력창 아래에서 고른다 — **작업자**(자동 / Claude / Codex / Gemini) + **모델**(고른 작업자의 모델), 오른쪽 **메인**(메인 AI·모델). 작업자가 "자동"이면 메인이 알아서 고르고, AI 를 고르면 메인이 따로 정하지 않는 한 그 작업자·모델로 맡긴다. 고른 값은 이 브라우저에 기억된다. 모델 목록은 설정값으로 시작하고, 로그인 후 CLI 가 실제 목록을 알려 주면 그것으로 바뀐다.
2. 할 일을 입력하면 새 작업이 시작된다. AI·모델을 지정하면 그대로 맡긴다 — 예: "로그인 버그는 Codex로 고치고, Gemini(gemini-3-pro)한테 관련 문서 조사시켜".
3. 메인이 맡긴 일은 **작업자 카드**로 보인다(누구·모델·상태·최근 답). 작업자가 위험한 행동을 하려 하면 카드가 펼쳐지고 **허용/거부**를 누른다.
4. 메인이 결과를 검토해 보고한다. 메인을 끝내면 작업자도 함께 끝난다.

메인은 Agent Hub 가 주는 MCP 도구 `clink` 하나로 일을 맡긴다(설계 출처: PAL MCP Server 의 clink, 의존성 없이 직접 구현). 자세한 건 [DESIGN.md §5-1](DESIGN.md).
새 작업마다 입력창의 **폴더**에서 작업 폴더를 고른다(작업 폴더 뿌리 바로 아래, "＋ 새 폴더…"로 만들기). 작업자도 같은 폴더에서 일하고, 대화 상단에 📁 로 표시된다.

메인에게 "코드 리뷰어 프리셋 만들어 줘"처럼 말하면 메인이 `preset_save` 로 프리셋을 만든다(고치기·지우기도). 모두가 쓰는 설정이라 **저장 전에 대화에 승인 카드**가 뜨고, 허용해야 저장된다.

새 작업 화면 가운데의 **메인 에이전트**에서 이 작업의 메인을 고른다 — 에이전트 프리셋 중 하나(프리셋의 AI·모델·역할 지침으로 뜸), 프리셋이 없으면 "기본 (Claude)".

입력창에서:
- `@` → 에이전트 프리셋(하위 에이전트) 목록. 고르면 `@이름` 이 들어가고, 메인은 그 프리셋으로 맡긴다. AI 를 직접 정하려면 말로("Codex로") 하거나 작업자 드롭다운으로.
- `/` (맨 앞) → 명령: 새 작업, 끝내기, 프리셋 만들기, 프리셋 목록, 툴, 연동.
- 첨부: 붙여넣기 · 끌어다 놓기 · ＋ 버튼. 파일은 그 작업 폴더의 `첨부/` 에 저장되어 경로로 전달되고(동영상 포함), 이미지(5MB 이하)는 이미지째 함께 간다.

**권한 묻지 않기**(`autoApprove`): 에이전트 편집의 체크 칸, 또는 작업 정보 → 지침 → 바꾸기의 "권한" 칸에서 켠다. 켜면 Claude 는 `--permission-mode bypassPermissions` 로 뜨고(끄면 설정값으로 뜨고, 물어야 하는 도구는 허용·거부 카드로 묻는다), Codex·Gemini(ACP)의 `session/request_permission` 은 호스트가 바로 허용한다(기록에는 "자동 허용"으로 남음). 메인이 묻지 않으면 그 메인이 맡긴 하위 에이전트도 묻지 않는다. 포크·복사는 이어받는다. 켜는 것은 PC 앞 화면에서만(대시보드에서는 끄기만). 에이전트 저장·지우기처럼 모두가 쓰는 설정을 바꾸는 승인은 그대로 묻는다.

작업 목록에서 우클릭(또는 ⋯) → **이름 바꾸기 · 포크 · 분담 · 복사 · 삭제**.
- **포크**: 같은 설정·폴더·에이전트·프리셋으로 새 작업을 만들고 첫 지시에 앞 대화를 붙여 이어받는다. 메인의 답에 마우스를 올리면 **여기서 포크** — 그 차례까지만 가져간다(`session.fork` 의 `upTo`). 작업 목록에서는 원본 아래 나무 모양으로 달리고, 원본 옆 꺾쇠로 접고 편다(접은 상태는 이 브라우저에만 기억).
- **포크 공유**: 포크의 답이 끝날 때마다 지난번 공유 뒤로 생긴 대화를 원본 기록에 `session.merged` 로 남긴다(원본 화면에 "포크 공유" 카드). 원본이 진행 중이면 다음 지시 앞에 붙어 가고(에이전트를 바로 돌리지 않음), 끝났으면 기록에만 남아 원본을 다시 포크할 때 함께 이어받는다. 포크 → 원본 한 방향이고, 포크의 포크는 바로 위 원본에 간다. 파일은 같은 작업 폴더를 쓰므로 따로 공유할 것이 없다.
- **분담**(`session.split`, `splitFrom`): 포크처럼 설정·폴더·대화를 이어받고, 원본과 서로 공유한다. 어느 쪽이든 답이 끝나면 지난번 공유 뒤로 생긴 대화를 상대 기록에 `session.merged`(`kind: 'split'`)로 남기고, 상대가 진행 중이면 다음 지시 앞에 `[분담 공유: …]` 로 붙는다. 상대에게서 받은 공유는 빼고 보내서 메아리치지 않고, 원본 → 분담의 첫 공유는 분담할 때까지의 대화(`splitLines`)를 건너뛴다. 목록에서는 원본 아래에 "분담" 표시와 함께 달린다.
- **복사**: 포크처럼 설정과 대화를 모두 가져가지만 원본과 잇지 않는 따로 된 사본(공유 없음, 목록에서도 따로).
- **삭제**: 목록에서만 지우고 기록 파일은 남긴다.

대화 오른쪽 위 세 줄 버튼으로 여는 **작업 정보** 패널. **컨텍스트**(에이전트가 보는 것)와 **세션**(이 작업의 진행) 두 칸으로 나뉜다. 대화 기록은 다 남지만, 컨텍스트는 지금 CLI 가 들고 있는 것만 보여 준다.
- **사용량**(`context.usage`): Claude 는 메인 줄기의 마지막 응답이 받은 입력 토큰(입력 + 캐시 만들기 + 캐시 읽기 + 출력)을 차례 끝에 알리고, 창 크기는 result 의 `modelUsage[].contextWindow` 중 가장 큰 것. ACP 는 `usage_update {used, size}` 가 오면. 설정을 바꿔 다시 띄우면 0 으로 비운다(막대 숨김). 80% 넘으면 막대가 붉어진다.
- **이어받은 내용**(`context.items`): 호스트가 지시 앞에 붙여 넣는 것 — 앞 대화(포크·분담·복사, 설정 바꾸기), 포크·분담 공유. 넣기 전엔 "다음 지시에", 넣으면 그대로 남고, 다시 띄우면 비우고 앞 대화 하나로 다시 대기.
- **에이전트 설정**(기본으로 접힘, 펼친 상태는 브라우저에 기억): 지침(메인 역할). 지침의 **바꾸기**로 프리셋(지침)·에이전트·AI·모델을 고르면 `session.configure` 로 같은 작업에서 메인 CLI 를 새 설정으로 다시 띄우고, 지금까지의 대화를 다음 지시에 붙여 이어간다(작업 중에는 안 됨, 끝난 작업은 다시 살아남, 폴더는 그대로). 스킬·허용은 에이전트에 딸려 있어 **에이전트 편집**으로 고친다. 스킬(그 CLI 가 읽는 것), 환경(작업 폴더 + 연결 폴더 추가·삭제 → 새 하위 에이전트·포크부터 `--add-dir`/`additionalDirectories`. "다른 폴더 찾기"로 작업 폴더 뿌리 밖의 폴더도 고를 수 있다 — PC 앞 화면에서만, 드라이브 전체와 Agent Hub `data`(키·기록)가 든 폴더는 안 됨), 허용 에이전트·툴(메인 프리셋 기준).
- **연결된 세션**: 포크 원본·포크.
- **백그라운드**: 지금 돌고 있는 하위 에이전트(작업 중·승인 대기). 메인은 `clink` 결과가 올 때까지 기다린다.
- **하위 작업**: 끝났거나 쉬고 있는 하위 에이전트 일(끝남·실패). 누르면 대화의 체크리스트 카드에서 펼친다.
- **예약**: 이 작업에 정해 둔 시각의 지시(아래). 설정이 아니라 일정이라 늘 보인다.

**공유 레포**(`data/shared.json`, 받은 레포 `data/shared/repo`, `src/shared.ts`): 연동의 "공유"에 회사 GitHub 레포를 넣으면 git 으로 받는다(연동의 GitHub 로그인 자격 증명, 전역 git 설정은 안 건드림). 켠 종류만 각 저장소에 **공유본**으로 끼운다.
- 레포 구조: `presets/<이름>.json`(프리셋), `agents/<이름>.json`(에이전트), `tools/<이름>.json`, `skills/<이름>/SKILL.md`. 서로는 id 가 아니라 **이름**으로 가리킨다(PC 마다 id 가 다르다). 공유본 id 는 종류+이름의 해시라 모든 PC 에서 같다.
- 공유본이 이긴다: 같은 이름의 이 PC 것은 "(내 것)"(툴·스킬은 `-mine`)을 붙여 남긴다. 공유본은 고치기·지우기가 막히고(`SHARED_READONLY`), "복사"로 내 것을 만든다. 공유받은 툴의 켜고 끄기도 레포에서.
- 올리기: 받은 사본에 파일을 쓰고 커밋·푸시(작성자 = GitHub 계정, 이 명령에만 `-c user.name`). 올리면 이 PC 것은 지우고 그것을 가리키던 에이전트·프리셋이 공유본 id 를 가리키게 바꾼다. 권한 묻지 않기(`autoApprove`)는 올리지 않는다(PC 앞에서만 켜는 설정). 올리기 전에 키·토큰을 검사해(`findSecret`: sk-·ghp_·AKIA·AIza·xox·개인 키·Bearer·주소의 token=·인자의 --api-key 등) 걸리면 거절.
- 내리기: 레포에서 지우고, 이 PC 에는 같은 내용을 내 것으로 남긴다(가리키던 곳도 새 id 로).
- 받기: 켜고 15초 뒤, 6시간마다, "지금 받기". 받아 둔 사본은 원격에 그대로 맞춘다(reset --hard). 켤 때는 네트워크 없이 받아 둔 것부터 끼운다.

**예약**(`data/schedules.json`, `src/schedules.ts`): 작업마다 한 번·매일·평일·매주 정한 시각(이 PC 현지 시간)에 지시를 보낸다. 호스트가 20초마다 확인한다. 작업이 진행 중이면 그 작업에 "예약" 이름으로 보내고, 끝난 작업이면 포크(앞 대화·에이전트·프리셋 이어받음)해서 보내며 예약도 새 작업으로 옮겨 간다. 호스트가 꺼져 있던 동안 지난 시각은 몰아서 실행하지 않고 건너뛴다. 작업을 지우면 예약도 지운다.

호스트를 다시 켜도 작업 목록·대화는 기록(`data/sessions/*.jsonl`)에서 되살아난다(끝남 상태 — 이어서 하려면 포크).

**에이전트 세션은 Agent Hub 전용 프로필로 뜬다**(Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME` = `data/profiles/…`). 계정의 스킬·플러그인·개인 설정을 읽지 않고, 에이전트가 고른 Agent Hub 스킬(`data/skills`)만 쓴다(Claude 는 세션마다 `--plugin-dir`). 그래서 연동에서 **에이전트 로그인**을 따로 해야 한다(API 키면 필요 없음). 기본 메인(에이전트 안 고름)은 계정 그대로.

**프리셋**은 작업 환경: 작업 폴더, 함께 연결할 폴더, 지침(폴더 구조·작업 방식). 새 작업에서 고르면 메인과 하위 에이전트의 첫 지시에 지침이 붙는다(`data/work-presets.json`).

설정 탭: 연동 / 프리셋 / 에이전트 / 스킬 / 툴.

왼쪽 **설정**에서:
- **에이전트 프리셋**: 작업자의 역할(이름 · AI · 모델 · 언제 쓰나 · 역할 지침). 메인은 일이 프리셋 설명에 맞으면 `clink` 의 `preset` 으로 맡기고, 사람이 "리뷰어 프리셋으로"처럼 지정할 수도 있다. 프리셋의 AI·모델로 작업자를 띄우고 역할 지침을 맡긴 일 앞에 붙인다(화면·기록에는 맡긴 일만). 설계 출처: PAL clink 의 role 프리셋. 저장: `data/presets.json`.
- **툴**: 에이전트에게 줄 MCP 서버(주소 또는 명령). 켜 둔 툴은 모든 메인·하위 에이전트에 붙는다(새 작업부터). Claude 는 여기 툴만 쓰고(`--strict-mcp-config`) 묻지 않고 쓴다. 저장: `data/tools.json`.
- **연동**: AI 마다 **로그인**(공용 PC에 터미널 창이 열림) 또는 **API 키**. 키는 `data/auth.json` 에만 두고 화면엔 "설정됨"만. Agent Hub 가 그 AI 를 띄울 때만 환경 변수로 넣는다(Claude `ANTHROPIC_API_KEY`, Codex `OPENAI_API_KEY`·`CODEX_API_KEY` + ACP `api-key` 인증, Gemini `GEMINI_API_KEY` + Hub 전용 시스템 설정으로 인증 방식만 바꿈 — 개인 `~/.gemini` 는 그대로). Gemini 회사 계정 로그인은 Google Cloud 프로젝트 ID 칸.
  - **설치**: CLI 가 PATH 에 없으면 로그인 대신 "설치" 버튼(`src/install.ts`). 터미널 창에서 `npm install -g` 로 깐다(사용자 폴더라 관리자 권한 불필요). Claude `@anthropic-ai/claude-code`, Codex `@openai/codex` + `@agentclientprotocol/codex-acp`, Gemini `@google/gemini-cli`. 설치가 끝나면 화면이 몇 초마다 다시 확인해 로그인 버튼으로 바뀐다.
  - **GitHub**(`src/github.ts`): GitHub CLI(`gh`) 로 회사 조직 계정에 로그인. "로그인"을 누르면 호스트가 `gh auth login --web` 을 화면 없이 띄워 일회용 코드를 받아 보여 주고 승인 페이지를 연다. 승인하면 gh 가 스스로 끝난다. 로그인 정보는 Agent Hub 전용 `data/profiles/gh`(`GH_CONFIG_DIR`, 토큰도 이 폴더 파일에 — 개인 자격 증명 저장소와 섞이지 않게)에만 두고, 화면엔 계정 이름만. Agent Hub 가 띄우는 세션에만 `GH_CONFIG_DIR` 과 github.com 의 git 자격 증명(`gh auth git-credential`, `GIT_CONFIG_*` 환경 변수)을 넣는다. 전역 git 설정은 건드리지 않는다. gh 가 없으면 "설치"(Windows `winget install GitHub.cli`, macOS `brew install gh`, 리눅스 apt·dnf·pacman·zypper — 터미널 창에서 확인·관리자 비밀번호는 사람이).
- 프리셋마다 **부를 수 있는 하위 에이전트**(이 프리셋이 메인일 때)와 **쓸 수 있는 툴**을 정한다 — 호스트가 실제로 막는다(clink 거부, 툴 안 붙임, 메인에게 보이는 목록도 줄임).

모델 목록은 `config.json` 의 `models` 에서 고친다(로그인 후 CLI 가 알려 주면 자동으로 바뀜). 관리자 권한으로 실행하면 대화 화면 위에 경고가 뜬다.

## 구조

```
src/protocol.ts            공통 이벤트 (모든 경계가 이것 하나로 통신)
src/sessions.ts            세션 관리·기록(data/sessions/*.jsonl)·나중 접속 화면에 기록 재전송·clink(메인→작업자)
src/mcp.ts                 메인 에이전트용 MCP 서버(손 구현, 도구 clink 하나) — /mcp/<메인별 토큰>
src/adapters/claude.ts     claude -p stream-json ↔ 공통 이벤트
src/adapters/types.ts      어댑터 인터페이스, 연결 전 AI 처리
src/transports/local.ts    직접 작업 화면 (HTTP + SSE, 127.0.0.1)
src/transports/dashboard.ts 대시보드 연결 (스텁 — 대시보드 쪽 구현 필요)
ui/                        세 칸 대화 화면
```
