// od-mobile CLI 본체 — 명령 파싱과 각 동작 실행을 담당한다.
import { readFileSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  processMatches,
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
// 터널 유휴 자동 종료(분). 0이면 비활성. 노출 시간을 줄여 공격 표면을 축소한다.
const DEFAULT_IDLE_MIN = process.env.OD_MOBILE_IDLE_MIN !== undefined
  ? Number(process.env.OD_MOBILE_IDLE_MIN)
  : 30;
// 인증 시도 로그 경로.
const AUTH_LOG = join(homedir(), '.od-mobile', 'auth.log');

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
      --idle <min>   터널 유휴 자동 종료(분, 0=비활성, 기본 ${DEFAULT_IDLE_MIN}, env OD_MOBILE_IDLE_MIN)
  -h, --help         도움말
  -v, --version      버전

tunnel: cloudflared가 localhost로 아웃바운드 연결하므로 macOS 방화벽/CGNAT/DNS를
        모두 우회한다. 공개 URL이라 OD 앞단에 HTTP Basic 인증을 강제한다
        (비밀번호는 env OD_MOBILE_PASS 또는 실행 시 자동 생성).`;

/** argv를 옵션 객체로 파싱한다. */
function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    pattern: DEFAULT_PATTERN,
    authPort: DEFAULT_AUTH_PORT,
    idleMin: DEFAULT_IDLE_MIN,
    _: [],
  };
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
    } else if (arg === '--idle') {
      opts.idleMin = Number(argv[i + 1]);
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

/**
 * 포트·유휴 옵션이 유효 범위인지 검증한다.
 * 잘못된 값(NaN/0/음수/범위 초과)이 listen·터널 인자로 무음 전파되어 인증 프록시
 * 우회나 진단 불가 실패로 이어지는 것을 막는다.
 */
function assertValidOpts(opts) {
  for (const [name, value] of [['--port', opts.port], ['--auth-port', opts.authPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} 값이 올바르지 않습니다. 1~65535 정수여야 합니다: ${value}`);
    }
  }
  if (opts.port === opts.authPort) {
    throw new Error(`--port와 --auth-port는 서로 달라야 합니다: ${opts.port}`);
  }
  if (!Number.isFinite(opts.idleMin) || opts.idleMin < 0) {
    throw new Error(`--idle 값이 올바르지 않습니다. 0 이상이어야 합니다: ${opts.idleMin}`);
  }
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

/**
 * cloudflared 실행 파일 경로를 찾는다. 없으면 null.
 * 신뢰 가능한 절대 경로를 먼저 시도하고, 마지막에 PATH를 본다(PATH 하이재킹 완화).
 */
function resolveCloudflared() {
  for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', 'cloudflared']) {
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
    // PID 재사용으로 무관한 프로세스를 죽이지 않도록 명령줄 시그니처를 확인한다.
    const targets = [
      { pid: state.proxyPid, needle: '__authproxy' },
      { pid: state.cfPid, needle: 'cloudflared' },
    ];
    for (const { pid, needle } of targets) {
      if (pid && isAlive(pid) && processMatches(pid, needle)) {
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

  const idleMs = Number.isFinite(opts.idleMin) && opts.idleMin > 0 ? opts.idleMin * 60000 : 0;

  stopRunningTunnel();
  ensureDir();

  // 1) 인증 프록시(localhost) 기동 — 분리 프로세스. (유휴 종료/로그 인자 포함)
  // 자격증명(user/pass)은 argv 대신 환경변수로 넘긴다. argv는 `ps`/`/proc`로 같은
  // 머신의 다른 사용자에게 노출되지만, 환경변수는 프로세스 소유자만 읽을 수 있다.
  const proxyLog = openSync(`${CF_LOG}.proxy`, 'a');
  const proxy = spawn(
    process.execPath,
    [
      BIN_PATH, '__authproxy',
      String(opts.authPort), String(targetPort),
      String(idleMs), AUTH_LOG,
    ],
    {
      detached: true,
      stdio: ['ignore', proxyLog, proxyLog],
      env: { ...process.env, OD_MOBILE_USER: user, OD_MOBILE_PASS: pass },
    },
  );
  proxy.unref();
  closeSync(proxyLog); // 자식이 fd를 복제했으므로 부모 측 원본은 닫는다(누수 방지)
  await sleep(400); // 프록시 listen 대기

  // 2) cloudflared 빠른 터널 기동 — 인증 프록시로 연결.
  const cfLogFd = openSync(CF_LOG, 'w'); // 매 실행 로그 초기화
  const cf = spawn(
    cloudflared,
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${opts.authPort}`],
    { detached: true, stdio: ['ignore', cfLogFd, cfLogFd] },
  );
  cf.unref();
  closeSync(cfLogFd); // 부모 측 fd 닫기(자식이 복제 보유)

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
  console.log('  ※ 공개 URL이지만 Basic 인증·무차별대입 잠금·보안 헤더로 보호됩니다.');
  console.log(`  ※ ${idleMs ? `${opts.idleMin}분 유휴 시 자동 종료` : '유휴 자동종료 비활성'} · 시도 로그: ${AUTH_LOG}`);
  console.log('  ※ URL은 실행마다 바뀝니다. 해제: od-mobile off');
}

/** (내부용) 분리 프로세스로 호출되어 Basic 인증 프록시를 돌린다. */
function cmdAuthProxy(opts) {
  const [, listenPort, targetPort, idleMs, logFile] = opts._;
  // 자격증명은 argv가 아닌 환경변수로 전달받는다(부모가 spawn env로 주입).
  const user = process.env.OD_MOBILE_USER || 'od';
  const pass = process.env.OD_MOBILE_PASS || '';
  runAuthProxy(Number(listenPort), Number(targetPort), user, pass, {
    idleMs: Number(idleMs) || 0,
    logFile,
  });
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
  // 내부 프록시 호출(__authproxy)은 위치 인자로 포트를 받으므로 옵션 검증에서 제외한다.
  if (command !== '__authproxy') {
    assertValidOpts(opts);
  }
  await handler(opts);
}
