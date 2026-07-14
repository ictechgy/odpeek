// Open Design 데몬의 웹 UI 포트를 자동 감지한다.
// OD는 재시작할 때마다 랜덤 고포트를 쓰므로 실행 중인 프로세스에서 동적으로 찾아야 한다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

// OD 웹 UI를 서빙하는 사이드카 프로세스의 명령줄 매칭 패턴(정규식 문자열).
// 기존 packaged 번들(web-sidecar.mjs)과 최신 개발/배포 sidecar 엔트리를 함께 지원한다.
// process.title이 next-server로 바뀌는 최신 packaged 런타임은 아래 IPC 소유자 탐색으로 보완한다.
export const DEFAULT_PATTERN =
  'web-sidecar\\.mjs|(@open-design/web|apps/web)/(dist/)?sidecar/index\\.(ts|js)';

const OPEN_DESIGN_IPC_ROOT = '/tmp/open-design/ipc';
const PACKAGED_WEB_CWD_SUFFIX = '/open-design-web-standalone/apps/web';
const PROJECT_API_PROBE = String.raw`
const http = require('node:http');
const port = Number(process.argv[1]);
let size = 0;
const chunks = [];
const fail = () => process.exit(1);
const req = http.get({ host: '127.0.0.1', port, path: '/api/projects', timeout: 1000, agent: false }, (res) => {
  if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) fail();
  res.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) fail();
    chunks.push(chunk);
  });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      process.exit(Array.isArray(parsed?.projects) ? 0 : 1);
    } catch {
      fail();
    }
  });
});
req.on('timeout', () => req.destroy());
req.on('error', fail);
`;

/**
 * 패턴에 매칭되는 프로세스들의 PID 목록을 반환한다.
 * 자기 자신(이 CLI 프로세스)과 부모는 오매칭을 피하기 위해 제외한다.
 * @returns {number[]} 매칭된 PID 배열(매칭 없으면 빈 배열)
 * @throws pgrep 실행 자체가 실패(미설치/권한)하면 에러
 */
function findPids(pattern) {
  let output;
  try {
    output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  } catch (error) {
    // pgrep는 매칭이 없으면 exit code 1로 끝난다(status === 1). 이는 정상.
    if (error.status === 1) return [];
    // 그 외(ENOENT=미설치, 권한 등)는 무매칭과 구분해 에러로 올린다.
    if (error.code === 'ENOENT') {
      throw new Error('pgrep을 찾을 수 없습니다. macOS/Linux에서 실행하세요.');
    }
    throw new Error(`프로세스 검색 실패(pgrep): ${error.message}`);
  }
  const exclude = new Set([process.pid, process.ppid]);
  return output
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && !exclude.has(pid));
}

/** 최신 packaged Next standalone web 프로세스의 cwd 형식인지 확인한다. */
function isPackagedWebCwd(cwd) {
  return typeof cwd === 'string' && cwd.replace(/\/$/, '').endsWith(PACKAGED_WEB_CWD_SUFFIX);
}

/** lsof의 cwd 출력에서 PID의 현재 작업 디렉터리를 읽는다(확인 실패 시 null). */
function processCwd(pid) {
  try {
    const output = execFileSync(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf8' },
    );
    return output.split('\n').find((line) => line.startsWith('n'))?.slice(1) || null;
  } catch (error) {
    if (error.status === 1) return null;
    if (error.code === 'ENOENT') {
      throw new Error('lsof를 찾을 수 없습니다. macOS/Linux에서 실행하세요.');
    }
    return null;
  }
}

/**
 * packaged Next.js는 process.title을 `next-server (...)`로 바꿔 원래 web-sidecar argv가
 * pgrep에서 사라진다. namespace별 web.sock 소유 PID를 찾고 standalone cwd까지 확인해
 * 다른 Next.js 앱을 후보에 넣지 않는다.
 */
function findPackagedWebPids() {
  if (!existsSync(OPEN_DESIGN_IPC_ROOT)) return [];
  const pids = new Set();
  for (const namespace of readdirSync(OPEN_DESIGN_IPC_ROOT)) {
    const socketPath = join(OPEN_DESIGN_IPC_ROOT, namespace, 'web.sock');
    if (!existsSync(socketPath)) continue;
    let output;
    try {
      output = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' });
    } catch (error) {
      if (error.status === 1) continue;
      if (error.code === 'ENOENT') {
        throw new Error('lsof를 찾을 수 없습니다. macOS/Linux에서 실행하세요.');
      }
      continue;
    }
    for (const line of output.split('\n')) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && isPackagedWebCwd(processCwd(pid))) pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * 주어진 PID가 LISTEN 중인 TCP 포트들을 중복 없이 반환한다.
 * IPv4/IPv6가 같은 포트를 두 줄로 보여도 Set으로 합쳐 한 번만 센다.
 * @returns {number[]} 포트 배열(없으면 빈 배열)
 */
function listeningPorts(pid) {
  // lsof는 macOS/Linux 공통으로 존재한다. -a 로 PID 조건과 LISTEN 조건을 AND 결합한다.
  let output;
  try {
    output = execFileSync(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
      { encoding: 'utf8' },
    );
  } catch (error) {
    // lsof는 해당 PID에 LISTEN 소켓이 없으면 exit 1을 반환한다. 최신 개발 런타임의
    // tsx 래퍼처럼 실제 sidecar 자식과 같은 명령줄 패턴을 갖는 비리스닝 부모는 무시한다.
    if (error.status === 1) return [];
    if (error.code === 'ENOENT') {
      throw new Error('lsof를 찾을 수 없습니다. macOS/Linux에서 실행하세요.');
    }
    throw error;
  }
  const ports = new Set();
  for (const line of output.split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

/** 여러 포트 중 Open Design 프로젝트 JSON API를 제공하는 단 하나의 포트를 고른다. */
function selectProjectApiPort(ports) {
  if (ports.length === 1) return ports[0];
  const verified = ports.filter((port) => {
    const result = spawnSync(process.execPath, ['-e', PROJECT_API_PROBE, String(port)], {
      stdio: 'ignore',
      timeout: 1500,
      killSignal: 'SIGKILL',
    });
    return result.status === 0;
  });
  if (verified.length === 1) return verified[0];
  throw new Error(
    `여러 포트(${ports.join(', ')}) 중 Open Design /api/projects 포트를 하나로 식별하지 못했습니다.`,
  );
}

/** Desktop packaged sidecar가 있으면 별도로 실행 중인 default 개발 sidecar보다 우선한다. */
function selectPreferredListener(listeners) {
  const packaged = listeners.filter(({ source }) => source === 'packaged');
  const candidates = packaged.length > 0 ? packaged : listeners;
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `여러 LISTEN 프로세스(${candidates.map(({ pid }) => pid).join(', ')})가 감지되었습니다. ` +
        '--pattern으로 더 구체적인 패턴을 지정하세요(엉뚱한 서비스 노출 방지).',
    );
  }
  return candidates[0];
}

/**
 * Open Design 웹 UI의 현재 로컬 포트를 감지한다.
 * @param {string} pattern OD 프로세스 매칭 패턴
 * @returns {{pid: number, port: number}}
 * @throws OD 미실행, 다중 매칭/다중 API 포트(오노출 위험), 포트 미발견 시 에러
 */
export function detectWebPort(pattern = DEFAULT_PATTERN) {
  if (platform() === 'win32') {
    throw new Error('Windows는 아직 지원하지 않습니다 (lsof/pgrep 의존).');
  }
  const patternPids = findPids(pattern);
  const packagedPids = pattern === DEFAULT_PATTERN ? findPackagedWebPids() : [];
  const packagedSet = new Set(packagedPids);
  const pids = [...new Set([...patternPids, ...packagedPids])];
  if (pids.length === 0) {
    throw new Error(
      'Open Design web-sidecar 프로세스를 찾을 수 없습니다. OD가 실행 중인지 확인하세요.',
    );
  }
  // 최신 개발 런타임은 tsx 래퍼와 실제 Node 자식이 같은 sidecar 경로를 명령줄에
  // 포함한다. 비리스닝 래퍼는 버리고 실제 LISTEN 소켓이 있는 후보만 판정한다.
  const listeners = pids
    .map((pid) => ({
      pid,
      ports: listeningPorts(pid),
      source: packagedSet.has(pid) ? 'packaged' : 'pattern',
    }))
    .filter(({ ports }) => ports.length > 0);
  if (listeners.length === 0) {
    throw new Error(
      `Open Design 후보 PID(${pids.join(', ')})에서 LISTEN 포트를 찾지 못했습니다.`,
    );
  }
  const selected = selectPreferredListener(listeners);
  const port = selectProjectApiPort(selected.ports);
  return { pid: selected.pid, port };
}

export const __openDesignInternals = {
  isPackagedWebCwd,
  selectPreferredListener,
  selectProjectApiPort,
};
