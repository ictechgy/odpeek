---
name: odpeek
description: Open Design 작업물을 폰에서 보기 위해 로컬 웹 UI를 Tailscale(Wi-Fi) 또는 Cloudflare 터널(셀룰러, Basic 인증)로 노출한다. "폰에서 디자인 보기", "open design 모바일", "od 모바일", "odpeek" 등에서 사용.
---

# odpeek

Open Design는 로컬(127.0.0.1)에만 바인딩되어 폰에서 접근할 수 없다. 이 스킬은
`tailscale serve`의 L4 TCP 패스스루로 OD 웹 UI를 tailnet에 노출해 폰에서 보게 한다.

## 전제

- 맥과 폰 모두 Tailscale에 로그인되어 같은 tailnet에 있어야 한다.
- Open Design 데스크톱 앱이 실행 중이어야 한다.

## 실행 순서

1. `odpeek` CLI가 설치돼 있으면 그대로 사용한다:
   ```bash
   odpeek up        # Wi-Fi/사설망: tailnet에 노출 (tailnet IP로 접속)
   odpeek tunnel    # 셀룰러/어디서든: Cloudflare 공개 HTTPS 터널 (Basic 인증)
   odpeek ip        # tailnet IP 접속 주소
   odpeek doctor    # 환경 진단
   odpeek off       # 모든 노출 해제
   ```
   - **Wi-Fi/같은 망**이면 `up` → 나온 **IP 주소** 안내.
   - **셀룰러/외부망**이면 `tunnel` → 나온 **trycloudflare.com URL + 아이디/비밀번호** 안내.
     (한국 통신사 CGNAT 충돌로 셀룰러에선 tailnet IP가 막히므로 터널이 확실)

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
- OD를 재시작하면 포트가 바뀌므로 `odpeek up`을 다시 실행해야 한다.
- 노출은 tailnet 내부 기기로 한정된다(공개 인터넷 아님).
