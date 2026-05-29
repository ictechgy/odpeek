# Quad-Research Report — Tailscale로 macOS localhost를 폰에서 보기 (KT CGNAT 충돌)

## Brief
- Question: macOS localhost HTTP(OD)를 안드로이드(S26, KT)에서 Tailscale로 안정적 접속
- Rounds run: 1
- Tracks used: Claude(OK) + Codex(OK) / Antigravity(SKIP) + Forge(EMPTY)
- 핵심 합의: 근본 원인 = 통신사 CGNAT 100.64.0.0/10 충돌 (Claude·Codex 독립 합의, 공식 문서 교차검증)

## Executive Summary
폰의 연결이 맥에 도달조차 못 하고 즉시 리셋되는 것은 OD나 맥 설정 문제가 아니라,
**한국 통신사(KT) 셀룰러가 Tailscale과 같은 100.64.0.0/10 대역을 쓰면서 발생하는 CGNAT 충돌**
때문이다. Tailscale 공식 문서가 "Wi-Fi→LTE/5G 전환 시 HTTP 전부 실패"라는 동일 증상을 명시한다.
가장 신뢰성 높은 해결 순서: (1) 폰을 Wi-Fi로 — 셀룰러 충돌이 사라져 대개 즉시 해결,
(2) tailnet IPv4 비활성화(IPv6 전용) 공식 우회, (3) 어디서든 필요하면 Cloudflare Tunnel(+Access).

## Cross-validated Findings
| Finding | 동의 트랙 | 근거 URL |
|---|---|---|
| Tailscale 100.64.0.0/10(CGNAT)는 통신사/ISP와 충돌; 공식 이슈 | Claude+Codex | https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts |
| 동일 증상(Wi-Fi→셀룰러 시 모든 HTTP 실패, Tailscale 끄면 복구) | Claude | https://github.com/tailscale/tailscale/issues/4611 |
| 공식 우회: `disable-ipv4` 노드속성 → IPv6 전용 | Claude+Codex | https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts |
| ipPool은 100.64/10 "안에서" 좁히는 것뿐, 통신사 대역 전체 충돌엔 불완전 | Codex | https://github.com/tailscale/tailscale/issues/12828 |
| Android Private DNS(DoT)가 MagicDNS 가로채 NXDOMAIN; Off/Automatic로 복구 | Claude+Codex | https://github.com/tailscale/tailscale/issues/4252 , https://github.com/tailscale/tailscale/issues/18312 |
| Funnel은 443/8443/10000만, macOS는 오픈소스 변종 필요, MagicDNS/HTTPS 전제 | Codex | https://tailscale.com/docs/features/tailscale-funnel |
| 대안: Cloudflare Tunnel(+Access)/ngrok = 공개 HTTPS, 인증 게이팅 필요 | Claude+Forge(URL) | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/ , https://ngrok.com/docs/traffic-policy/actions/oauth/ |
| `tailscale ping` 성공 ≠ 브라우저 TCP가 터널로 라우팅됨 (프로브 0건이 결정적) | Codex | https://tailscale.com/docs/reference/tailscale-cli/serve |

## Disputed / Split Points
- 공식 CGNAT 해법은 "IPv6 전용"인데, 폰 IPv6가 ERR_ADDRESS_UNREACHABLE였음.
  → IPv4 비활성화가 폰의 IPv6 경로를 정상화할 수도 있으나, 폰 IPv6 미지원/미라우팅이면 효과 없음. (검증 필요)

## Recommended Next Actions (신뢰도 순)
1. **폰을 Wi-Fi로 바꿔 http://100.89.104.5:8080 재시도** — 셀룰러였다면 CGNAT 충돌이 사라져 대개 즉시 됨. (가장 싸고 결정적)
2. Wi-Fi에서도 안 되면 **관리자 콘솔에서 `disable-ipv4` 노드속성 적용**(IPv6 전용) 후 재시도.
3. 셀룰러에서도 어디서든 필요하면 **Cloudflare Tunnel + Access**(또는 ngrok+OAuth) — CGNAT/DNS 전부 우회, 유효 HTTPS. 단 공개 노출이므로 인증 필수.
4. 이름 접속을 원하면 **안드로이드 Private DNS → Off**로 MagicDNS NXDOMAIN 해소.

## Track Coverage
- Claude(A): 7 findings, 공식문서/이슈 중심, confidence high(근본원인)/medium(해법)
- Codex(B): 9 findings, 기술 디테일·CLI 제약, confidence high
- Antigravity(C): SKIP (프롬프트 처리 행)
- Forge(D): EMPTY (reasoning만, tool-failure 한도; 단 Cloudflare/ngrok/RFC6598 URL 보강)

## Quad-consensus Score
가용 2/4 트랙(교차검증 약화 경고). 핵심 주장(CGNAT 근본원인)은 Claude·Codex 만장일치 + 공식문서.
