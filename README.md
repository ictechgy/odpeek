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
odpeek up                        # Expose OD to your tailnet (best on Wi-Fi / private network)
odpeek tunnel                    # Public Cloudflare HTTPS tunnel, Basic auth — prints a QR code of the URL
odpeek tunnel --ttl 60           # Same, but hard-closes after 60 minutes regardless of activity
odpeek tunnel --no-qr            # Suppress the QR code
odpeek tunnel --qr-invert        # Invert QR for a light-background terminal
odpeek ip                        # Print the tailnet IP + QR
odpeek url                       # Print the MagicDNS address + QR
odpeek status                    # Show current exposure state + detected OD port
odpeek status --json             # Machine-readable JSON (pipe-safe)
odpeek sessions                  # Read-only session observability (uptime, TTL remaining, auth failures …)
odpeek sessions --json           # Same, as JSON
odpeek doctor                    # Diagnose the environment
odpeek doctor --json             # Diagnose, as JSON
odpeek off                       # Tear everything down (serve + tunnel)
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
odpeek tunnel --ttl 60              # Hard-close after 60 min regardless of activity
odpeek tunnel --no-qr               # Suppress the QR code
odpeek tunnel --qr-invert           # Invert QR for a light-background terminal
```

- Requires `cloudflared` (macOS: `brew install cloudflared`; Linux: see the
  [install docs](https://pkg.cloudflare.com/index.html)).
- **No Cloudflare account is needed** for the quick tunnel — you only need an
  account + domain for a *stable* named tunnel or Cloudflare Access (below).
- `tunnel`, `ip`, and `url` print a **QR code** of the address by default so
  you can scan it instead of typing the URL on your phone. The QR encodes the
  **address only — no credentials**. For `tunnel`, the login username/password
  shown in the terminal must be entered manually in the browser's Basic-auth
  prompt on your phone.
- Open the printed `https://...trycloudflare.com` URL on your phone (or scan
  the QR), then sign in with the shown username / password.
- Chain: `cloudflared` → localhost auth proxy (Basic auth) → OD. The URL is
  public but protected by authentication.
- Recent Open Design versions reject public browser origins on chat/API writes.
  The authenticated proxy normalizes same-origin requests back to the detected
  local web-sidecar origin, so editing from the tunneled chat keeps working
  without weakening Open Design's rejection of cross-site origins.
- On a phone, Open Design's produced-file **Open** action normally selects a
  desktop workspace pane that may be hidden. In tunnel mode, odpeek turns that
  action (and the file name) into a same-origin **new-tab** link. HTML and other
  browser-viewable outputs open directly; download-only formats still download.
  The generated artifact HTML itself is not modified.
- The quick-tunnel URL **changes on every run**. For a stable URL, set up a
  named tunnel with a Cloudflare account + domain.

##### TTL hard-cap

`--ttl <minutes>` (env `ODPEEK_TTL_MIN`) sets a hard maximum lifetime for the
tunnel. The tunnel is closed after N minutes **regardless of activity** — even
if a device is actively connected. Idle shutdown (`--idle`) may close it
earlier; TTL is an absolute ceiling that even active usage cannot prevent.

##### Session observability

```bash
odpeek sessions          # Read-only view of the active tunnel session
odpeek sessions --json   # Same, as single-line JSON (pipe-safe / Claude plugin)
```

Shows: tunnel URL, uptime, TTL remaining, recent auth failures, lockouts,
unique source IPs (masked). **Idle remaining is not shown** because it is
stored in the proxy's private memory — `sessions` can only read the log file
and the state file.

##### tunnel security hardening (applied automatically)

- **Brute-force lockout:** 8 failed attempts (keyed on the real client IP via
  `CF-Connecting-IP`) → 15-minute block (HTTP 429).
- **Security headers:** HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `X-Robots-Tag`.
- **Attempt log:** `~/.odpeek/auth.log` (records failures/lockouts; never the
  password).
- **Idle auto-shutdown:** tears down the tunnel + proxy after 30 minutes of
  inactivity by default (`--idle <minutes>`, `0` = disabled).
- **TTL hard-cap:** `--ttl <minutes>` (or `ODPEEK_TTL_MIN`) sets a hard
  maximum lifetime — the tunnel is **always** closed after N minutes regardless
  of activity. Idle may shut down earlier; TTL closes even an active tunnel.
- Timing-safe credential comparison; when no password is set, a ~71-bit random
  one is generated.

For stronger identity-based auth (Google / email OTP, MFA, audit logs), see
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
(requires an account + domain).

### Commands

| Command | Description |
|---------|-------------|
| `up` | Expose OD to your tailnet (Wi-Fi / private network) |
| `tunnel` | Public Cloudflare HTTPS tunnel with Basic auth (cellular / anywhere). Prints a QR code of the URL by default. |
| `ip` | Print the tailnet IP address. Prints a QR code of the address. |
| `url` | Print the MagicDNS address. Prints a QR code of the address. |
| `status` | Show current exposure state + detected OD port (`--json` for machine-readable output) |
| `doctor` | Diagnose the environment (`--json` for machine-readable output) |
| `sessions` | Read-only session observability: uptime, TTL remaining, auth failures, lockouts, unique source IPs (masked). (`--json` for machine-readable output) |
| `off` | Tear everything down (serve + tunnel) |

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <n>` | tailnet exposure port | `8080` (env `ODPEEK_PORT`) |
| `--pattern <s>` | OD process match pattern | packaged Next/web sidecar + current `apps/web/sidecar/index.ts/js` |
| `--idle <min>` | tunnel idle auto-shutdown (minutes, `0` = off) | `30` (env `ODPEEK_IDLE_MIN`) |
| `--ttl <min>` | tunnel hard maximum lifetime (minutes, `0` = off). Closes the tunnel after N minutes **regardless of activity** — independent of idle. | `0` (env `ODPEEK_TTL_MIN`) |
| `--json` | Output `status` / `doctor` / `sessions` as a single-line JSON (pipe-safe, automation-friendly). Never includes passwords or full IPs. | off |
| `--no-qr` | Disable the QR code printed by `tunnel` / `ip` / `url`. | QR on by default |
| `--qr-invert` | Invert QR colours for light-background terminals. | off |

Environment variables: `ODPEEK_PORT`, `ODPEEK_AUTH_PORT`,
`ODPEEK_IDLE_MIN`, `ODPEEK_TTL_MIN`, `ODPEEK_USER` (default `od`), `ODPEEK_PASS`.

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

1. For the packaged desktop app, odpeek resolves the owner of its namespace
   `web.sock` and verifies the standalone Open Design web runtime. For current
   development builds, `pgrep` finds `apps/web/sidecar/index.ts/js`.
2. `lsof` ignores non-listening runtime wrappers. If packaged Next.js exposes
   multiple ports, odpeek selects the sole port whose `/api/projects` response
   is the Open Design JSON shape; ambiguous processes or ports still fail closed.
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
odpeek up                        # OD를 내 tailnet에 노출 (Wi-Fi·사설망에 적합)
odpeek tunnel                    # Cloudflare 공개 HTTPS 터널로 노출 — URL의 QR 코드를 기본으로 출력합니다
odpeek tunnel --ttl 60           # 같은 동작이지만 활동 유무와 무관하게 60분 후 강제 종료합니다
odpeek tunnel --no-qr            # QR 코드 출력을 끕니다
odpeek tunnel --qr-invert        # 밝은 배경 터미널에서 QR 명암을 반전합니다
odpeek ip                        # tailnet IP 접속 주소 + QR 출력
odpeek url                       # MagicDNS 이름 접속 주소 + QR 출력
odpeek status                    # 현재 노출 상태와 감지된 OD 포트 표시
odpeek status --json             # 같은 내용을 JSON 한 줄로 출력합니다 (파이프 안전)
odpeek sessions                  # 읽기 전용 세션 관측 (uptime·TTL 잔여·인증 실패 등)
odpeek sessions --json           # 같은 내용을 JSON 한 줄로 출력합니다
odpeek doctor                    # 환경 진단
odpeek doctor --json             # 진단 결과를 JSON 한 줄로 출력합니다
odpeek off                       # 모든 노출 해제 (serve + 터널)
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
odpeek tunnel --ttl 60              # 활동 유무와 무관하게 60분 후 강제 종료합니다
odpeek tunnel --no-qr               # QR 코드 출력을 끕니다
odpeek tunnel --qr-invert           # 밝은 배경 터미널에서 QR 명암을 반전합니다
```

- `cloudflared`가 있어야 합니다 (macOS는 `brew install cloudflared`, Linux는 [설치
  문서](https://pkg.cloudflare.com/index.html) 참고).
- 빠른 터널은 **Cloudflare 계정이 필요 없습니다.** 계정과 도메인은 *고정* 주소(named
  tunnel)나 Cloudflare Access(아래)를 쓸 때만 있으면 됩니다.
- `tunnel`·`ip`·`url` 명령은 기본적으로 접속 주소의 **QR 코드를 터미널에 출력합니다.**
  폰 카메라로 스캔하면 주소를 직접 입력하지 않아도 됩니다. **QR에는 주소만 담겨 있습니다
  — 로그인 아이디·비밀번호는 담기지 않으므로, `tunnel` 사용 시 터미널에 표시된
  아이디·비밀번호를 폰의 Basic 인증 창에 직접 입력해야 합니다.** (`ip`·`url`의 tailnet
  주소는 자격증명 없이 접속 가능하므로 이 주의사항이 적용되지 않습니다.)
- 출력된 `https://...trycloudflare.com` 주소를 폰에서 열거나 QR을 스캔한 뒤,
  화면에 표시된 아이디·비밀번호로 로그인하면 됩니다.
- 연결 경로는 `cloudflared` → 로컬호스트 인증 프록시(Basic 인증) → OD 순서입니다.
  주소는 공개돼 있지만 인증으로 막혀 있습니다.
- 최신 Open Design은 공개 브라우저 Origin의 채팅/API 수정 요청을 거부합니다. 인증
  프록시가 같은 공개 Host에서 온 요청만 감지된 로컬 web-sidecar Origin으로
  정규화하므로, 다른 사이트의 Origin 거부를 약화하지 않으면서 터널 채팅의 수정
  요청이 동작합니다.
- 폰에서는 Open Design의 산출물 **열기**가 화면에 안 보이는 데스크톱 작업공간만
  선택할 수 있습니다. 터널 모드에서는 odpeek가 산출물 열기와 파일명을 same-origin
  **새 탭** 링크로 바꿉니다. HTML·이미지·PDF처럼 브라우저가 볼 수 있는 형식은 바로
  열리고, 다운로드 전용 형식은 그대로 다운로드됩니다. 생성된 산출물 HTML 본문은
  수정하지 않습니다.
- 빠른 터널 주소는 **실행할 때마다 바뀝니다.** 고정 주소가 필요하면 Cloudflare
  계정과 도메인으로 named tunnel을 만들면 됩니다.

##### TTL 하드 캡

`--ttl <분>` (환경변수 `ODPEEK_TTL_MIN`)으로 터널의 최대 수명을 설정합니다.
N분이 지나면 **활동 중이어도 무조건 종료합니다.** 유휴 종료(`--idle`)는 더 일찍
터널을 내릴 수 있고, TTL은 그것과 별개로 작동하는 절대 상한입니다.

##### 세션 관측

```bash
odpeek sessions          # 활성 터널 세션의 읽기 전용 관측
odpeek sessions --json   # 같은 내용을 JSON 한 줄로 출력합니다 (파이프·자동화용)
```

터널 URL·uptime·TTL 잔여·최근 인증 실패 수·잠금 발동 수·고유 출발 IP(마스킹)를
보여 줍니다. **유휴 잔여는 표시하지 않습니다** — 유휴 카운터는 프록시의 메모리
안에서만 유지되므로 외부에서 읽을 수 없기 때문입니다.

##### tunnel 보안 하드닝 (자동 적용)

- **무차별 대입 차단:** 같은 클라이언트 IP(`CF-Connecting-IP` 기준)가 8번 실패하면
  15분 동안 막습니다(HTTP 429).
- **보안 헤더:** HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `X-Robots-Tag`를 붙입니다.
- **시도 기록:** 실패와 잠금만 `~/.odpeek/auth.log`에 남기며, 비밀번호는 절대
  기록하지 않습니다.
- **유휴 시 자동 종료:** 기본값으로 30분 동안 아무 활동이 없으면 터널과 프록시를
  내립니다(`--idle <분>`, `0`이면 끔).
- **TTL 하드 캡:** `--ttl <분>`(환경변수 `ODPEEK_TTL_MIN`)으로 터널 최대 수명을
  설정합니다. 활동 중이어도 N분 후에는 무조건 종료합니다. 유휴는 더 일찍 종료될 수
  있고, TTL은 활동과 무관하게 종료합니다.
- 자격 비교에는 타이밍 공격에 안전한(timing-safe) 방식을 쓰고, 비밀번호를 따로
  지정하지 않으면 약 71비트짜리 난수로 자동 생성합니다.

신원 기반의 더 강력한 인증(Google·이메일 OTP, MFA, 감사 로그)이 필요하면
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
를 참고하세요 (계정과 도메인이 필요합니다).

### 명령 요약

| 명령 | 설명 |
|------|------|
| `up` | OD를 tailnet에 노출 (Wi-Fi·사설망) |
| `tunnel` | Cloudflare 공개 HTTPS 터널, Basic 인증 (셀룰러/어디서든). URL의 QR 코드를 기본 출력합니다. |
| `ip` | tailnet IP 접속 주소 출력 + QR |
| `url` | MagicDNS 이름 접속 주소 출력 + QR |
| `status` | 현재 노출 상태 + 감지된 OD 포트 (`--json`으로 JSON 출력 가능) |
| `doctor` | 환경 진단 (`--json`으로 JSON 출력 가능) |
| `sessions` | 읽기 전용 세션 관측: uptime·TTL 잔여·인증 실패·잠금·고유 IP(마스킹) (`--json`으로 JSON 출력 가능) |
| `off` | 모든 노출 해제 (serve + 터널) |

### 옵션

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `-p, --port <n>` | tailnet 노출 포트 | `8080` (환경변수 `ODPEEK_PORT`) |
| `--pattern <s>` | OD 프로세스 매칭 패턴 | packaged Next/web sidecar + 최신 `apps/web/sidecar/index.ts/js` |
| `--idle <min>` | 터널 유휴 자동 종료 시간 (분, `0`이면 끔) | `30` (환경변수 `ODPEEK_IDLE_MIN`) |
| `--ttl <min>` | 터널 최대 수명(분, `0`이면 끔). 활동 유무와 무관하게 N분 후 강제 종료합니다. 유휴보다 먼저 끝날 수도, 나중에 끝날 수도 있습니다. | `0` (환경변수 `ODPEEK_TTL_MIN`) |
| `--json` | `status`·`doctor`·`sessions` 출력을 JSON 한 줄로(파이프·자동화·Claude 플러그인용). 비밀번호·전체 IP는 포함되지 않습니다. | 끔 |
| `--no-qr` | `tunnel`·`ip`·`url`의 QR 코드 출력을 끕니다. | 기본 켜짐 |
| `--qr-invert` | 밝은 배경 터미널에서 QR 명암을 반전합니다. | 끔 |

환경 변수: `ODPEEK_PORT`, `ODPEEK_AUTH_PORT`, `ODPEEK_IDLE_MIN`, `ODPEEK_TTL_MIN`,
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

1. packaged 데스크톱 앱은 namespace `web.sock`의 소유 PID와 Open Design standalone
   web 작업 디렉터리를 확인합니다. 개발 빌드는 `pgrep`로
   `apps/web/sidecar/index.ts/js` 프로세스를 찾습니다.
2. `lsof`로 비리스닝 런타임 래퍼를 제외합니다. packaged Next.js가 여러 포트를
   열면 `/api/projects`가 Open Design JSON 형식인 단 하나의 포트만 고르며,
   프로세스나 포트가 여전히 모호하면 공개 노출하지 않고 중단합니다.
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
