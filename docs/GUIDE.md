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
- **업데이트**(`src/update.ts`, `scripts/launch.mjs`, 설정 `data/update.json`): 연동 화면의 업데이트 칸에서 레포 주소(비우면 기본 = `config.json` 의 `updateRepo`, 없으면 git `origin` 주소(포크는 자기 포크), 그것도 없으면 `https://github.com/firstfuturevision/FutureVision-AgentHub`)와 자동/수동을 고른다. 매일 정한 시각(기본 4시, 그 시각에 꺼져 있었으면 켜진 뒤)에 레포의 기본 브랜치를 확인한다. 자동이면 받고, 진행 중인 작업이 없을 때 다시 켠다(쉬고 있던 작업은 대기로 복원되고 다음 지시 때 CLI 를 다시 띄움). 수동이면 "새 버전 있음"만 보이고 업데이트 버튼으로 받는다. 다시 켜기: 실행기(`npm start`)로 띄웠으면 종료 코드 75 로 실행기가 다시 띄우고, 아니면 같은 node·같은 인자로 새 Agent Hub 를 떼어 띄운 뒤(`AGENT_HUB_RESTART_WAIT=1`, 출력은 `data/logs/hub.log`) 꺼진다 — 새 것은 화면 포트가 빌 때까지 최대 30초 기다린다. 받아 두고 작업이 끝나길 기다리는 동안(`waiting`)은 "지금 다시 켜기"(`POST /update {action:"restart"}`)로 바로 켠다. 화면은 `/info` 의 `bootId` 가 바뀐 것을 보고 저절로 새로 고친다. 앞으로 감기만 하므로 이 PC 에서 고친 파일이나 레포에 없는 커밋이 있으면 받지 않고 이유를 보여 준다. 레포 설정(origin)은 바꾸지 않고 `refs/remotes/hub-update/*` 에만 받는다. `data/`·`workspace/`·`config.json` 은 레포에 없어 그대로 남는다. 비공개 레포는 연동의 GitHub 계정으로 받는다.
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
- `/` (맨 앞) → 명령: 새 작업, 멈추기, 프리셋 만들기, 프리셋 목록, 툴, 연동.
- 첨부: 붙여넣기 · 끌어다 놓기 · ＋ 버튼. 파일은 그 작업 폴더의 `첨부/` 에 저장되어 경로로 전달되고(동영상 포함), 이미지(5MB 이하)는 이미지째 함께 간다.

**권한 묻지 않기**(`autoApprove`): 에이전트 편집의 체크 칸, 또는 작업 정보 → 지침 → 바꾸기의 "권한" 칸에서 켠다. 켜면 Claude 는 `--permission-mode bypassPermissions` 로 뜨고(끄면 설정값으로 뜨고, 물어야 하는 도구는 허용·거부 카드로 묻는다), Codex·Gemini(ACP)의 `session/request_permission` 은 호스트가 바로 허용한다(기록에는 "자동 허용"으로 남음). 메인이 묻지 않으면 그 메인이 맡긴 하위 에이전트도 묻지 않는다. 포크·복사는 이어받는다. 켜는 것은 PC 앞 화면에서만(대시보드에서는 끄기만). 에이전트 저장·지우기처럼 모두가 쓰는 설정을 바꾸는 승인은 그대로 묻는다.

**Claude 모델 목록·CLI 버전**(`src/models.ts`, `GET/POST /claude-cli`, `data/claude-models.json`): Claude 모델은 코드에 고정하지 않고 CLI 에게 묻는다 — `claude -p --input-format stream-json` 에 `control_request {subtype:"initialize"}` 를 보내면 응답의 `models`(value·displayName)가 그 CLI 가 아는 모델이다(토큰 안 씀, 2.1.283 확인). CLI 가 모르는 모델은 `--model` 로 줘도 "unrecognized_model" 로 거절되므로 이 목록이 곧 쓸 수 있는 목록. "default" 는 Agent Hub 의 "기본"과 겹쳐 뺀다. 켜고 8초 뒤·6시간마다·연동을 열 때(10분 넘었으면) 다시 묻고 `cfg.models.claude`(=`/info` 의 models)를 바꾼다. 버전은 `claude --version` 과 `npm view @anthropic-ai/claude-code version` 을 견주어 새 버전이면 연동의 Claude 칸에 "CLI 업데이트"(터미널 창에서 `claude update`), 끝날 즈음(45초·2분·5분) 다시 묻는다.

**권한 묻지 않기(모든 작업)**(`GET/POST /permissions`, `data/permissions.json`): 설정 → 연동의 스위치. 켜면 모든 작업의 승인 요청을 호스트가 바로 허용하고("자동 허용"), 켜는 순간 기다리던 요청도 허용한다. 작업별 설정과 상관없이 앞선다. 이 PC 화면·원격 접속에서만(대시보드는 이 서버를 거치지 않는다). 작업 정보에 "권한 묻지 않음(모든 작업)"으로 보인다. 자동 허용된 요청은 카드로 띄우지 않고 "도구 N개 사용" 접힌 줄 안에 "자동 허용 · 도구 — 내용" 한 줄로 넣는다(사람이 누를 것만 카드).

작업 목록에서 우클릭(또는 ⋯) → **이름 바꾸기 · 포크 · 분담 · 복사 · 삭제**.
- **포크**: 같은 설정·폴더·에이전트·프리셋으로 새 작업을 만들고 첫 지시에 앞 대화를 붙여 이어받는다. 메인의 답에 마우스를 올리면 **여기서 포크** — 그 차례까지만 가져간다(`session.fork` 의 `upTo`). 작업 목록에서는 원본 아래 나무 모양으로 달리고, 원본 옆 꺾쇠로 접고 편다(접은 상태는 이 브라우저에만 기억). 순서는 끌어 놓기(폰은 작업 메뉴의 위로/아래로)로 **같은 단계 안에서만** 바꾼다 — 계층은 그대로, 맨 위 단계를 옮기면 갈래가 따라간다. 자리는 `session.reorder {rank}` 로 서버에 남아(`info.rank`, 작을수록 위) 어느 기기에서 봐도 같다. 옮긴 적 없으면 맨 위 단계는 최근 것부터, 갈래는 오래된 것부터.
- **포크 공유**: 포크의 답이 끝날 때마다 지난번 공유 뒤로 생긴 대화를 원본 기록에 `session.merged` 로 남긴다(원본 화면에 "포크 공유" 카드). 원본이 진행 중이면 다음 지시 앞에 붙어 가고(에이전트를 바로 돌리지 않음), 끝났으면 기록에만 남아 원본을 다시 포크할 때 함께 이어받는다. 포크 → 원본 한 방향이고, 포크의 포크는 바로 위 원본에 간다. 파일은 같은 작업 폴더를 쓰므로 따로 공유할 것이 없다.
- **분담**(`session.split`, `splitFrom`): 포크처럼 설정·폴더·대화를 이어받고, 원본과 서로 공유한다. 어느 쪽이든 답이 끝나면 지난번 공유 뒤로 생긴 대화를 상대 기록에 `session.merged`(`kind: 'split'`)로 남기고, 상대가 진행 중이면 다음 지시 앞에 `[분담 공유: …]` 로 붙는다. 상대에게서 받은 공유는 빼고 보내서 메아리치지 않고, 원본 → 분담의 첫 공유는 분담할 때까지의 대화(`splitLines`)를 건너뛴다. 분담의 분담까지 한 묶음(나무)으로 보고, 답이 끝난 쪽에서 이웃으로 보낸 뒤 받은 쪽이 바로 자기 다른 이웃에게 넘긴다 — 분담 2 가 한 일이 중간 분담이 다시 답하지 않아도 원래 작업까지 가고, 원래 작업의 일도 분담 2 까지 간다. 목록에서는 원본 아래에 "분담" 표시와 함께 달린다.
- **복사**: 포크처럼 설정과 대화를 모두 가져가지만 원본과 잇지 않는 따로 된 사본(공유 없음, 목록에서도 따로).
- **삭제**: 목록에서만 지우고 기록 파일은 남긴다.

대화 오른쪽 위 세 줄 버튼으로 여는 **작업 정보** 패널. **컨텍스트**(에이전트가 보는 것)와 **세션**(이 작업의 진행) 두 칸으로 나뉜다. 대화 기록은 다 남지만, 컨텍스트는 지금 CLI 가 들고 있는 것만 보여 준다.
- **사용량**(`context.usage`): Claude 는 메인 줄기의 마지막 응답이 받은 입력 토큰(입력 + 캐시 만들기 + 캐시 읽기 + 출력)을 차례 끝에 알리고, 창 크기는 result 의 `modelUsage[].contextWindow` 중 가장 큰 것. ACP 는 `usage_update {used, size}` 가 오면. 설정을 바꿔 다시 띄우면 0 으로 비운다(막대 숨김). 80% 넘으면 막대가 붉어진다.
- **이어받은 내용**(`context.items`): 호스트가 지시 앞에 붙여 넣는 것 — 앞 대화(포크·분담·복사, 설정 바꾸기), 포크·분담 공유. 넣기 전엔 "다음 지시에", 넣으면 그대로 남고, 다시 띄우면 비우고 앞 대화 하나로 다시 대기.
- **에이전트 설정**(기본으로 접힘, 펼친 상태는 브라우저에 기억): 지침(메인 역할). 지침의 **바꾸기**로 프리셋(지침)·에이전트·AI·모델을 고르면 `session.configure` 로 같은 작업에서 메인 CLI 를 새 설정으로 다시 띄우고, 지금까지의 대화를 다음 지시에 붙여 이어간다(작업 중에는 안 됨, 폴더는 그대로). 스킬·허용은 에이전트에 딸려 있어 **에이전트 편집**으로 고친다. 스킬(그 CLI 가 읽는 것), 환경(작업 폴더 + 연결 폴더 추가·삭제 → 새 하위 에이전트·포크부터 `--add-dir`/`additionalDirectories`. "다른 폴더 찾기"로 작업 폴더 뿌리 밖의 폴더도 고를 수 있다 — PC 앞 화면에서만, 드라이브 전체와 Agent Hub `data`(키·기록)가 든 폴더는 안 됨), 허용 에이전트·툴(메인 프리셋 기준).
- **연결된 세션**: 포크 원본·포크.
- **백그라운드**: 지금 돌고 있는 하위 에이전트(작업 중·승인 대기). 메인은 `clink` 결과가 올 때까지 기다린다.
- **하위 작업**: 쉬고 있는 하위 에이전트 일(끝남·실패). 누르면 대화의 체크리스트 카드에서 펼친다.
- **예약**: 이 작업에 정해 둔 시각의 지시(아래). 설정이 아니라 일정이라 늘 보인다.

**원격 접속**(`src/remote.ts`, `GET/POST /remote`): 연동에서 켜면 사무실 네트워크용 서버를 `0.0.0.0:<화면 포트+2>`(기본 4319)에 연다. 화면에 이 PC 의 사설 주소로 만든 접속 주소가 나온다. 비밀번호도 권한 구분도 없다: 원격 요청은 이 PC 화면과 같은 `route` 로 가고 명령은 `{via: 'local'}`. 문은 둘: 사설 주소에서 온 접속만(`isPrivateAddress`), Host 는 이 PC 의 주소·컴퓨터 이름·localhost 에 원격 포트(`isOwnHost`, DNS 리바인딩 차단). Origin 이 있으면 Host 와 같아야 한다. 켜져 있으면 `127.0.0.1` 화면(`GET /`)은 사무실 주소로 302 이동한다. 끄면 답을 보낸 뒤 원격 서버를 닫고 화면은 `local` 주소로 돌아간다. 예전 `data/remote.json` 의 비밀번호 해시·`full` 은 읽지 않고 다음 저장 때 지워진다.

**화면 제어**(`src/screen.ts`, `GET/POST /screen`, `GET /screen/frame`, `POST /screen/input`, 화면 `ui/screen.js`): 왼쪽 위 버튼. 따로 켜고 끈다(`data/screen.json`, 기본 꺼짐). 비밀번호·권한 구분 없음(원격 접속과 같다). 도우미 프로세스 하나와 줄 명령으로 말한다: 표준 입력 한 줄 = 명령(`info`, `frame m w q`, `move/down/up/wheel m x y …`, `key d|u vk`, `text base64`, `indicator 1|0`), 표준 출력 = `[종류 1바이트][길이 4바이트 LE][내용]`. 종류 J(JSON)·F(JPEG)·R(날 픽셀)·S(못 찍음)·E(오류)는 info·frame 의 답, L 은 답 없는 명령의 실패라 버린다. 좌표는 모니터 안 0..1, 키는 Windows 가상 키 코드(화면이 `KeyboardEvent.code` 로 바꾼다).
- Windows: `src/screen-helper.cs` 를 `csc.exe`(.NET Framework 4, Windows 기본)로 `data/bin/screen-helper.exe` 에 컴파일한다(소스가 더 새로우면 다시). 화면 배율과 상관없이 실제 픽셀(DPI 인식). JPEG 로 보낸다. 관리자 확인 창·잠금 화면이면 입력 데스크톱을 열 수 없어 S → 423. 표시 띠는 `WDA_EXCLUDEFROMCAPTURE` 로 원격 화면에 안 찍힌다.
- 리눅스(X11): `src/screen-helper-x11.py` 를 `python3` 로 띄운다(ctypes + libX11·libXtst·libXrandr, 설치 없음). 날 픽셀(R)을 허브가 화면 너비로 넓이 평균해 줄이고 커서를 그려 JPEG 로 만든다(`rawToJpeg`, 압축기는 `src/jpeg.ts` — 라이브러리 없음, 4:2:0). 글자 넣기는 안 쓰는 키 하나를 그 글자로 바꿔 누른다(xdotool 방식). Wayland 세션이면 아래 GNOME 길로, `DISPLAY`·세션 버스가 다 없으면 `supported:false` 와 까닭.
- 리눅스(GNOME Wayland): `src/screen-helper-grd.ts` 를 `node` 로 띄운다. GNOME 46+ 는 화면 공유를 포털(허용 창)과 GNOME 원격 데스크톱만 쓰게 막고, GNOME 50 의 원격 데스크톱에는 VNC 가 없어 RDP 로 붙는다. 켜기: `grdctl`(사용자 세션, sudo 없음)로 TLS 인증서(없으면 `openssl` 로 `~/.local/share/gnome-remote-desktop/rdp-tls.*`)·아이디·비밀번호(이미 있으면 그대로, 없으면 `agenthub` + 임의 20자를 `data/screen-rdp.json` 에)·조작 허용을 정하고 RDP 를 켠 뒤 `systemctl --user` 로 서비스를 (다시) 띄운다. 끄면 Agent Hub 가 켠 경우만 `grdctl rdp disable`. 비밀번호는 GNOME 키링에 저장돼 키링이 잠겨 있으면 실패한다.
- RDP 클라이언트(`src/rdp`, 라이브러리 없음): X.224 → TLS → CredSSP(NLA, NTLMv2 — Node 의 OpenSSL 3 에 없는 MD4·RC4 는 `crypto.ts`) → MCS/GCC → 능력 교환 → DRDYNVC → RDPGFX(v10, H.264 끔) → ZGFX → RemoteFX Progressive(`rfx.ts`, GNOME 이 보내는 TILE_SIMPLE·RLGR1·일반 DWT). 화면은 출력에 묶인 표면을 `fb`(BGRX)에 합쳐 R 프레임으로. 입력은 빠른 경로: 마우스, 스캔코드(`SCANCODE` 표), 글자는 유니코드 키(ASCII)와 GTK·ibus 의 Ctrl+Shift+U 16진수 입력(한글 등 — GNOME 은 자판에 없는 글자의 유니코드 키를 버리고, 클립보드는 GNOME 원격 데스크톱 50 이 한글을 \uXXXX 글자로 바꿔 쓰지 않는다).
- 속도: 도우미가 보내는 조각은 `ByteQueue`(`src/bytes.ts`)에 모아 꺼낼 때 한 번만 붙인다(조각마다 Buffer.concat 하면 8MB 한 장에 수백 ms). GNOME 도우미는 지난번에 보낸 뒤로 화면(RDP 갱신 수·크기)도 커서도 그대로면 U 를 보내고, 허브는 모니터·너비·화질별로 만들어 둔 그림을 다시 보낸다(처음 보는 너비면 `force` 로 다시 받는다). GNOME 50 에서 1280px 한 장 약 45ms·30KB, 안 바뀐 화면 0.3ms(예전 PNG 는 0.6초·1MB).
- 잠금 화면(GNOME): 잠겨 있으면 GNOME 이 원격 연결을 막는다("Session creation inhibited"). 도우미는 `gdbus` 로 org.gnome.ScreenSaver.GetActive 를 보고 붙지 않고 K(잠김)로 바로 답한다. 허브는 이 계정의 그래픽 세션(wayland·x11)에 `loginctl unlock-session`(sudo 없음)을 하고 "화면 잠금을 푸는 중"(423)을 돌려준 뒤 다음 장부터 화면을 보낸다. Agent Hub 가 푼 잠금은 1분 동안 아무도 안 보거나 화면 제어를 끄면 `loginctl lock-session` 으로 다시 잠근다.
- 기다림 제한: 도우미 답은 최대 20초, 상태 확인(`GET /screen`)의 모니터 목록은 3초(넘으면 빈 목록) — 도우미가 연결을 기다리는 동안 상태 확인까지 멈추지 않게. 시간이 지나도 줄 순서를 지키려고 대기 자리는 남겨 두고 늦게 온 답은 버린다.
- 에이전트 화면 도구(`src/screen-tools.ts`, 메인의 MCP): `screen_view`(JPEG 그림 + "화면 W×H"), `screen_click`(왼·오른·가운데, 두 번), `screen_drag`(8단계로 옮기며), `screen_scroll`(칸 수), `screen_type`(글자, 한글 포함), `screen_key`("ctrl+shift+t" 처럼 — 수식 키 먼저 누르고 나중에 뗀다). 좌표는 그 메인이 마지막으로 본 그림의 픽셀이라 보지 않고 누르면 먼저 보라고 돌려준다. 누르고 쓴 뒤 0.6초 기다려 화면을 다시 찍어 함께 돌려준다(`screenshot:false` 면 글만). 화면 제어가 꺼져 있거나 이 PC 에서 안 되면 그 까닭을 돌려줘 에이전트가 사람에게 말하게 한다. 보는 사람 수에는 `agent:<메인 id>` 로 들어간다. 도구 권한은 다른 MCP 도구와 같이 승인 카드로 묻는다(권한 묻지 않기면 자동 허용).
- 채팅에 그림 띄우기(`show_image`, `SessionManager.showImage`): `path` 를 주면 그 그림 파일(작업 폴더 기준, 절대 경로 가능, 50MB 까지), 없으면 지금 화면을 1920 너비 JPEG 로 찍는다(화면 제어가 켜져 있어야 함). `data/images/<작업 id>/<uuid>.<확장자>` 에 복사하고 `agent.image` 이벤트(기록에 남음)를 낸다. 화면은 `GET /images/<작업 id>/<파일>`(이름 모양 검사 후 그 폴더 안만)로 받아 그린다. 화면 제어가 꺼져 있어도 파일은 띄울 수 있다.
- 프레임은 화면이 한 장씩 당긴다(받으면 다음, 최소 60ms 간격). 최근 3초 안에 받아 간 화면 = 보는 사람, 있으면 `indicator 1`. 아무도 안 보고 60초 지나면 도우미를 끈다.

**자동 실행**(`src/autostart.ts`, `GET/POST /autostart`): 연동의 켜기/끄기. `npm run setup` 이 만드는 것 중 자동 시작 하나만 만들고 지운다 — Windows 시작프로그램의 `Agent Hub.lnk`(PowerShell WScript.Shell, 창 없이 --background), macOS LaunchAgent, 리눅스 `~/.config/autostart/agent-hub.desktop`. 바탕화면·시작 메뉴 아이콘은 그대로. 다음 로그인부터 적용. 시험용 `AGENT_HUB_STARTUP_DIR` 로 시작프로그램 폴더를 바꾼다.

**공유 레포**(`data/shared.json`, 받은 레포 `data/shared/repo`, `src/shared.ts`): 연동의 "공유"에 회사 GitHub 레포를 넣으면 git 으로 받는다(연동의 GitHub 로그인 자격 증명, 전역 git 설정은 안 건드림). 켠 종류만 각 저장소에 **공유본**으로 끼운다.
- 레포 구조: `presets/<이름>.json`(프리셋), `agents/<이름>.json`(에이전트), `tools/<이름>.json`, `skills/<이름>/SKILL.md`. 서로는 id 가 아니라 **이름**으로 가리킨다(PC 마다 id 가 다르다). 공유본 id 는 종류+이름의 해시라 모든 PC 에서 같다.
- 공유본이 이긴다: 같은 이름의 이 PC 것은 "(내 것)"(툴·스킬은 `-mine`)을 붙여 남긴다. 공유본은 고치기·지우기가 막히고(`SHARED_READONLY`), "복사"로 내 것을 만든다. 공유받은 툴의 켜고 끄기도 레포에서.
- 올리기: 받은 사본에 파일을 쓰고 커밋·푸시(작성자 = GitHub 계정, 이 명령에만 `-c user.name`). 올리면 이 PC 것은 지우고 그것을 가리키던 에이전트·프리셋이 공유본 id 를 가리키게 바꾼다. 권한 묻지 않기(`autoApprove`)는 올리지 않는다(PC 앞에서만 켜는 설정). 올리기 전에 키·토큰을 검사해(`findSecret`: sk-·ghp_·AKIA·AIza·xox·개인 키·Bearer·주소의 token=·인자의 --api-key 등) 걸리면 거절.
- 내리기: 레포에서 지우고, 이 PC 에는 같은 내용을 내 것으로 남긴다(가리키던 곳도 새 id 로).
- 메인 대화로: `share_push {kind, name}` (사람 승인 카드 후 올림). 프리셋(작업 환경)도 `preset_list` / `preset_save` / `preset_delete` 로 만들고 고친다(에이전트는 이름으로 받음, 저장·삭제 전 승인).
- 받기: 켜고 15초 뒤, 6시간마다, "지금 받기". 받아 둔 사본은 원격에 그대로 맞춘다(reset --hard). 켤 때는 네트워크 없이 받아 둔 것부터 끼운다.

**예약**(`data/schedules.json`, `src/schedules.ts`): 작업마다 한 번·매일·평일·매주 정한 시각(이 PC 현지 시간), 또는 간격(저장한 때부터 N분·N시간마다, 5분~7일)으로 지시를 보낸다. 간격 예약은 그 차례에 작업이 아직 일하는 중이면 건너뛴다(지시가 쌓이지 않게). 호스트가 20초마다 확인한다. 그 작업에 "예약" 이름으로 보낸다. CLI 가 꺼져 있으면(호스트 재시작 등) 같은 작업에서 다시 띄워 앞 대화·에이전트·프리셋 지침을 붙여 보낸다. 호스트가 꺼져 있던 동안 지난 시각은 몰아서 실행하지 않고 건너뛴다. 작업을 지우면 예약도 지운다.

호스트를 다시 켜도 작업 목록·대화는 기록(`data/sessions/*.jsonl`)에서 되살아난다. 작업에는 "끝남"이 없다: 대기로 되살아나고, 다음 지시가 오면 같은 작업에서 CLI 를 다시 띄워 이어 간다. Claude 작업은 CLI 가 알려 준 대화 id(`session.cli` → `SessionInfo.cliSessionId`)의 기록이 그 CLI 의 설정 폴더(프리셋이면 전용 프로필, 아니면 `~/.claude`)에 있으면 `--resume` 으로 그 대화에 그대로 이어 간다. 없거나 Gemini·Codex 면 지금까지의 대화(뒤쪽 8000자)와 역할·작업 환경 지침을 붙인다. 설정을 바꿔 다시 띄울 때는 늘 글로 붙인다. CLI 가 스스로 꺼져도 같다. 앞서 맡긴 하위 에이전트도 메인이 같은 continuation_id 로 부르면 다시 띄워 이어 간다.

**Claude Code 에서 이어 하기**(`src/external.ts`, `GET /claude-code`, `session.import`): `~/.claude/projects/*/<대화 id>.jsonl` 에서 사람이 연 세션을 찾는다(첫 지시의 `turnOrigin` 이 `sdk` 면 프로그램이 띄운 것이라 뺀다. `entrypoint` 는 띄운 쪽 환경을 물려받아 믿을 수 없다). 수십 MB 기록이 있어 앞 256KB·끝 512KB 만 읽는다. 가져오면 그 세션의 폴더(뿌리 밖이면 뿌리 밖 폴더 규칙)에서 메인 작업을 만들고 첫 CLI 부터 `--resume` 으로 띄운다. 화면에는 대화 끝부분(최대 30개)을 먼저 기록한다. 목록·가져오기 모두 PC 앞에서만(원격은 403, 명령은 `via: local` 또는 `trusted`). 2분 안에 바뀐 기록은 "사용 중"으로 표시하고 화면이 먼저 묻는다.

**멈춤**(입력창의 ■, `/멈추기`, `session.stop`): 하던 차례만 멈춘다. Claude 는 stdin 의 `control_request`(interrupt), Codex·Gemini 는 ACP `session/cancel` 로 같은 CLI 를 그대로 두고 멈추며, 묻던 승인은 거부로 정리한다. 메인을 멈추면 일하던 하위 에이전트도 멈춘다. 10초 안에 안 멈추면 CLI 를 끄고 다음 지시 때 다시 띄운다.

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
