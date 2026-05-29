---
name: od-mobile
description: Open Design 작업물을 폰에서 보기 위해 로컬 웹 UI를 Tailscale tailnet에 노출한다. "폰에서 디자인 보기", "open design 모바일", "od 모바일", "od-mobile" 등에서 사용.
---

# od-mobile

Open Design는 로컬(127.0.0.1)에만 바인딩되어 폰에서 접근할 수 없다. 이 스킬은
`tailscale serve`로 OD 웹 UI를 사용자의 tailnet에 노출해 폰에서 보게 한다.

## 전제

- 맥과 폰 모두 Tailscale에 로그인되어 같은 tailnet에 있어야 한다.
- Open Design 데스크톱 앱이 실행 중이어야 한다.

## 실행 순서

1. `od-mobile` CLI가 설치돼 있으면 그대로 사용한다:
   ```bash
   od-mobile up        # OD 포트 감지 후 tailnet에 노출
   od-mobile url       # 폰에서 열 주소(MagicDNS 이름) 출력
   od-mobile doctor    # 환경 진단
   od-mobile off       # 노출 해제
   ```
   결과로 나온 **이름(MagicDNS) 주소**를 사용자에게 전달한다.

2. CLI가 없으면 수동으로 동등하게 수행한다:
   - OD 웹 포트 감지: `lsof -nP -iTCP -sTCP:LISTEN -a -p "$(pgrep -f 'web-sidecar\.mjs')"`
   - 노출: `tailscale serve --bg --http=8080 http://127.0.0.1:<감지된포트>`
   - 주소 계산: `tailscale status --json`의 Self.DNSName → `http://<이름>:8080`

## 주의

- **IP로는 접속이 안 된다.** macOS는 방화벽/유저스페이스 네트워킹 때문에 일반
  바인딩 소켓이 피어에게 닿지 않아 `tailscale serve`를 써야 하는데, serve는
  MagicDNS '이름'에만 응답한다(IP는 404). 따라서 반드시 이름 주소로 접속한다.
- 폰에서 이름이 NXDOMAIN으로 안 풀리면 폰 Tailscale 앱의 "Use Tailscale DNS"를
  켜도록 안내한다. (이것이 폰 접속의 핵심 전제)
- OD를 재시작하면 포트가 바뀌므로 `od-mobile up`을 다시 실행해야 한다.
- 노출은 tailnet 내부 기기로 한정된다(공개 인터넷 아님).
