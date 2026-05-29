---
name: od-mobile
description: Open Design 작업물을 폰에서 보기 위해 로컬 웹 UI를 Tailscale tailnet에 노출한다. "폰에서 디자인 보기", "open design 모바일", "od 모바일", "od-mobile" 등에서 사용.
---

# od-mobile

Open Design는 로컬(127.0.0.1)에만 바인딩되어 폰에서 접근할 수 없다. 이 스킬은
`tailscale serve`의 L4 TCP 패스스루로 OD 웹 UI를 tailnet에 노출해 폰에서 보게 한다.

## 전제

- 맥과 폰 모두 Tailscale에 로그인되어 같은 tailnet에 있어야 한다.
- Open Design 데스크톱 앱이 실행 중이어야 한다.

## 실행 순서

1. `od-mobile` CLI가 설치돼 있으면 그대로 사용한다:
   ```bash
   od-mobile up        # OD 포트 감지 후 tailnet에 노출
   od-mobile ip        # 폰에서 열 주소(tailnet IP) 출력 — DNS 불필요, 권장
   od-mobile url       # MagicDNS 이름 기반 주소
   od-mobile doctor    # 환경 진단
   od-mobile off       # 노출 해제
   ```
   결과로 나온 **IP 주소**를 우선 안내한다(폰 MagicDNS 설정과 무관하게 동작).

2. CLI가 없으면 수동으로 동등하게 수행한다:
   - OD 웹 포트 감지: `lsof -nP -iTCP -sTCP:LISTEN -a -p "$(pgrep -f 'web-sidecar\.mjs')"`
   - 노출(L4 TCP): `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:<감지된포트>`
   - 주소 계산: `tailscale ip -4` → `http://<IP>:8080`

## 주의

- **반드시 TCP 모드(`--tcp`)를 쓴다.** HTTP 모드(`--http`)는 MagicDNS 이름으로
  vhost 라우팅해서 IP 접속이 404가 되고, 폰 MagicDNS가 꺼져 있으면 NXDOMAIN으로
  아예 안 풀린다. TCP 모드는 Host를 안 보고 흘려보내 IP로 바로 접속된다.
- macOS는 방화벽(스텔스)+유저스페이스 네트워킹 때문에 일반 바인딩 소켓(raw 프록시)이
  피어에게 닿지 않는다. 그래서 tailscaled를 거치는 `serve`가 반드시 필요하다.
- OD를 재시작하면 포트가 바뀌므로 `od-mobile up`을 다시 실행해야 한다.
- 노출은 tailnet 내부 기기로 한정된다(공개 인터넷 아님).
