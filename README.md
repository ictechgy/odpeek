# od-mobile

Open Design 작업물을 **폰에서 보기** 위한 작은 CLI.

Open Design 데스크톱 앱은 웹 UI를 `127.0.0.1`(로컬호스트)에만 띄우고, 그 포트도
재시작할 때마다 랜덤으로 바뀐다. 그래서 폰에서 바로 볼 수 없다. `od-mobile`은
현재 OD 웹 포트를 자동 감지해 [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve)
로 사용자의 tailnet에 노출한다. 노출 대상은 **내 tailnet 기기(폰/패드)뿐**이며
공개 인터넷이 아니다. 트래픽은 Tailscale의 WireGuard로 암호화된다.

## 전제

- macOS 또는 Linux (포트 감지에 `lsof`/`pgrep` 사용)
- [Tailscale](https://tailscale.com/download) 설치 + 로그인 (맥과 폰이 같은 tailnet)
- Open Design 데스크톱 앱 실행 중
- Node.js >= 18

## 설치

### npm

```bash
npm install -g od-mobile
```

### Homebrew

```bash
brew install ictechgy/tap/od-mobile
```

### Claude Code 플러그인

이 저장소를 플러그인 마켓플레이스로 추가하면 `od-mobile` 스킬을 쓸 수 있다.

```
/plugin marketplace add ictechgy/od-mobile
/plugin install od-mobile
```

## 사용법

```bash
od-mobile up        # OD를 tailnet에 노출 (Wi-Fi/사설망 권장)
od-mobile tunnel    # OD를 Cloudflare 공개 HTTPS 터널로 노출 (셀룰러/어디서든, Basic 인증)
od-mobile ip        # tailnet IP 접속 주소 출력
od-mobile url       # MagicDNS 이름 접속 주소 출력
od-mobile status    # 현재 노출 상태 + 감지된 OD 포트
od-mobile doctor    # 환경 진단
od-mobile off       # 모든 노출 해제 (serve + 터널)
```

### 두 가지 노출 방식

| 방식 | 명령 | 적합 상황 | 특징 |
|------|------|----------|------|
| **Tailscale serve** | `up` | Wi-Fi / 같은 사설망 | 비공개(tailnet 전용), 무료. 단 **셀룰러는 통신사 CGNAT(100.64/10) 충돌**로 막힐 수 있음 |
| **Cloudflare 터널** | `tunnel` | 셀룰러 / 외부망 / 어디서든 | 공개 HTTPS URL, **Basic 인증 보호**. cloudflared가 localhost로 아웃바운드 연결 → 방화벽/CGNAT/DNS 모두 우회 |

> **왜 셀룰러에서 `up`이 안 되나**: 한국 통신사(KT/SKT/LGU+)는 셀룰러에서 Tailscale과 동일한
> `100.64.0.0/10` CGNAT 대역을 써서 라우팅이 충돌한다
> ([Tailscale 공식 문서](https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts)).
> 그래서 셀룰러에선 공개 터널(`tunnel`)이 가장 확실하다.

### tunnel 모드 상세

```bash
od-mobile tunnel                 # 자동 생성된 비밀번호로 터널 기동
OD_MOBILE_PASS=mypw od-mobile tunnel   # 고정 비밀번호 사용(브라우저가 기억 → 재입력 불필요)
```

- 전제: `brew install cloudflared`
- 출력된 `https://...trycloudflare.com` URL과 아이디/비밀번호로 폰에서 접속
- cloudflared → localhost 인증 프록시(Basic 인증) → OD 순서. 공개 URL이지만 인증으로 보호됨
- 주의: 빠른 터널 URL은 **실행마다 바뀐다**. 고정 URL이 필요하면 Cloudflare 계정 + 도메인으로 named tunnel 구성

#### tunnel 보안 하드닝 (자동 적용)

- **무차별대입 잠금**: 실제 클라이언트 IP(`CF-Connecting-IP`) 기준 8회 실패 시 15분 차단(429)
- **보안 헤더**: HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-Robots-Tag`
- **시도 로그**: `~/.od-mobile/auth.log` (실패/잠금 기록, 비밀번호는 기록 안 함)
- **유휴 자동 종료**: 기본 30분 무활동 시 터널+프록시 종료(`--idle <분>`, `0`=비활성)
- 타이밍 안전 비교, 비밀번호 미설정 시 ~71비트 무작위 자동 생성

더 강한 신원 기반 인증(Google/이메일 OTP, MFA, 감사 로그)은 **Cloudflare Access**(계정+도메인 필요)를 참고.

### 옵션

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `-p, --port <n>` | tailnet 노출 포트 | `8080` (env `OD_MOBILE_PORT`) |
| `--pattern <s>` | OD 프로세스 매칭 패턴 | `web-sidecar\.mjs` |

### 폰에서 보기

1. 맥에서 `od-mobile up` 실행
2. 폰의 Tailscale이 켜져 있는 상태에서, 출력된 **IP 주소**(`http://100.x.y.z:8080`)를
   폰 브라우저에서 연다 — **MagicDNS 설정과 무관하게 동작한다.**

> 왜 IP가 되나: 노출에 `serve`의 **L4 TCP 패스스루(`--tcp`)** 를 쓰기 때문이다.
> serve의 HTTP 모드는 MagicDNS '이름'으로 vhost 라우팅해서 IP가 404가 되지만,
> TCP 모드는 Host를 보지 않고 그대로 흘려보내 IP로도 접속된다. 또한 `serve`는
> tailscaled를 거치므로 macOS 방화벽(스텔스)/유저스페이스 네트워킹 제약도 우회한다.
> (일반 바인딩 소켓을 쓰는 raw 프록시는 이 제약 때문에 피어에게 닿지 않는다.)

> OD를 재시작하면 내부 포트가 바뀌므로 `od-mobile up`을 다시 실행한다.
> 노출 포트(`:8080`)와 접속 주소는 그대로 유지된다.

## 동작 원리

1. `pgrep -f web-sidecar\.mjs` 로 OD 웹 사이드카 PID를 찾는다.
2. `lsof` 로 그 PID가 LISTEN 중인 로컬 포트를 알아낸다.
3. `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:<포트>` 로 노출한다
   (L4 TCP라 IP 접속 가능, tailscaled 경유라 방화벽/netstack 우회).
4. `tailscale status --json` 의 `Self.TailscaleIPs` / `Self.DNSName` 으로 접속 주소를 만든다.

## 배포 메모 (메인테이너용)

- **npm**: `npm publish`
- **Homebrew**: `npm publish` 후 `Formula/od-mobile.rb`의 `sha256`을
  `curl -sL <tarball> | shasum -a 256` 값으로 교체하고 tap 저장소에 배치
- **Claude 플러그인**: `.claude-plugin/plugin.json` + `skills/` 가 저장소에 포함됨

## 라이선스

MIT
