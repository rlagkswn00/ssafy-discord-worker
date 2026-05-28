# ssafy-discord-worker

Cloudflare Worker based Discord automation code for two separate workflows:

- `discord-mail-cs`: sends the next frontend/backend mail content to Discord on a schedule
- `discord-mm-integration`: relays Mattermost messages and attachments to Discord using a single JSON secret

## Repository Layout

```text
.
├── discord-mail-cs/
│   ├── mail-cs.js
│   ├── wrangler.jsonc
│   └── .dev.vars.example
├── discord-mm-integration/
│   ├── integration.js
│   ├── config.example.json
│   └── .dev.vars.example
└── .gitignore
```

## Security Rules

- Do not commit real webhook URLs, passwords, or Mattermost source tokens.
- Keep local secrets in ignored files such as `.dev.vars` or `discord-mm-integration/config.json`.
- Start from the example files in this repository and replace placeholder values locally.

## `discord-mail-cs`

This worker posts the next content item from the Maeil Mail repository to Discord.

### Required secrets

Copy `discord-mail-cs/.dev.vars.example` to `discord-mail-cs/.dev.vars` and replace the placeholders.

Required variables:

- `DISCORD_WEBHOOK_FRONTEND`
- `DISCORD_WEBHOOK_BACKEND`

The KV namespace binding name is `MAEIL_KV`, and the worker entry file is `mail-cs.js`.

### Local usage example

```bash
cd discord-mail-cs
cp .dev.vars.example .dev.vars
# fill in real webhook URLs
```

Then run the worker with your normal Wrangler workflow.

## `discord-mm-integration`

This worker receives Mattermost webhook payloads and forwards them to Discord.

### Required secret

The runtime expects a single environment variable:

- `MM_CONFIG`: JSON string containing Discord webhooks, source token mapping, and Mattermost login settings

### Prepare local config

1. Copy `discord-mm-integration/config.example.json` to `discord-mm-integration/config.json`
2. Replace all placeholder values with real values
3. Copy `discord-mm-integration/.dev.vars.example` to `discord-mm-integration/.dev.vars`
4. Convert the JSON to a single-line string and set it as `MM_CONFIG`

Example using `jq`:

```bash
cd discord-mm-integration
cp config.example.json config.json
cp .dev.vars.example .dev.vars
jq -c . config.json
```

Paste the `jq -c` output into the `MM_CONFIG=` line in `.dev.vars`.

If you deploy with Wrangler secrets instead of `.dev.vars`, store the same single-line JSON as the `MM_CONFIG` secret.

## Git-safe workflow

- Real secrets stay local only.
- Example files are committed.
- `.omx/`, `.dev.vars`, `.env*`, logs, and `discord-mm-integration/config.json` are ignored by Git.

## Initial Git setup

```bash
git init
git branch -M main
git remote add origin https://github.com/rlagkswn00/ssafy-discord-worker.git
```

After secret values are confirmed to be excluded, commit and push `main`.

---

## 🌐 `discord-mm-integration` 고도화 아키텍처 명세서 (2026-05)

SSAFY Mattermost ↔ Discord 브릿지 모듈은 **Cloudflare Workers 서버리스 인프라**를 기반으로 작동하며, 대규모 트래픽 유입에 대응하고 불필요한 노이즈를 철저히 차단하는 실무형 지능화 아키텍처로 고도화되었습니다.

### 📌 1. 전체 데이터 플로우 (Sequence Diagram)

```mermaid
sequenceDiagram
    autonumber
    actor MM as Mattermost
    participant Workers as Cloudflare Worker<br/>(ssafy-15th-seoul-13)
    participant KV as CF KV Namespace<br/>(MM_KV)
    participant MM_API as Mattermost API
    participant DC as Discord Webhook

    MM->>Workers: 1. POST 알림 패킷 수신
    Note over Workers: 🔒 가드 1: Outgoing Webhook Token 검증
    
    rect rgb(240, 248, 255)
        Note over Workers: 🧠 가드 2: 스마트 링크 소거 (Smart Link Eraser)
        Note over Workers: 마크다운 이미지/URL 주소 소거 후 순수 텍스트 추출
        alt 순수 본문 80자 미만인 경우 (사진만 단독 업로드 포함)
            Workers-->>MM: 200 OK (ignored) 전송 즉시 전면 차단!
        end
    end

    alt 첨부파일(사진 등)이 있는 장문 공지의 경우
        Workers->>KV: 2. 캐시 세션 조회 (MM_SESSION_TOKEN)
        alt 캐시 토큰이 존재하는 경우 (Warm Cache)
            KV-->>Workers: 기존 토큰 반환
            Workers->>MM_API: 3. 파일 다운로드 요청
            alt 401 Unauthorized 발생 시 (세션 강제 만료 / 자가 치유)
                Workers->>MM_API: 4. 로그인 API 요청
                MM_API-->>Workers: 신규 세션 토큰 발급
                Workers->>KV: 5. 신규 토큰 KV 갱신 저장 (expirationTtl 170일)
                Workers->>MM_API: 6. 파일 다운로드 재시도
            end
            MM_API-->>Workers: 파일 바이너리 전달
        else 캐시 토큰이 없는 경우 (Cold Cache)
            Workers->>MM_API: 3. 로그인 API 요청 (최초 1회)
            MM_API-->>Workers: Bearer 세션 토큰 발급
            Workers->>KV: 4. 신규 토큰 KV 캐싱 등록
            Workers->>MM_API: 5. 파일 다운로드 진행
            MM_API-->>Workers: 파일 바이너리 전달
        end
        Note over Workers: 📄 가드 3: Discord 2,000자 초과 시 단락별 1,900자 자동 청크 분할
        Workers->>DC: 7. Multipart Form-data (첫 청크 + 파일 바이너리) 전송
        Workers->>DC: 8. 후속 텍스트 청크 순차 전송
    else 순수 80자 이상의 텍스트 공지의 경우
        Note over Workers: 📄 가드 3: Discord 2,000자 초과 시 단락별 1,900자 자동 청크 분할
        Workers->>DC: 3. JSON Payload (텍스트 청크) 전송
    end

    Workers-->>MM: 200 OK (ok) 최종 수신 완료 응답
```

### 📌 2. 3대 핵심 아키텍처적 고도화 성과 (Key Breakthroughs)

#### **① 180일 유효 세션 KV 캐싱 및 자가 치유 (Self-Healing Cache)**
* **비효율 개선**: 첨부파일 유입 시마다 Mattermost 로그인 API를 실시간 호출하던 구조를 완전히 혁신.
* **영속 캐시**: 180일 세션 기한을 간파, 최초 로그인 성공 토큰을 Cloudflare KV(`env.MM_KV`)에 보관하여 재사용함으로써 **네트워크 로그인 RTT를 제거**하고 전송 딜레이를 소멸시켰습니다.
* **자가 치유**: 180일 도중 세션이 강제 폭파되거나 만료되어 `401 Unauthorized` 에러가 감지되면, **스스로 이를 감지하여 즉시 재로그인 후 KV 저장소의 만료 열쇠를 자동으로 갈아 끼워 회복**해 냅니다.

#### **② 지능형 노이즈 가드: 스마트 링크 소거 (Smart Link Eraser)**
* **문제 해결**: 사진만 올리더라도 마터모스트가 본문에 강제 삽입하는 약 100자 상당의 이미지 링크 마크다운 문자열을 정규식으로 흔적 없이 소거하도록 필터를 고도화.
* **결과**: 사용자가 글자 없이 **사진만 단독 업로드한 게시물은 순수 글자수가 `0`자로 정밀 측정되어 80자 미만 조건문 가드에 걸려 즉시 차단(ignored)**됩니다. (짤방 및 의미 없는 이미지 포스팅 완벽 원천 봉쇄)

#### **③ 안전한 내부 에러 캡슐화 (Error Encapsulation)**
* **보안 강화**: 예외 발생 시 디테일한 stack trace가 외부 API 응답으로 평문 노출되는 취약점을 철저히 격리.
* **결과**: 세부 분석용 에러 로그는 **Cloudflare 런타임 콘솔에만 안전하게 보관**하고, 외부 연동 기기에는 암호화 정형화된 JSON 메시지(`{"success":false,"error":"Internal Server Error"}`)만 안전하게 리턴합니다.

