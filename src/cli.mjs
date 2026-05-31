// odpeek CLI 본체 — 명령 파싱과 각 동작 실행을 담당한다.
import { readFileSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
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
  isValidPort,
} from './tunnel.mjs';

// 패키지 메타(버전 출력용)를 루트 package.json에서 읽는다.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

// 분리 프로세스(인증 프록시) 재기동에 쓸 이 CLI의 진입 스크립트 경로.
const BIN_PATH = fileURLToPath(new URL('../bin/odpeek.mjs', import.meta.url));

// 폰에서 접속할 tailnet 노출 포트. 환경변수 ODPEEK_PORT로 덮어쓸 수 있다.
const DEFAULT_PORT = Number(process.env.ODPEEK_PORT) || 8080;
// 터널 모드에서 인증 프록시가 듣는 로컬 포트.
const DEFAULT_AUTH_PORT = Number(process.env.ODPEEK_AUTH_PORT) || 8765;
// 터널 유휴 자동 종료(분). 0이면 비활성. 노출 시간을 줄여 공격 표면을 축소한다.
const DEFAULT_IDLE_MIN = process.env.ODPEEK_IDLE_MIN !== undefined
  ? Number(process.env.ODPEEK_IDLE_MIN)
  : 30;
// 인증 시도 로그 경로.
const AUTH_LOG = join(homedir(), '.odpeek', 'auth.log');
// 터널 모드 인증 프록시의 기본 사용자명(부모/자식이 같은 정의를 공유).
const DEFAULT_AUTH_USER = 'od';
// 인증 프록시 기동 대기와 공개 URL 폴링 타이밍.
const PROXY_READY_TIMEOUT_MS = 5000;
const PROXY_READY_INTERVAL_MS = 150;
const URL_POLL_INTERVAL_MS = 500;
const URL_POLL_TIMEOUT_MS = 30000;

const HELP = `odpeek — Open Design 웹 UI를 폰에서 보기 (Tailscale / Cloudflare 터널)

사용법:
  odpeek [command] [options]

Commands:
  up        OD를 tailnet에 노출 (Wi-Fi/사설망 권장 — 셀룰러는 통신사 CGNAT 충돌 주의)
  tunnel    OD를 Cloudflare 공개 HTTPS 터널로 노출 (셀룰러/어디서든, Basic 인증 보호)
  off       모든 노출 해제 (serve + 터널; up에서 --port를 줬다면 off에도 같은 --port)
  ip        tailnet IP 접속 주소 출력
  url       MagicDNS 이름 접속 주소 출력
  status    현재 노출 상태와 감지된 포트 출력
  doctor    환경 진단

Options:
  -p, --port <n>     tailnet 노출 포트 (기본 ${DEFAULT_PORT}, env ODPEEK_PORT)
      --auth-port <n> 터널 인증 프록시 로컬 포트 (기본 ${DEFAULT_AUTH_PORT}, env ODPEEK_AUTH_PORT)
      --pattern <s>  OD 프로세스 매칭 패턴 (기본 ${DEFAULT_PATTERN})
      --idle <min>   터널 유휴 자동 종료(분, 0=비활성, 기본 ${DEFAULT_IDLE_MIN}, env ODPEEK_IDLE_MIN)
  -h, --help         도움말
  -v, --version      버전

tunnel: cloudflared가 localhost로 아웃바운드 연결하므로 macOS 방화벽/CGNAT/DNS를
        모두 우회한다. 공개 URL이라 OD 앞단에 HTTP Basic 인증을 강제한다
        (비밀번호는 env ODPEEK_PASS 또는 실행 시 자동 생성).`;

/** 값을 받는 옵션의 다음 인자를 반환한다. 누락 시 명확한 에러를 던진다. */
function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`옵션 ${name}에 값이 필요합니다.`);
  }
  return value;
}

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
      opts.port = Number(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--pattern') {
      opts.pattern = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--auth-port') {
      opts.authPort = Number(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--idle') {
      opts.idleMin = Number(requireValue(argv, i, arg));
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

/**
 * 검증된 idleMin(분)을 밀리초로 변환한다. assertValidOpts가 0 이상 유한수임을
 * 이미 보장하므로 여기서는 재검증하지 않는다(검증 로직 단일화).
 * @returns {number} 유휴 종료 밀리초(0이면 비활성)
 */
function toIdleMs(idleMin) {
  return idleMin > 0 ? idleMin * 60000 : 0;
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
  console.log('\n  셀룰러에서 막히면 → odpeek tunnel');
  console.log('  해제: odpeek off');
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

/** 인증 프록시(__authproxy)에 넘길 위치 인자 배열을 만든다(parseAuthProxyArgs와 대칭). */
function buildAuthProxyArgs({ authPort, targetPort, idleMs, logFile }) {
  return [
    BIN_PATH, '__authproxy',
    String(authPort), String(targetPort),
    String(idleMs), logFile,
  ];
}

/**
 * 인증 프록시를 분리 프로세스로 기동한다.
 * 자격증명(user/pass)은 argv 대신 환경변수로 넘긴다. argv는 `ps`/`/proc`로 같은
 * 머신의 다른 사용자에게 노출되지만, 환경변수는 프로세스 소유자만 읽을 수 있다.
 */
function spawnAuthProxy(authPort, targetPort, creds, idleMs) {
  const proxyLog = openSync(`${CF_LOG}.proxy`, 'a');
  const child = spawn(
    process.execPath,
    buildAuthProxyArgs({ authPort, targetPort, idleMs, logFile: AUTH_LOG }),
    {
      detached: true,
      stdio: ['ignore', proxyLog, proxyLog],
      env: { ...process.env, ODPEEK_USER: creds.user, ODPEEK_PASS: creds.pass },
    },
  );
  child.unref();
  closeSync(proxyLog); // 자식이 fd를 복제했으므로 부모 측 원본은 닫는다(누수 방지)
  return child;
}

/**
 * 프록시가 인증 챌린지(401 + realm="odpeek")로 응답하는지 한 번 확인한다.
 * 이 검사는 "프록시가 떴는지"와 "그 포트의 서비스가 실제로 우리 프록시인지"를
 * 동시에 보장한다(엉뚱한 로컬 서비스를 공개 노출하는 사고 방지).
 * @returns {Promise<boolean>} 우리 프록시의 401 챌린지면 true, 아니면(거부/오류) false
 */
function proxyChallengeOk(authPort) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: authPort, path: '/', timeout: 1000 }, (res) => {
      const challenge = String(res.headers['www-authenticate'] || '');
      const ok = res.statusCode === 401 && challenge.includes('realm="odpeek"');
      res.resume(); // 응답 본문 소비(소켓 해제)
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * cloudflared를 띄우기 전에 인증 프록시가 실제로 준비됐는지 검증한다.
 * 고정 sleep 대신 (1) 프록시 조기 종료 감지 (2) 401 챌린지 확인을 폴링한다.
 * @throws 준비 실패(조기 종료/타임아웃) 시 에러
 */
async function waitForProxyReady(authPort, proxy) {
  let exited = false;
  proxy.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`인증 프록시가 시작 직후 종료되었습니다. 로그 확인: ${CF_LOG}.proxy`);
    }
    if (await proxyChallengeOk(authPort)) return;
    await sleep(PROXY_READY_INTERVAL_MS);
  }
  throw new Error(`인증 프록시가 준비되지 않았습니다(>${PROXY_READY_TIMEOUT_MS}ms). 로그 확인: ${CF_LOG}.proxy`);
}

/** cloudflared 빠른 터널을 분리 프로세스로 기동한다. */
function spawnCloudflared(cloudflared, authPort) {
  const cfLogFd = openSync(CF_LOG, 'w'); // 매 실행 로그 초기화
  const child = spawn(
    cloudflared,
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${authPort}`],
    { detached: true, stdio: ['ignore', cfLogFd, cfLogFd] },
  );
  child.unref();
  closeSync(cfLogFd); // 부모 측 fd 닫기(자식이 복제 보유)
  return child;
}

/** cloudflared 로그에서 공개 URL을 폴링한다(타임아웃/프로세스 사망 시 null). */
async function pollPublicUrl(cf) {
  const attempts = Math.ceil(URL_POLL_TIMEOUT_MS / URL_POLL_INTERVAL_MS);
  for (let i = 0; i < attempts; i += 1) {
    await sleep(URL_POLL_INTERVAL_MS);
    let url = null;
    try {
      url = extractTrycloudflareUrl(readFileSync(CF_LOG, 'utf8'));
    } catch {
      url = null; // 로그 파일이 아직 없을 수 있음
    }
    if (url) return url;
    if (!isAlive(cf.pid)) return null; // cloudflared가 죽으면 중단
  }
  return null;
}

/** 기동 실패 시 방금 띄운 자식 프로세스와 상태 파일을 정리한다. */
function cleanupTunnelChildren(children) {
  for (const child of children) {
    if (child?.pid && isAlive(child.pid)) {
      try {
        process.kill(child.pid);
      } catch {
        // 이미 종료됨
      }
    }
  }
  clearTunnel();
}

/** 터널 노출 성공 결과를 출력한다. */
function printTunnelResult({ targetPort, url, user, pass, idleMs, idleMin }) {
  console.log(`OD 웹 UI(localhost:${targetPort}) → Cloudflare 터널 노출 완료.\n`);
  console.log(`  폰에서 열기(셀룰러 OK):  ${url}`);
  console.log(`  로그인 — 아이디: ${user}   비밀번호: ${pass}\n`);
  console.log('  ※ 공개 URL이지만 Basic 인증·무차별대입 잠금·보안 헤더로 보호됩니다.');
  console.log(`  ※ ${idleMs ? `${idleMin}분 유휴 시 자동 종료` : '유휴 자동종료 비활성'} · 시도 로그: ${AUTH_LOG}`);
  console.log('  ※ URL은 실행마다 바뀝니다. 해제: odpeek off');
}

/**
 * OD를 Cloudflare 빠른 터널로 공개 노출한다(Basic 인증 보호).
 * cloudflared → localhost 인증 프록시 → OD 순서로 연결한다.
 * 프록시 준비를 검증한 뒤에만 터널을 열고, 실패 시 자식 프로세스를 정리한다.
 */
async function cmdTunnel(opts) {
  const cloudflared = resolveCloudflared();
  if (!cloudflared) {
    throw new Error('cloudflared가 없습니다. `brew install cloudflared`로 설치하세요.');
  }
  const { pid: odPid, port: targetPort } = detectWebPort(opts.pattern);

  // 자격 증명: env 우선, 없으면 무작위 생성(보안 기본값).
  const user = process.env.ODPEEK_USER || DEFAULT_AUTH_USER;
  const pass = process.env.ODPEEK_PASS || randomBytes(9).toString('base64url');
  const idleMs = toIdleMs(opts.idleMin);

  stopRunningTunnel();
  ensureDir();

  let proxy = null;
  let cf = null;
  try {
    // 1) 인증 프록시 기동 → 실제로 401 챌린지에 응답할 때까지 검증.
    proxy = spawnAuthProxy(opts.authPort, targetPort, { user, pass }, idleMs);
    await waitForProxyReady(opts.authPort, proxy);

    // 2) 프록시가 확인된 뒤에만 cloudflared 터널을 연다.
    cf = spawnCloudflared(cloudflared, opts.authPort);

    // 3) 공개 URL을 얻은 뒤에만 상태를 저장한다(부분 상태 잔존 방지).
    const url = await pollPublicUrl(cf);
    if (!url) {
      throw new Error(`공개 URL을 얻지 못했습니다. 로그 확인: ${CF_LOG}`);
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
    printTunnelResult({ targetPort, url, user, pass, idleMs, idleMin: opts.idleMin });
  } catch (error) {
    // 부분 기동 상태를 남기지 않는다: 띄운 자식과 상태 파일을 정리하고 재던진다.
    cleanupTunnelChildren([proxy, cf]);
    throw error;
  }
}

/** __authproxy 위치 인자를 구조화해 파싱한다(buildAuthProxyArgs와 대칭). */
function parseAuthProxyArgs(positional) {
  const [, listenPort, targetPort, idleMs, logFile] = positional;
  return {
    listenPort: Number(listenPort),
    targetPort: Number(targetPort),
    idleMs: Number(idleMs) || 0,
    logFile,
  };
}

/** (내부용) 분리 프로세스로 호출되어 Basic 인증 프록시를 돌린다. */
function cmdAuthProxy(opts) {
  const { listenPort, targetPort, idleMs, logFile } = parseAuthProxyArgs(opts._);
  // 내부 진입점도 자기완결적으로 검증한다(직접 호출/오용 시 NaN 포트 전파 차단).
  if (!isValidPort(listenPort) || !isValidPort(targetPort)) {
    console.error(`인증 프록시 포트가 올바르지 않습니다: listen=${listenPort}, target=${targetPort}`);
    process.exit(1);
  }
  // 자격증명은 argv가 아닌 환경변수로 전달받는다(부모가 spawn env로 주입).
  const user = process.env.ODPEEK_USER || DEFAULT_AUTH_USER;
  const pass = process.env.ODPEEK_PASS || '';
  // 빈 비밀번호로는 프록시를 시작하지 않는다(빈 자격 인증 우회 차단 — 심층 방어).
  if (!pass) {
    console.error('자격증명(ODPEEK_PASS)이 비어 있어 인증 프록시를 시작하지 않습니다.');
    process.exit(1);
  }
  runAuthProxy(listenPort, targetPort, user, pass, { idleMs, logFile });
}

/** 모든 노출(serve + 터널)을 해제한다. */
function cmdOff(opts) {
  stopRunningTunnel();
  const bin = resolveTailscaleBin();
  if (bin) {
    try {
      // up에서 쓴 포트와 동일하게 해제한다(기본값이 아닌 --port 노출도 정리).
      serveStop(bin, opts.port);
    } catch {
      // serve 설정이 없을 수 있음
    }
  }
  console.log(`노출 해제됨 (serve 포트 ${opts.port} + 터널).`);
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
  const cloudflaredBin = resolveCloudflared();
  const checks = [
    ['tailscale 설치', Boolean(bin), bin || '미설치'],
    ['tailscale 연결', status?.BackendState === 'Running', status?.BackendState ?? 'unknown'],
    ['MagicDNS 이름', Boolean(status && selfDnsName(status)), (status && selfDnsName(status)) || '없음'],
    ['tailnet IP', Boolean(status && selfIp4(status)), (status && selfIp4(status)) || '없음'],
    ['cloudflared 설치', Boolean(cloudflaredBin), cloudflaredBin || '미설치'],
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
 * CLI 진입 함수. bin/odpeek.mjs에서 호출한다.
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
