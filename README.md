# odpeek

A tiny CLI for **viewing Open Design artifacts on your phone**.

> **Community tool.** `odpeek` is an unofficial, third-party helper for the
> Open Design desktop app — it is **not affiliated with or endorsed by Open
> Design**. It only exposes the OD instance already running on *your own*
> machine.

🇰🇷 [한국어 문서는 아래에 있습니다 ↓](#한국어)

---

## English

The Open Design (OD) desktop app serves its web UI on `127.0.0.1` (localhost)
only, and the port changes randomly on every restart — so you can't reach it
from your phone. `odpeek` auto-detects the current OD web port and exposes
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
| Host OS | macOS or Linux (uses `lsof` / `pgrep` for port detection) | macOS or Linux |
| Node.js | >= 18 | >= 18 |
| Open Design desktop app | running on the host | running on the host |
| Extra tool | [Tailscale](https://tailscale.com/download) installed + logged in | [`cloudflared`](https://github.com/cloudflare/cloudflared) — macOS: `brew install cloudflared`; Linux: [install docs](https://pkg.cloudflare.com/index.html) |
| Account | free [Tailscale](https://tailscale.com/) account, with the host **and** phone signed into the **same** tailnet | **none** — `trycloudflare` quick tunnels require **no Cloudflare account** |
| On your phone | Tailscale app installed + signed into the same account | just a browser (open the URL, enter the username / password) |

> `odpeek` itself has **zero npm dependencies** — it only shells out to the
> tools above. Run **`odpeek doctor`** to check which prerequisites are met.

### Install

```bash
# npm
npm install -g odpeek

# Homebrew
brew install ictechgy/tap/odpeek
```

**Claude Code plugin** — add this repo as a plugin marketplace and use the
`odpeek` skill:

```
/plugin marketplace add ictechgy/odpeek
/plugin install odpeek
```

### Usage

```bash
odpeek up        # Expose OD to your tailnet (best on Wi-Fi / private network)
odpeek tunnel    # Expose OD over a public Cloudflare HTTPS tunnel (cellular / anywhere, Basic auth)
odpeek ip        # Print the tailnet IP address to open
odpeek url       # Print the MagicDNS name address to open
odpeek status    # Show current exposure state + detected OD port
odpeek doctor    # Diagnose the environment
odpeek off       # Tear everything down (serve + tunnel)
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
odpeek tunnel                       # Start a tunnel with an auto-generated password
ODPEEK_PASS=mypw odpeek tunnel   # Use a fixed password (browser remembers it → no re-entry)
```

- Requires `cloudflared` (macOS: `brew install cloudflared`; Linux: see the
  [install docs](https://pkg.cloudflare.com/index.html)).
- **No Cloudflare account is needed** for the quick tunnel — you only need an
  account + domain for a *stable* named tunnel or Cloudflare Access (below).
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
- **Attempt log:** `~/.odpeek/auth.log` (records failures/lockouts; never the
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
| `-p, --port <n>` | tailnet exposure port | `8080` (env `ODPEEK_PORT`) |
| `--pattern <s>` | OD process match pattern | `web-sidecar\.mjs` |
| `--idle <min>` | tunnel idle auto-shutdown (minutes, `0` = off) | `30` (env `ODPEEK_IDLE_MIN`) |

Environment variables: `ODPEEK_PORT`, `ODPEEK_AUTH_PORT`,
`ODPEEK_IDLE_MIN`, `ODPEEK_USER` (default `od`), `ODPEEK_PASS`.

### Viewing on your phone (Tailscale path)

1. Run `odpeek up` on the Mac.
2. With Tailscale on your phone, open the printed **IP address**
   (`http://100.x.y.z:8080`) in the phone browser — **this works regardless of
   MagicDNS settings.**

> **Why the IP works:** exposure uses serve's **L4 TCP passthrough (`--tcp`)**.
> Serve's HTTP mode does vhost routing by MagicDNS *name* (so the IP would 404),
> but TCP mode ignores the Host header and forwards as-is, so the IP works too.
> `serve` also goes through `tailscaled`, sidestepping macOS firewall (stealth)
> and userspace-networking limits. (A raw proxy on a normally-bound socket
> can't reach peers because of those limits.)

> When OD restarts, its internal port changes — just run `odpeek up` again.
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

- The `tunnel` URL is **public**. Run `odpeek off` when you're done; make a
  habit of it, and be mindful of exposing sensitive designs.
- If macOS prompts "Allow incoming connections for node?", you can **Deny** —
  the final design relies on loopback + outbound, so inbound is not needed.

---

## 한국어

> **비공식 도구입니다.** `odpeek`은 Open Design 데스크톱 앱을 폰에서 보기 위한
> 서드파티 도구로, Open Design과는 아무런 제휴·보증 관계가 없습니다. 노출되는 건
> 본인 컴퓨터에서 이미 돌고 있는 OD뿐입니다.

Open Design(OD) 데스크톱 앱은 웹 UI를 로컬호스트(`127.0.0.1`)에만 띄우는 데다, 그
포트마저 켤 때마다 바뀝니다. 그래서 폰에서는 바로 열 수 없죠. `odpeek`은 지금 떠
있는 OD 포트를 자동으로 찾아 두 가지 방법 중 하나로 폰에 띄워 줍니다.

- **`up`** — [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve)
  로 **내 tailnet 기기(폰·태블릿)에만** 띄웁니다. 공개 인터넷에는 열리지 않고,
  트래픽은 Tailscale의 WireGuard로 암호화됩니다. Wi‑Fi나 같은 사설망에서 쓰기
  좋습니다.
- **`tunnel`** — [Cloudflare 빠른 터널](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  로 **HTTP Basic 인증이 걸린 공개 HTTPS URL**을 만듭니다. `cloudflared`가 안쪽으로
  들어오는 연결을 받는 대신 바깥으로 연결을 거는 방식이라, macOS 방화벽·CGNAT·DNS
  문제를 모두 비켜 갑니다. 셀룰러를 비롯해 어떤 망에서도 안정적으로 동작합니다.

### 요구 사항

| | `up` (Tailscale) | `tunnel` (Cloudflare) |
|---|---|---|
| 호스트 OS | macOS 또는 Linux (포트 감지에 `lsof`·`pgrep` 사용) | macOS 또는 Linux |
| Node.js | >= 18 | >= 18 |
| Open Design 데스크톱 앱 | 호스트에서 실행 중 | 호스트에서 실행 중 |
| 추가 도구 | [Tailscale](https://tailscale.com/download) 설치 후 로그인 | [`cloudflared`](https://github.com/cloudflare/cloudflared) — macOS는 `brew install cloudflared`, Linux는 [설치 문서](https://pkg.cloudflare.com/index.html) 참고 |
| 계정 | 무료 [Tailscale](https://tailscale.com/) 계정 (맥과 폰이 **같은** tailnet에 로그인) | **필요 없음** — `trycloudflare` 빠른 터널은 Cloudflare 계정 없이 됩니다 |
| 폰 쪽 | Tailscale 앱 설치 후 같은 계정으로 로그인 | 브라우저만 있으면 됩니다 (URL을 열고 아이디·비밀번호 입력) |

> `odpeek`은 그 자체로 **npm 의존성이 하나도 없습니다.** 위 도구들을 불러다 쓸
> 뿐이에요. 전제 조건이 갖춰졌는지는 **`odpeek doctor`** 로 확인할 수 있습니다.

### 설치

```bash
# npm
npm install -g odpeek

# Homebrew
brew install ictechgy/tap/odpeek
```

**Claude Code 플러그인** — 이 저장소를 플러그인 마켓플레이스로 추가하면
`odpeek` 스킬을 쓸 수 있습니다.

```
/plugin marketplace add ictechgy/odpeek
/plugin install odpeek
```

### 사용법

```bash
odpeek up        # OD를 내 tailnet에 노출 (Wi-Fi·사설망에 적합)
odpeek tunnel    # OD를 Cloudflare 공개 HTTPS 터널로 노출 (셀룰러 등 어디서나, Basic 인증)
odpeek ip        # tailnet IP 접속 주소 출력
odpeek url       # MagicDNS 이름 접속 주소 출력
odpeek status    # 현재 노출 상태와 감지된 OD 포트 표시
odpeek doctor    # 환경 진단
odpeek off       # 모든 노출 해제 (serve + 터널)
```

#### 두 가지 노출 방식

| 방식 | 명령 | 적합한 상황 | 특징 |
|------|------|------------|------|
| **Tailscale serve** | `up` | Wi-Fi·같은 사설망 | tailnet 전용이라 비공개, 무료. 단 **셀룰러에서는 통신사 CGNAT(100.64/10)와 충돌**해 막힐 수 있음 |
| **Cloudflare 터널** | `tunnel` | 셀룰러·외부망 등 어디서나 | 공개 HTTPS URL이지만 **Basic 인증으로 보호**. cloudflared가 바깥으로 연결을 열어 방화벽·CGNAT·DNS를 모두 우회 |

> **셀룰러에서 `up`이 막히는 이유:** 한국 통신사(KT·SKT·LGU+)는 셀룰러에서
> Tailscale과 똑같은 `100.64.0.0/10`(CGNAT) 대역을 쓰기 때문에 경로가 충돌합니다
> ([Tailscale 공식 문서](https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts)).
> 그래서 셀룰러에서는 공개 터널(`tunnel`)이 가장 확실합니다.

#### tunnel 모드 상세

```bash
odpeek tunnel                       # 비밀번호를 자동 생성해 터널 시작
ODPEEK_PASS=mypw odpeek tunnel   # 비밀번호 고정 (브라우저가 기억 → 재입력 불필요)
```

- `cloudflared`가 있어야 합니다 (macOS는 `brew install cloudflared`, Linux는 [설치
  문서](https://pkg.cloudflare.com/index.html) 참고).
- 빠른 터널은 **Cloudflare 계정이 필요 없습니다.** 계정과 도메인은 *고정* 주소(named
  tunnel)나 Cloudflare Access(아래)를 쓸 때만 있으면 됩니다.
- 출력된 `https://...trycloudflare.com` 주소를 폰에서 열고, 화면에 표시된
  아이디·비밀번호로 로그인하면 됩니다.
- 연결 경로는 `cloudflared` → 로컬호스트 인증 프록시(Basic 인증) → OD 순서입니다.
  주소는 공개돼 있지만 인증으로 막혀 있습니다.
- 빠른 터널 주소는 **실행할 때마다 바뀝니다.** 고정 주소가 필요하면 Cloudflare
  계정과 도메인으로 named tunnel을 만들면 됩니다.

##### tunnel 보안 하드닝 (자동 적용)

- **무차별 대입 차단:** 같은 클라이언트 IP(`CF-Connecting-IP` 기준)가 8번 실패하면
  15분 동안 막습니다(HTTP 429).
- **보안 헤더:** HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `X-Robots-Tag`를 붙입니다.
- **시도 기록:** 실패와 잠금만 `~/.odpeek/auth.log`에 남기며, 비밀번호는 절대
  기록하지 않습니다.
- **유휴 시 자동 종료:** 기본값으로 30분 동안 아무 활동이 없으면 터널과 프록시를
  내립니다(`--idle <분>`, `0`이면 끔).
- 자격 비교에는 타이밍 공격에 안전한(timing-safe) 방식을 쓰고, 비밀번호를 따로
  지정하지 않으면 약 71비트짜리 난수로 자동 생성합니다.

신원 기반의 더 강력한 인증(Google·이메일 OTP, MFA, 감사 로그)이 필요하면
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
를 참고하세요 (계정과 도메인이 필요합니다).

### 옵션

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `-p, --port <n>` | tailnet 노출 포트 | `8080` (환경변수 `ODPEEK_PORT`) |
| `--pattern <s>` | OD 프로세스 매칭 패턴 | `web-sidecar\.mjs` |
| `--idle <min>` | 터널 유휴 자동 종료 시간 (분, `0`이면 끔) | `30` (환경변수 `ODPEEK_IDLE_MIN`) |

환경 변수: `ODPEEK_PORT`, `ODPEEK_AUTH_PORT`, `ODPEEK_IDLE_MIN`,
`ODPEEK_USER`(기본값 `od`), `ODPEEK_PASS`.

### 폰에서 보기 (Tailscale 방식)

1. 맥에서 `odpeek up`을 실행합니다.
2. 폰에서 Tailscale을 켠 채로, 출력된 **IP 주소**(`http://100.x.y.z:8080`)를 폰
   브라우저에서 엽니다 — **MagicDNS 설정과 상관없이 됩니다.**

> **IP로 접속되는 이유:** 노출에 serve의 **L4 TCP 패스스루(`--tcp`)** 를 쓰기
> 때문입니다. serve의 HTTP 모드는 MagicDNS '이름'으로 가상 호스트 라우팅을 하기
> 때문에 IP로 들어오면 404가 나지만, TCP 모드는 Host 헤더를 보지 않고 그대로
> 넘겨주므로 IP로도 접속됩니다. 게다가 `serve`는 tailscaled를 거치므로 macOS
> 방화벽(스텔스)과 유저스페이스 네트워킹 제약까지 함께 비켜 갑니다. (보통 방식으로
> 바인딩한 소켓을 쓰는 raw 프록시는 이 제약 때문에 상대 기기에 닿지 못합니다.)

> OD를 다시 켜면 내부 포트가 바뀌니 `odpeek up`을 한 번 더 실행하면 됩니다. 노출
> 포트(`:8080`)와 접속 주소는 그대로 유지됩니다.

### 동작 원리

1. `pgrep -f web-sidecar\.mjs`로 OD 웹 사이드카의 PID를 찾습니다.
2. `lsof`로 그 PID가 LISTEN 중인 로컬 포트를 알아냅니다.
3. `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:<포트>`로 노출합니다 (L4
   TCP라 IP로 접속할 수 있고, tailscaled를 거치므로 방화벽·netstack을 우회합니다).
4. `tailscale status --json`의 `Self.TailscaleIPs`·`Self.DNSName`으로 접속
   주소를 만듭니다.

### 보안 주의

- `tunnel` 주소는 **공개**입니다. 다 보고 나면 `odpeek off`를 실행하는 습관을
  들이고, 민감한 디자인이 노출되지 않도록 주의하세요.
- macOS가 "node의 인바운드 연결을 허용하시겠습니까?"라고 물으면 **거부(Deny)** 해도
  됩니다. 최종 설계가 루프백과 아웃바운드만 쓰기 때문에 인바운드를 열 필요가 없습니다.

---

## 배포 메모 (메인테이너용 / Maintainer notes)

- **npm:** `npm publish`
- **Homebrew:** `npm publish` 뒤에 `Formula/odpeek.rb`의 `sha256`을
  `curl -sL <tarball> | shasum -a 256` 값으로 바꾸고 tap 저장소에 올립니다.
- **Claude 플러그인:** `.claude-plugin/plugin.json`과 `skills/`가 저장소에 들어
  있습니다.

## 라이선스 / License

MIT
