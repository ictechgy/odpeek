// Tailscale CLI 래퍼 — tailnet 정보 조회와 serve 프록시 제어를 담당한다.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// macOS GUI 앱은 tailscale 바이너리를 PATH에 안 넣는 경우가 있어 후보 경로를 함께 탐색한다.
const MAC_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * 사용 가능한 tailscale 실행 파일 경로를 반환한다.
 * @returns {string|null} 실행 파일 경로, 없으면 null
 */
export function resolveTailscaleBin() {
  try {
    // PATH에 등록돼 있으면 그대로 사용한다.
    execFileSync('tailscale', ['version'], { stdio: 'ignore' });
    return 'tailscale';
  } catch {
    // PATH에 없을 때 macOS 앱 번들 경로를 시도한다.
    return existsSync(MAC_APP_BIN) ? MAC_APP_BIN : null;
  }
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
 * localhost:targetPort 를 tailnet의 servePort(HTTP)로 노출한다.
 * tailnet 인증서가 없어도 동작하도록 HTTPS 대신 평문 HTTP를 쓴다
 * (트래픽은 Tailscale의 WireGuard로 이미 암호화된다).
 */
export function serveStart(bin, servePort, targetPort) {
  runTailscale(bin, [
    'serve',
    '--bg',
    `--http=${servePort}`,
    `http://127.0.0.1:${targetPort}`,
  ]);
}

/** servePort 노출을 해제한다. */
export function serveStop(bin, servePort) {
  runTailscale(bin, ['serve', `--http=${servePort}`, 'off']);
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
