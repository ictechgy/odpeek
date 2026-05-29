// od-mobile CLI 본체 — 명령 파싱과 각 동작 실행을 담당한다.
import { readFileSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  resolveTailscaleBin,
  statusJson,
  selfDnsName,
  selfIp4,
  serveStart,
  serveStop,
  serveStatusText,
} from './tailscale.mjs';
import { detectWebPort, DEFAULT_PATTERN } from './openDesign.mjs';
import { runAuthProxy } from './authProxy.mjs';
import {
  CF_LOG,
  ensureDir,
  saveTunnel,
  readTunnel,
  clearTunnel,
  isAlive,
  extractTrycloudflareUrl,
} from './tunnel.mjs';

// 패키지 메타(버전 출력용)를 루트 package.json에서 읽는다.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

// 분리 프로세스(인증 프록시) 재기동에 쓸 이 CLI의 진입 스크립트 경로.
const BIN_PATH = fileURLToPath(new URL('../bin/od-mobile.mjs', import.meta.url));

// 폰에서 접속할 tailnet 노출 포트. 환경변수 OD_MOBILE_PORT로 덮어쓸 수 있다.
const DEFAULT_PORT = Number(process.env.OD_MOBILE_PORT) || 8080;
// 터널 모드에서 인증 프록시가 듣는 로컬 포트.
const DEFAULT_AUTH_PORT = Number(process.env.OD_MOBILE_AUTH_PORT) || 8765;

const HELP = `od-mobile — Open Design 웹 UI를 폰에서 보기 (Tailscale / Cloudflare 터널)

사용법:
  od-mobile [command] [options]

Commands:
  up        OD를 tailnet에 노출 (Wi-Fi/사설망 권장 — 셀룰러는 통신사 CGNAT 충돌 주의)
  tunnel    OD를 Cloudflare 공개 HTTPS 터널로 노출 (셀룰러/어디서든, Basic 인증 보호)
  off       모든 노출 해제 (serve + 터널)
  ip        tailnet IP 접속 주소 출력
  url       MagicDNS 이름 접속 주소 출력
  status    현재 노출 상태와 감지된 포트 출력
  doctor    환경 진단

Options:
  -p, --port <n>     tailnet 노출 포트 (기본 ${DEFAULT_PORT}, env OD_MOBILE_PORT)
      --pattern <s>  OD 프로세스 매칭 패턴 (기본 ${DEFAULT_PATTERN})
  -h, --help         도움말
  -v, --version      버전

tunnel: cloudflared가 localhost로 아웃바운드 연결하므로 macOS 방화벽/CGNAT/DNS를
        모두 우회한다. 공개 URL이라 OD 앞단에 HTTP Basic 인증을 강제한다
        (비밀번호는 env OD_MOBILE_PASS 또는 실행 시 자동 생성).`;

/** argv를 옵션 객체로 파싱한다. */
function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, pattern: DEFAULT_PATTERN, authPort: DEFAULT_AUTH_PORT, _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--port') {
      opts.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--pattern') {
      opts.pattern = argv[i + 1];
      i += 1;
    } else if (arg === '--auth-port') {
      opts.authPort = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-v' || arg === '--version') {
      opts.version = true;
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

/** tailscale 바이너리를 확보하거나 설치 안내 에러를 던진다. */
function requireTailscale() {
  const bin = resolveTailscaleBin();
  if (!bin) {
    throw new Error(
      'tailscale CLI를 찾을 수 없습니다. https://tailscale.com/download 에서 설치하세요.',
    );
  }
  return bin;
}

/** cloudflared 실행 파일 경로를 찾는다. 없으면 null. */
function resolveCloudflared() {
  for (const candidate of ['cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 다음 후보 시도
    }
  }
  return null;
}

/** OD 포트를 감지해 tailnet에 노출하고 접속 주소를 출력한다. */
function cmdUp(opts) {
  const bin = requireTailscale();
  const { pid, port } = detectWebPort(opts.pattern);
  serveStart(bin, opts.port, port);
  const status = statusJson(bin);
  const ip = selfIp4(status);
  const dns = selfDnsName(status);
  console.log(`OD 웹 UI(localhost:${port}, pid ${pid}) → tailnet 노출 완료.\n`);
  if (ip) console.log(`  폰에서 열기:  http://${ip}:${opts.port}   ← Wi-Fi에서 권장`);
  if (dns) console.log(`  (이름으로도:  http://${dns}:${opts.port})`);
  console.log('\n  셀룰러에서 막히면 → od-mobile tunnel');
  console.log('  해제: od-mobile off');
}

/** 실행 중인 cloudflared 터널과 인증 프록시를 종료한다. */
function stopRunningTunnel() {
  const state = readTunnel();
  if (state) {
    for (const pid of [state.cfPid, state.proxyPid]) {
      if (pid && isAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // 이미 종료됨
        }
      }
    }
  }
  clearTunnel();
}

/**
 * OD를 Cloudflare 빠른 터널로 공개 노출한다(Basic 인증 보호).
 * cloudflared → localhost 인증 프록시 → OD 순서로 연결한다.
 */
async function cmdTunnel(opts) {
  const cloudflared = resolveCloudflared();
  if (!cloudflared) {
    throw new Error('cloudflared가 없습니다. `brew install cloudflared`로 설치하세요.');
  }
  const { pid: odPid, port: targetPort } = detectWebPort(opts.pattern);

  // 자격 증명: env 우선, 없으면 무작위 생성(보안 기본값).
  const user = process.env.OD_MOBILE_USER || 'od';
  const pass = process.env.OD_MOBILE_PASS || randomBytes(9).toString('base64url');

  stopRunningTunnel();
  ensureDir();

  // 1) 인증 프록시(localhost) 기동 — 분리 프로세스.
  const proxyLog = openSync(`${CF_LOG}.proxy`, 'a');
  const proxy = spawn(
    process.execPath,
    [BIN_PATH, '__authproxy', String(opts.authPort), String(targetPort), user, pass],
    { detached: true, stdio: ['ignore', proxyLog, proxyLog] },
  );
  proxy.unref();
  await sleep(400); // 프록시 listen 대기

  // 2) cloudflared 빠른 터널 기동 — 인증 프록시로 연결.
  const cfLogFd = openSync(CF_LOG, 'w'); // 매 실행 로그 초기화
  const cf = spawn(
    cloudflared,
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${opts.authPort}`],
    { detached: true, stdio: ['ignore', cfLogFd, cfLogFd] },
  );
  cf.unref();

  // 3) 로그에서 공개 URL 폴링(최대 ~30초).
  let url = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    try {
      url = extractTrycloudflareUrl(readFileSync(CF_LOG, 'utf8'));
    } catch {
      url = null;
    }
    if (url) break;
    if (!isAlive(cf.pid)) break; // cloudflared가 죽으면 중단
  }

  saveTunnel({
    cfPid: cf.pid,
    proxyPid: proxy.pid,
    authPort: opts.authPort,
    targetPort,
    odPid,
    user,
    url,
  });

  if (!url) {
    throw new Error(`공개 URL을 얻지 못했습니다. 로그 확인: ${CF_LOG}`);
  }
  console.log(`OD 웹 UI(localhost:${targetPort}) → Cloudflare 터널 노출 완료.\n`);
  console.log(`  폰에서 열기(셀룰러 OK):  ${url}`);
  console.log(`  로그인 — 아이디: ${user}   비밀번호: ${pass}\n`);
  console.log('  ※ 공개 URL이지만 Basic 인증으로 보호됩니다. URL은 실행마다 바뀝니다.');
  console.log('  해제: od-mobile off');
}

/** (내부용) 분리 프로세스로 호출되어 Basic 인증 프록시를 돌린다. */
function cmdAuthProxy(opts) {
  const [, listenPort, targetPort, user, pass] = opts._;
  runAuthProxy(Number(listenPort), Number(targetPort), user, pass);
}

/** 모든 노출(serve + 터널)을 해제한다. */
function cmdOff() {
  stopRunningTunnel();
  const bin = resolveTailscaleBin();
  if (bin) {
    try {
      serveStop(bin, DEFAULT_PORT);
    } catch {
      // serve 설정이 없을 수 있음
    }
  }
  console.log('노출 해제됨 (serve + 터널).');
}

/** tailnet IP 기반 접속 주소를 출력한다(DNS 불필요). */
function cmdIp(opts) {
  const ip = selfIp4(statusJson(requireTailscale()));
  if (!ip) {
    throw new Error('tailnet IP를 확인할 수 없습니다. tailscale 연결 상태를 확인하세요.');
  }
  console.log(`http://${ip}:${opts.port}`);
}

/** MagicDNS 이름 기반 접속 주소를 출력한다. */
function cmdUrl(opts) {
  const dns = selfDnsName(statusJson(requireTailscale()));
  if (!dns) {
    throw new Error('MagicDNS 이름을 확인할 수 없습니다. tailscale 연결 상태를 확인하세요.');
  }
  console.log(`http://${dns}:${opts.port}`);
}

/** 현재 노출 상태(serve + 터널)와 감지된 OD 포트를 출력한다. */
function cmdStatus(opts) {
  const bin = resolveTailscaleBin();
  console.log('[tailscale serve]');
  console.log(bin ? serveStatusText(bin) : 'tailscale 미설치');

  const tunnel = readTunnel();
  if (tunnel?.cfPid && isAlive(tunnel.cfPid)) {
    console.log(`\n[Cloudflare 터널] 실행 중 — ${tunnel.url || '(URL 미확인)'}`);
  } else {
    console.log('\n[Cloudflare 터널] 실행 중이 아님');
  }

  try {
    const { pid, port } = detectWebPort(opts.pattern);
    console.log(`\n[Open Design] web 포트 ${port} (pid ${pid})`);
  } catch (error) {
    console.log(`\n[Open Design] ${error.message}`);
  }
}

/** tailscale / OD / MagicDNS 환경을 점검해 체크리스트를 출력한다. */
function cmdDoctor(opts) {
  const bin = resolveTailscaleBin();
  let status = null;
  if (bin) {
    try {
      status = statusJson(bin);
    } catch {
      status = null;
    }
  }
  const checks = [
    ['tailscale 설치', Boolean(bin), bin || '미설치'],
    ['tailscale 연결', status?.BackendState === 'Running', status?.BackendState ?? 'unknown'],
    ['MagicDNS 이름', Boolean(status && selfDnsName(status)), (status && selfDnsName(status)) || '없음'],
    ['tailnet IP', Boolean(status && selfIp4(status)), (status && selfIp4(status)) || '없음'],
    ['cloudflared 설치', Boolean(resolveCloudflared()), resolveCloudflared() || '미설치'],
  ];
  try {
    const { port } = detectWebPort(opts.pattern);
    checks.push(['Open Design 실행', true, `web 포트 ${port}`]);
  } catch (error) {
    checks.push(['Open Design 실행', false, error.message]);
  }
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(16)} ${detail}`);
  }
}

// 명령 이름 → 핸들러 매핑.
const COMMANDS = {
  up: cmdUp,
  tunnel: cmdTunnel,
  off: cmdOff,
  ip: cmdIp,
  url: cmdUrl,
  status: cmdStatus,
  doctor: cmdDoctor,
  __authproxy: cmdAuthProxy,
};

/**
 * CLI 진입 함수. bin/od-mobile.mjs에서 호출한다.
 * @param {string[]} argv process.argv.slice(2)
 */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.version) {
    console.log(pkg.version);
    return;
  }
  const command = opts._[0] ?? 'up';
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`알 수 없는 명령: ${command}\n\n${HELP}`);
  }
  await handler(opts);
}
