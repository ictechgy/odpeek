// Tailscale CLI 래퍼 — tailnet 정보 조회와 serve 프록시 제어를 담당한다.
import { execFileSync } from 'node:child_process';

// macOS GUI 앱은 tailscale 바이너리를 PATH에 안 넣는 경우가 있어 후보 경로를 함께 탐색한다.
const MAC_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// 신뢰 가능한 절대 경로(패키지 매니저/앱 번들)를 먼저 시도하고, 마지막에 PATH를 본다.
// 오염된 PATH로 공격자 제어 tailscale이 실행되는 것을 완화한다(PATH 하이재킹 방어).
const TAILSCALE_CANDIDATES = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  MAC_APP_BIN,
  'tailscale', // PATH는 최후순위
];

/**
 * 사용 가능한 tailscale 실행 파일 경로를 반환한다.
 * @returns {string|null} 실행 파일 경로, 없으면 null
 */
export function resolveTailscaleBin() {
  for (const candidate of TAILSCALE_CANDIDATES) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 다음 후보 시도
    }
  }
  return null;
}

/** tailscale 명령을 실행하고 표준출력 문자열을 반환한다. */
function runTailscale(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8' });
}

/**
 * `tailscale status --json` 결과를 파싱해 반환한다.
 * @returns {object} 파싱된 상태 객체
 */
export function statusJson(bin) {
  return JSON.parse(runTailscale(bin, ['status', '--json']));
}

/**
 * 이 노드의 MagicDNS 이름을 반환한다(끝의 점 제거).
 * @returns {string|null} 예: "host.tailnet.ts.net", 없으면 null
 */
export function selfDnsName(status) {
  const name = status?.Self?.DNSName;
  return name ? name.replace(/\.$/, '') : null;
}

/**
 * 이 노드의 첫 IPv4 tailnet 주소를 반환한다.
 * @returns {string|null} 예: "100.x.y.z", 없으면 null
 */
export function selfIp4(status) {
  const ips = status?.Self?.TailscaleIPs ?? [];
  return ips.find((ip) => ip.includes('.')) ?? null;
}

/**
 * localhost:targetPort 를 tailnet의 servePort로 노출한다(L4 TCP 패스스루).
 *
 * 두 가지 macOS 제약을 동시에 우회하기 위해 TCP 모드를 쓴다:
 *  1) macOS 방화벽(스텔스)+유저스페이스 네트워킹 → 일반 바인딩 소켓은 피어에게
 *     안 닿으므로 tailscaled를 거치는 serve가 필요하다.
 *  2) serve의 HTTP 모드는 MagicDNS '이름'으로 vhost 라우팅하여 IP 접속이 404가
 *     된다. `--tcp`(L4)는 Host를 보지 않고 그대로 흘려보내므로 IP로도 접속된다
 *     (폰 MagicDNS 설정과 무관 → 가장 견고).
 */
export function serveStart(bin, servePort, targetPort) {
  runTailscale(bin, [
    'serve',
    '--bg',
    `--tcp=${servePort}`,
    `tcp://127.0.0.1:${targetPort}`,
  ]);
}

/** servePort 노출을 해제한다. */
export function serveStop(bin, servePort) {
  runTailscale(bin, ['serve', `--tcp=${servePort}`, 'off']);
}

/**
 * 현재 serve 설정 텍스트를 반환한다.
 * @returns {string} 설정이 없으면 "No serve config"
 */
export function serveStatusText(bin) {
  try {
    return runTailscale(bin, ['serve', 'status']).trim();
  } catch {
    return 'No serve config';
  }
}
