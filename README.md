# od-mobile

A tiny CLI for **viewing Open Design artifacts on your phone**.

🇰🇷 [한국어 문서는 아래에 있습니다 ↓](#한국어)

---

## English

The Open Design (OD) desktop app serves its web UI on `127.0.0.1` (localhost)
only, and the port changes randomly on every restart — so you can't reach it
from your phone. `od-mobile` auto-detects the current OD web port and exposes
it through one of two paths:

- **`up`** — [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve)
  exposes OD to **your own tailnet devices (phone/tablet) only**, not the public
  internet. Traffic is encrypted by Tailscale's WireGuard. Best on Wi‑Fi / a
  shared private network.
- **`tunnel`** — a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  exposes OD over a **public HTTPS URL guarded by HTTP Basic auth**. Because
  `cloudflared` dials *out* to localhost, it bypasses the macOS firewall, CGNAT,
  and DNS issues. This is the reliable path on **cellular / any network**.

### Requirements

| | `up` (Tailscale) | `tunnel` (Cloudflare) |
|---|---|---|
| OS | macOS or Linux (uses `lsof` / `pgrep` for port detection) | same |
| Node.js | >= 18 | >= 18 |
| Open Design desktop app | running | running |
| Extra tool | [Tailscale](https://tailscale.com/download) installed + logged in (Mac and phone on the same tailnet) | [`cloudflared`](https://github.com/cloudflare/cloudflared) (`brew install cloudflared`) |

> `od-mobile` itself has **zero npm dependencies** — it only shells out to the
> tools above.

### Install

```bash
# npm
npm install -g od-mobile

# Homebrew
brew install ictechgy/tap/od-mobile
```

**Claude Code plugin** — add this repo as a plugin marketplace and use the
`od-mobile` skill:

```
/plugin marketplace add ictechgy/od-mobile
/plugin install od-mobile
```

### Usage

```bash
od-mobile up        # Expose OD to your tailnet (best on Wi-Fi / private network)
od-mobile tunnel    # Expose OD over a public Cloudflare HTTPS tunnel (cellular / anywhere, Basic auth)
od-mobile ip        # Print the tailnet IP address to open
od-mobile url       # Print the MagicDNS name address to open
od-mobile status    # Show current exposure state + detected OD port
od-mobile doctor    # Diagnose the environment
od-mobile off       # Tear everything down (serve + tunnel)
```

#### Two ways to expose

| Mode | Command | Best for | Notes |
|------|---------|----------|-------|
| **Tailscale serve** | `up` | Wi-Fi / same private network | Private (tailnet-only), free. **Cellular may be blocked** by carrier CGNAT (100.64/10) conflicts |
| **Cloudflare tunnel** | `tunnel` | Cellular / external network / anywhere | Public HTTPS URL, **Basic-auth protected**. `cloudflared` dials out to localhost → bypasses firewall / CGNAT / DNS |

> **Why `up` may fail on cellular:** Korean carriers (KT / SKT / LGU+) hand out
> the same `100.64.0.0/10` CGNAT range that Tailscale uses, so routing collides
> ([Tailscale docs](https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts)).
> On cellular, the public tunnel (`tunnel`) is the dependable choice.

#### tunnel mode in detail

```bash
od-mobile tunnel                       # Start a tunnel with an auto-generated password
OD_MOBILE_PASS=mypw od-mobile tunnel   # Use a fixed password (browser remembers it → no re-entry)
```

- Requires `brew install cloudflared`.
- Open the printed `https://...trycloudflare.com` URL on your phone and sign in
  with the shown username / password.
- Chain: `cloudflared` → localhost auth proxy (Basic auth) → OD. The URL is
  public but protected by authentication.
- The quick-tunnel URL **changes on every run**. For a stable URL, set up a
  named tunnel with a Cloudflare account + domain.

##### tunnel security hardening (applied automatically)

- **Brute-force lockout:** 8 failed attempts (keyed on the real client IP via
  `CF-Connecting-IP`) → 15-minute block (HTTP 429).
- **Security headers:** HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `X-Robots-Tag`.
- **Attempt log:** `~/.od-mobile/auth.log` (records failures/lockouts; never the
  password).
- **Idle auto-shutdown:** tears down the tunnel + proxy after 30 minutes of
  inactivity by default (`--idle <minutes>`, `0` = disabled).
- Timing-safe credential comparison; when no password is set, a ~71-bit random
  one is generated.

For stronger identity-based auth (Google / email OTP, MFA, audit logs), see
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
(requires an account + domain).

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <n>` | tailnet exposure port | `8080` (env `OD_MOBILE_PORT`) |
| `--pattern <s>` | OD process match pattern | `web-sidecar\.mjs` |
| `--idle <min>` | tunnel idle auto-shutdown (minutes, `0` = off) | `30` (env `OD_MOBILE_IDLE_MIN`) |

Environment variables: `OD_MOBILE_PORT`, `OD_MOBILE_AUTH_PORT`,
`OD_MOBILE_IDLE_MIN`, `OD_MOBILE_USER` (default `od`), `OD_MOBILE_PASS`.

### Viewing on your phone (Tailscale path)

1. Run `od-mobile up` on the Mac.
2. With Tailscale on your phone, open the printed **IP address**
   (`http://100.x.y.z:8080`) in the phone browser — **this works regardless of
   MagicDNS settings.**

> **Why the IP works:** exposure uses serve's **L4 TCP passthrough (`--tcp`)**.
> Serve's HTTP mode does vhost routing by MagicDNS *name* (so the IP would 404),
> but TCP mode ignores the Host header and forwards as-is, so the IP works too.
> `serve` also goes through `tailscaled`, sidestepping macOS firewall (stealth)
> and userspace-networking limits. (A raw proxy on a normally-bound socket
> can't reach peers because of those limits.)

> When OD restarts, its internal port changes — just run `od-mobile up` again.
> The exposure port (`:8080`) and the address stay the same.

### How it works

1. `pgrep -f web-sidecar\.mjs` finds the OD web sidecar PID.
2. `lsof` finds which local port that PID is LISTENing on.
3. `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:<port>` exposes it
   (L4 TCP so the IP is reachable; via `tailscaled` so it bypasses the firewall
   / netstack).
4. `tailscale status --json` (`Self.TailscaleIPs` / `Self.DNSName`) builds the
   address to open.

### Security notes

- The `tunnel` URL is **public**. Run `od-mobile off` when you're done; make a
  habit of it, and be mindful of exposing sensitive designs.
- If macOS prompts "Allow incoming connections for node?", you can **Deny** —
  the final design relies on loopback + outbound, so inbound is not needed.

---

## 한국어

Open Design(OD) 데스크톱 앱은 웹 UI를 `127.0.0.1`(로컬호스트)에만 띄우고, 그
포트도 재시작할 때마다 랜덤으로 바뀐다. 그래서 폰에서 바로 볼 수 없다.
`od-mobile`은 현재 OD 웹 포트를 자동 감지해 두 가지 방식 중 하나로 노출한다.

- **`up`** — [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve)
  로 **내 tailnet 기기(폰/패드)에만** 노출한다. 공개 인터넷이 아니며 트래픽은
  Tailscale의 WireGuard로 암호화된다. Wi‑Fi나 같은 사설망에서 쓰기 좋다.
- **`tunnel`** — [Cloudflare 빠른 터널](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  로 **HTTP Basic 인증으로 보호되는 공개 HTTPS URL**을 만든다. `cloudflared`가
  로컬호스트로 *아웃바운드* 연결을 열기 때문에 macOS 방화벽·CGNAT·DNS 문제를
  모두 우회한다. **셀룰러 등 어떤 망에서든** 안정적으로 동작하는 방식이다.

### 요구 사항

| | `up` (Tailscale) | `tunnel` (Cloudflare) |
|---|---|---|
| 운영체제 | macOS 또는 Linux (포트 감지에 `lsof`/`pgrep` 사용) | 동일 |
| Node.js | >= 18 | >= 18 |
| Open Design 데스크톱 앱 | 실행 중 | 실행 중 |
| 추가 도구 | [Tailscale](https://tailscale.com/download) 설치 + 로그인 (맥과 폰이 같은 tailnet) | [`cloudflared`](https://github.com/cloudflare/cloudflared) (`brew install cloudflared`) |

> `od-mobile` 자체는 **npm 의존성이 전혀 없다.** 위 도구들을 호출해 쓸 뿐이다.

### 설치

```bash
# npm
npm install -g od-mobile

# Homebrew
brew install ictechgy/tap/od-mobile
```

**Claude Code 플러그인** — 이 저장소를 플러그인 마켓플레이스로 추가하면
`od-mobile` 스킬을 쓸 수 있다.

```
/plugin marketplace add ictechgy/od-mobile
/plugin install od-mobile
```

### 사용법

```bash
od-mobile up        # OD를 tailnet에 노출 (Wi-Fi/사설망 권장)
od-mobile tunnel    # OD를 Cloudflare 공개 HTTPS 터널로 노출 (셀룰러/어디서든, Basic 인증)
od-mobile ip        # tailnet IP 접속 주소 출력
od-mobile url       # MagicDNS 이름 접속 주소 출력
od-mobile status    # 현재 노출 상태 + 감지된 OD 포트
od-mobile doctor    # 환경 진단
od-mobile off       # 모든 노출 해제 (serve + 터널)
```

#### 두 가지 노출 방식

| 방식 | 명령 | 적합한 상황 | 특징 |
|------|------|------------|------|
| **Tailscale serve** | `up` | Wi-Fi / 같은 사설망 | 비공개(tailnet 전용), 무료. 단 **셀룰러는 통신사 CGNAT(100.64/10) 충돌**로 막힐 수 있음 |
| **Cloudflare 터널** | `tunnel` | 셀룰러 / 외부망 / 어디서든 | 공개 HTTPS URL, **Basic 인증 보호**. cloudflared가 로컬호스트로 아웃바운드 연결 → 방화벽·CGNAT·DNS 모두 우회 |

> **셀룰러에서 `up`이 안 되는 이유:** 한국 통신사(KT/SKT/LGU+)는 셀룰러에서
> Tailscale과 동일한 `100.64.0.0/10` CGNAT 대역을 써서 라우팅이 충돌한다
> ([Tailscale 공식 문서](https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts)).
> 그래서 셀룰러에선 공개 터널(`tunnel`)이 가장 확실하다.

#### tunnel 모드 상세

```bash
od-mobile tunnel                       # 자동 생성된 비밀번호로 터널 시작
OD_MOBILE_PASS=mypw od-mobile tunnel   # 고정 비밀번호 사용 (브라우저가 기억 → 재입력 불필요)
```

- `brew install cloudflared`가 필요하다.
- 출력된 `https://...trycloudflare.com` URL을 폰에서 열고, 표시된
  아이디·비밀번호로 로그인한다.
- 연결 순서: `cloudflared` → 로컬호스트 인증 프록시(Basic 인증) → OD. 공개
  URL이지만 인증으로 보호된다.
- 빠른 터널 URL은 **실행할 때마다 바뀐다.** 고정 URL이 필요하면 Cloudflare 계정
  + 도메인으로 named tunnel을 구성한다.

##### tunnel 보안 하드닝 (자동 적용)

- **무차별 대입 잠금:** 실제 클라이언트 IP(`CF-Connecting-IP`) 기준 8회 실패 시
  15분 차단(HTTP 429).
- **보안 헤더:** HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `X-Robots-Tag`.
- **시도 로그:** `~/.od-mobile/auth.log` (실패·잠금만 기록하고 비밀번호는 남기지
  않는다).
- **유휴 자동 종료:** 기본 30분 동안 활동이 없으면 터널과 프록시를 종료한다
  (`--idle <분>`, `0`이면 비활성).
- 타이밍 공격에 안전한(timing-safe) 비교를 사용하며, 비밀번호를 지정하지 않으면
  약 71비트 난수로 자동 생성한다.

더 강한 신원 기반 인증(Google·이메일 OTP, MFA, 감사 로그)이 필요하면
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
를 참고한다 (계정 + 도메인 필요).

### 옵션

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `-p, --port <n>` | tailnet 노출 포트 | `8080` (env `OD_MOBILE_PORT`) |
| `--pattern <s>` | OD 프로세스 매칭 패턴 | `web-sidecar\.mjs` |
| `--idle <min>` | 터널 유휴 자동 종료 (분, `0`=비활성) | `30` (env `OD_MOBILE_IDLE_MIN`) |

환경 변수: `OD_MOBILE_PORT`, `OD_MOBILE_AUTH_PORT`, `OD_MOBILE_IDLE_MIN`,
`OD_MOBILE_USER`(기본 `od`), `OD_MOBILE_PASS`.

### 폰에서 보기 (Tailscale 방식)

1. 맥에서 `od-mobile up`을 실행한다.
2. 폰의 Tailscale이 켜진 상태에서 출력된 **IP 주소**(`http://100.x.y.z:8080`)를
   폰 브라우저에서 연다 — **MagicDNS 설정과 무관하게 동작한다.**

> **IP로 접속되는 이유:** 노출에 serve의 **L4 TCP 패스스루(`--tcp`)** 를 쓰기
> 때문이다. serve의 HTTP 모드는 MagicDNS '이름'으로 vhost 라우팅을 해서 IP로는
> 404가 나지만, TCP 모드는 Host 헤더를 보지 않고 그대로 전달하므로 IP로도
> 접속된다. 또 `serve`는 tailscaled를 거치므로 macOS 방화벽(스텔스)과 유저스페이스
> 네트워킹 제약도 우회한다. (일반 바인딩 소켓을 쓰는 raw 프록시는 이 제약 때문에
> 피어에 도달하지 못한다.)

> OD를 재시작하면 내부 포트가 바뀌므로 `od-mobile up`을 다시 실행한다. 노출
> 포트(`:8080`)와 접속 주소는 그대로 유지된다.

### 동작 원리

1. `pgrep -f web-sidecar\.mjs`로 OD 웹 사이드카 PID를 찾는다.
2. `lsof`로 그 PID가 LISTEN 중인 로컬 포트를 알아낸다.
3. `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:<포트>`로 노출한다 (L4
   TCP라 IP 접속 가능, tailscaled 경유라 방화벽·netstack 우회).
4. `tailscale status --json`의 `Self.TailscaleIPs` / `Self.DNSName`으로 접속
   주소를 만든다.

### 보안 주의

- `tunnel` URL은 **공개**이다. 사용을 마쳤으면 `od-mobile off`를 실행하는 습관을
  들이고, 민감한 디자인 노출에 주의한다.
- macOS가 "node의 인바운드 연결을 허용하시겠습니까?"라고 물으면 **거부(Deny)** 해도
  된다. 최종 설계는 루프백 + 아웃바운드 기반이라 인바운드 허용이 필요 없다.

---

## 배포 메모 (메인테이너용 / Maintainer notes)

- **npm:** `npm publish`
- **Homebrew:** `npm publish` 후 `Formula/od-mobile.rb`의 `sha256`을
  `curl -sL <tarball> | shasum -a 256` 값으로 교체한 뒤 tap 저장소에 올린다.
- **Claude 플러그인:** `.claude-plugin/plugin.json`과 `skills/`가 저장소에
  포함되어 있다.

## 라이선스 / License

MIT
