---
name: odpeek
description: Open Design 작업물을 폰에서 보기 위해 로컬 웹 UI를 Tailscale(Wi-Fi) 또는 Cloudflare 터널(셀룰러, Basic 인증)로 노출한다. TTL 하드 캡·세션 관측(`sessions`)·JSON 출력(`--json`)·QR 코드 출력을 지원한다. "폰에서 디자인 보기", "open design 모바일", "od 모바일", "odpeek" 등에서 사용.
---

# odpeek

Open Design는 로컬(127.0.0.1)에만 바인딩되어 폰에서 접근할 수 없다. 이 스킬은
`tailscale serve`의 L4 TCP 패스스루로 OD 웹 UI를 tailnet에 노출하거나, Cloudflare
빠른 터널로 공개 HTTPS URL(Basic 인증)을 만들어 폰에서 보게 한다.

## 전제

- 맥과 폰 모두 Tailscale에 로그인되어 같은 tailnet에 있어야 한다(Tailscale 경로 시).
- Open Design 데스크톱 앱이 실행 중이어야 한다.

## 실행 순서

1. `odpeek` CLI가 설치돼 있으면 그대로 사용한다:
   ```bash
   odpeek up                    # Wi-Fi/사설망: tailnet에 노출 (tailnet IP로 접속)
   odpeek tunnel                # 셀룰러/어디서든: Cloudflare 공개 HTTPS 터널 (Basic 인증) + QR 출력
   odpeek tunnel --ttl 60       # 같은 동작이지만 60분 후 활동 무관 강제 종료
   odpeek tunnel --no-qr        # QR 출력 끄기
   odpeek tunnel --qr-invert    # 밝은 배경 터미널에서 QR 반전
   odpeek ip                    # tailnet IP 접속 주소 + QR
   odpeek url                   # MagicDNS 이름 접속 주소 + QR
   odpeek sessions              # 읽기 전용 세션 관측 (uptime·TTL 잔여·인증 실패·잠금·IP)
   odpeek sessions --json       # 같은 내용을 JSON 한 줄로 (파이프·자동화·Claude 플러그인용)
   odpeek status --json         # 노출 상태를 JSON 한 줄로
   odpeek doctor --json         # 진단을 JSON 한 줄로
   odpeek doctor                # 환경 진단
   odpeek off                   # 모든 노출 해제
   ```
   - **Wi-Fi/같은 망**이면 `up` → 나온 **IP 주소** 안내.
   - **셀룰러/외부망**이면 `tunnel` → 나온 **trycloudflare.com URL + 아이디/비밀번호** 안내.
     터미널에 QR 코드가 출력되므로 폰 카메라로 스캔하면 URL을 직접 입력하지 않아도 된다.
     **QR에는 주소만 담겨 있고 비밀번호는 없으므로**, 폰의 Basic 인증 창에 터미널에
     표시된 아이디·비밀번호를 직접 입력해야 한다.
     (한국 통신사 CGNAT 충돌로 셀룰러에선 tailnet IP가 막히므로 터널이 확실)
   - 최신 Open Design의 Origin 검사에 맞춰 tunnel 인증 프록시가 공개 Origin을
     로컬 web-sidecar Origin으로 정규화한다. 폰 채팅의 산출물 `열기`와 파일명은
     새 탭의 실제 raw 파일 URL로 연결된다(산출물 HTML 본문은 수정하지 않음).

2. CLI가 없으면 수동으로 동등하게 수행한다:
   - OD 웹 포트 감지: packaged 앱은 `/tmp/open-design/ipc/*/web.sock` 소유 PID와 `open-design-web-standalone/apps/web` cwd를 확인하고, 개발 빌드는 `pgrep -f 'web-sidecar\.mjs|apps/web/(dist/)?sidecar/index\.(ts|js)'`로 찾는다. `lsof`의 여러 LISTEN 포트 중 `/api/projects`가 OD JSON인 단 하나만 선택하며 모호하면 중단한다.
   - 노출(L4 TCP): `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:<감지된포트>`
   - 주소 계산: `tailscale ip -4` → `http://<IP>:8080`

## 신규 기능 (v0.2)

- **TTL 하드 캡 (`--ttl <분>`, env `ODPEEK_TTL_MIN`):** 터널의 절대 최대 수명.
  유휴는 더 일찍 종료될 수 있고, TTL은 활동 중이어도 N분 후 무조건 종료한다.
- **세션 관측 (`sessions`):** auth.log와 상태 파일을 읽기 전용으로 파싱해
  uptime·TTL 잔여·인증 실패·잠금·고유 출발 IP(마스킹)를 표시한다.
  유휴 잔여는 표시하지 않는다(프록시 메모리 한정).
- **JSON 출력 (`--json`):** `status`·`doctor`·`sessions`를 순수 JSON 한 줄로 출력.
  비밀번호·전체 IP는 포함되지 않는다.
- **QR 코드:** `tunnel`·`ip`·`url`이 기본으로 접속 주소의 QR 코드를 출력한다.
  `--no-qr`로 끄고, `--qr-invert`로 밝은 배경에서 반전할 수 있다.

## 주의

- **반드시 TCP 모드(`--tcp`)를 쓴다.** HTTP 모드(`--http`)는 MagicDNS 이름으로
  vhost 라우팅해서 IP 접속이 404가 되고, 폰 MagicDNS가 꺼져 있으면 NXDOMAIN으로
  아예 안 풀린다. TCP 모드는 Host를 안 보고 흘려보내 IP로 바로 접속된다.
- macOS는 방화벽(스텔스)+유저스페이스 네트워킹 때문에 일반 바인딩 소켓(raw 프록시)이
  피어에게 닿지 않는다. 그래서 tailscaled를 거치는 `serve`가 반드시 필요하다.
- OD를 재시작하면 포트가 바뀌므로 `odpeek up`을 다시 실행해야 한다.
- 노출은 tailnet 내부 기기로 한정된다(공개 인터넷 아님, `up` 한정).
