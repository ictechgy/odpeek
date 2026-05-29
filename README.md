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
od-mobile up        # OD 포트를 감지해 tailnet에 노출 (기본 명령)
od-mobile ip        # 폰에서 열 주소(tailnet IP) 출력 — 가장 안정적
od-mobile url       # MagicDNS 이름 기반 주소 출력
od-mobile status    # 현재 serve 상태 + 감지된 OD 포트
od-mobile doctor    # 환경 진단(tailscale / OD / MagicDNS)
od-mobile off       # 노출 해제
```

### 옵션

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `-p, --port <n>` | tailnet 노출 포트 | `8080` (env `OD_MOBILE_PORT`) |
| `--pattern <s>` | OD 프로세스 매칭 패턴 | `web-sidecar\.mjs` |

### 폰에서 보기

1. 맥에서 `od-mobile up` 실행
2. 출력된 주소를 폰 브라우저에서 연다
   - 폰의 Tailscale이 켜져 있어야 한다
   - **IP 주소를 우선 사용**: MagicDNS 이름(`*.ts.net`)이 안 풀리면(`NXDOMAIN`)
     폰 Tailscale 앱에서 "Use Tailscale DNS"를 켜거나 IP 주소를 쓴다

> OD를 재시작하면 내부 포트가 바뀌므로 `od-mobile up`을 다시 실행한다.
> 노출 포트(`:8080`)와 접속 주소는 그대로 유지된다.

## 동작 원리

1. `pgrep -f web-sidecar\.mjs` 로 OD 웹 사이드카 PID를 찾는다.
2. `lsof` 로 그 PID가 LISTEN 중인 로컬 포트를 알아낸다.
3. `tailscale serve --bg --http=8080 http://127.0.0.1:<포트>` 로 노출한다.
4. `tailscale status --json` 에서 MagicDNS 이름과 tailnet IP를 읽어 접속 주소를 만든다.

## 배포 메모 (메인테이너용)

- **npm**: `npm publish`
- **Homebrew**: `npm publish` 후 `Formula/od-mobile.rb`의 `sha256`을
  `curl -sL <tarball> | shasum -a 256` 값으로 교체하고 tap 저장소에 배치
- **Claude 플러그인**: `.claude-plugin/plugin.json` + `skills/` 가 저장소에 포함됨

## 라이선스

MIT
