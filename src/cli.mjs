// od-mobile CLI 본체 — 명령 파싱과 각 동작 실행을 담당한다.
import { readFileSync } from 'node:fs';
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

// 패키지 메타(버전 출력용)를 루트 package.json에서 읽는다.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

// 폰에서 접속할 tailnet 노출 포트. 환경변수 OD_MOBILE_PORT로 덮어쓸 수 있다.
const DEFAULT_PORT = Number(process.env.OD_MOBILE_PORT) || 8080;

const HELP = `od-mobile — Open Design 웹 UI를 Tailscale tailnet에 노출해 폰에서 보기

사용법:
  od-mobile [command] [options]

Commands:
  up        (기본) OD 포트를 감지해 tailnet에 노출
  off       노출 해제
  url       폰에서 열 주소(MagicDNS 이름) 출력
  status    현재 serve 상태와 감지된 포트 출력
  doctor    환경 진단(tailscale / OD / MagicDNS)

Options:
  -p, --port <n>     tailnet 노출 포트 (기본 ${DEFAULT_PORT}, env OD_MOBILE_PORT)
      --pattern <s>  OD 프로세스 매칭 패턴 (기본 ${DEFAULT_PATTERN})
  -h, --help         도움말
  -v, --version      버전

참고: tailscale serve는 MagicDNS '이름'에만 응답하므로(IP 불가), 폰에서
      Tailscale 앱의 "Use Tailscale DNS"를 켜고 이름 주소로 접속해야 한다.`;

/**
 * argv를 옵션 객체로 파싱한다.
 * @returns {{port:number, pattern:string, help?:boolean, version?:boolean, _:string[]}}
 */
function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, pattern: DEFAULT_PATTERN, _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--port') {
      opts.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--pattern') {
      opts.pattern = argv[i + 1];
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

/** OD 포트를 감지해 tailnet에 노출하고 접속 주소를 출력한다. */
function cmdUp(opts) {
  const bin = requireTailscale();
  const { pid, port } = detectWebPort(opts.pattern);
  serveStart(bin, opts.port, port);
  const dns = selfDnsName(statusJson(bin));
  console.log(`OD 웹 UI(localhost:${port}, pid ${pid}) → tailnet 노출 완료.\n`);
  if (dns) {
    console.log(`  폰에서 열기:  http://${dns}:${opts.port}`);
  } else {
    console.log('  MagicDNS 이름을 확인하지 못했습니다. `od-mobile doctor`로 점검하세요.');
  }
  console.log('\n  ※ 폰 Tailscale 앱에서 "Use Tailscale DNS"가 켜져 있어야 이름이 풀립니다.');
  console.log('  해제: od-mobile off');
}

/** tailnet 노출을 해제한다. */
function cmdOff(opts) {
  serveStop(requireTailscale(), opts.port);
  console.log('노출 해제됨.');
}

/** MagicDNS 이름 기반 접속 주소를 출력한다. */
function cmdUrl(opts) {
  const dns = selfDnsName(statusJson(requireTailscale()));
  if (!dns) {
    throw new Error('MagicDNS 이름을 확인할 수 없습니다. tailscale 연결 상태를 확인하세요.');
  }
  console.log(`http://${dns}:${opts.port}`);
}

/** 현재 serve 상태와 감지된 OD 포트를 출력한다. */
function cmdStatus(opts) {
  const bin = requireTailscale();
  console.log('[tailscale serve]');
  console.log(serveStatusText(bin));
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
  off: cmdOff,
  url: cmdUrl,
  status: cmdStatus,
  doctor: cmdDoctor,
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
