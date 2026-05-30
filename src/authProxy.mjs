// localhost 전용 HTTP/WebSocket 리버스 프록시 + HTTP Basic 인증(하드닝 포함).
//
// cloudflared 빠른 터널은 공개 URL을 만들지만 누구나 접근 가능하다. OD에는 인증이
// 없으므로, cloudflared → 이 프록시 → OD 순서로 두어 Basic 인증을 강제한다.
// 이 프록시는 127.0.0.1에만 바인딩하고 cloudflared도 localhost로 붙으므로
// macOS 방화벽 인바운드 제약과 무관하다.
//
// 하드닝: 실제 클라이언트 IP(CF-Connecting-IP, 형식 검증 후) 기준 무차별대입 잠금
// + 전역 스로틀(헤더 회전/분산 IP 대비), 보안 응답 헤더, 인증 시도 로그(제어문자
// 살균), 유휴 자동 종료(터널까지 정리), upstream 헤더 정리, WebSocket 핸드셰이크
// 검증(101 확인 후에만 파이프 → 인증 우회 차단).
import http from 'node:http';
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { readTunnel, clearTunnel, isAlive, processMatches } from './tunnel.mjs';

// 무차별대입 방어: 한 IP가 MAX_FAILS회 실패하면 LOCK_MS 동안 차단.
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;
// IP별 실패 추적 Map의 상한(메모리 고갈 DoS 방어). 초과 시 새 IP는 추적하지 않고
// 전역 스로틀로만 막는다.
const MAX_TRACKED_IPS = 10000;
// 전역 실패 스로틀: 같은 윈도 안에서 누적 실패가 임계를 넘으면 모든 미인증 요청을
// 차단한다. CF-Connecting-IP를 회전시키거나 분산 IP로 IP별 잠금을 우회하는 공격의
// 최후 방어선이다.
const GLOBAL_MAX_FAILS = 200;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;

// upstream(OD)으로 전달하면 안 되는 헤더.
//  - authorization: 프록시에서 소비하는 자격이므로 OD로 새지 않게 제거.
//  - hop-by-hop 헤더: 프록시 경계에서 끝나야 하며 전달 시 요청 스머글링 위험.
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 모든 응답에 적용할 보안 헤더(OD 동작을 깨지 않는 안전한 항목만).
// includeSubDomains는 공유 도메인(*.trycloudflare.com)에 부작용을 줄 수 있어 제외한다.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** 타이밍 공격에 안전한 문자열 비교. */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 요청의 Basic 인증 헤더가 기대 자격과 일치하는지 검사한다. */
function isAuthorized(req, user, pass) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass);
}

/**
 * 로그·헤더에 넣기 전 제어문자(CR/LF/탭 등)를 제거하고 길이를 제한한다.
 * 로그 인젝션(가짜 라인 위조)과 터미널 이스케이프 주입을 막는다.
 */
function sanitizeForLog(value, max = 256) {
  // \x00-\x1f(제어), \x7f(DEL)를 ?로 치환 — CRLF·탭·ANSI 이스케이프 주입 차단.
  return String(value).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, max);
}

/**
 * 잠금 키로 쓸 클라이언트 IP를 결정한다.
 * CF-Connecting-IP는 단일 유효 IP 형식일 때만 신뢰한다(헤더 회전/리스트 주입 방어).
 * 형식이 어긋나면 소켓 주소로 폴백한다.
 */
function clientIp(req) {
  const raw = req.headers['cf-connecting-ip'];
  if (raw) {
    const first = String(raw).split(',')[0].trim();
    if (net.isIP(first) !== 0) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Basic 인증 프록시를 기동한다(반환 없이 프로세스 유지).
 * @param {number} listenPort 프록시가 듣는 로컬 포트
 * @param {number} targetPort 전달 대상(OD) 포트
 * @param {string} user 기대 사용자명
 * @param {string} pass 기대 비밀번호
 * @param {{idleMs?:number, logFile?:string}} options 유휴 종료/로그 설정
 */
export function runAuthProxy(listenPort, targetPort, user, pass, options = {}) {
  const { idleMs = 0, logFile } = options;
  // IP별 실패 추적: ip -> { fails, lockUntil }
  const attempts = new Map();
  // 전역 실패 스로틀 상태.
  let globalFails = 0;
  let globalWindowStart = Date.now();
  let lastActivity = Date.now();

  const log = (line) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 로그 실패는 무시(서비스 지속)
    }
  };

  /** 만료된 잠금 항목을 제거해 Map 증가를 억제한다. */
  const pruneExpired = () => {
    const now = Date.now();
    for (const [ip, record] of attempts) {
      if (record.lockUntil && now >= record.lockUntil) attempts.delete(ip);
    }
  };

  /** 전역 윈도가 지났으면 카운터를 리셋한다. */
  const rollGlobalWindow = () => {
    if (Date.now() - globalWindowStart > GLOBAL_WINDOW_MS) {
      globalWindowStart = Date.now();
      globalFails = 0;
    }
  };

  /** 전역 스로틀에 걸렸는지. */
  const isGloballyLocked = () => {
    rollGlobalWindow();
    return globalFails >= GLOBAL_MAX_FAILS;
  };

  /** 해당 IP가 잠금 상태인지. */
  const isIpLocked = (ip) => {
    const record = attempts.get(ip);
    return Boolean(record?.lockUntil && Date.now() < record.lockUntil);
  };

  /** 인증 실패를 기록하고(IP별 + 전역) 필요 시 잠금을 발동한다. */
  const registerFailure = (ip, path) => {
    rollGlobalWindow();
    globalFails += 1;

    const record = attempts.get(ip);
    const fails = (record?.fails || 0) + 1;
    if (fails >= MAX_FAILS) {
      attempts.set(ip, { fails: 0, lockUntil: Date.now() + LOCK_MS });
      log(`LOCKOUT ip=${sanitizeForLog(ip, 64)} (${MAX_FAILS} fails) for ${LOCK_MS / 60000}min`);
      return;
    }
    // Map 상한: 이미 추적 중인 IP는 갱신, 새 IP는 여유가 있을 때만 추가.
    if (attempts.has(ip) || attempts.size < MAX_TRACKED_IPS) {
      attempts.set(ip, { fails, lockUntil: 0 });
    } else {
      pruneExpired();
    }
    log(`AUTH_FAIL ip=${sanitizeForLog(ip, 64)} fails=${fails} path=${sanitizeForLog(path)}`);
  };

  /**
   * 요청의 인증/잠금 상태를 평가한다. HTTP·WebSocket 경로가 공유한다.
   * @returns {{ip:string, state:'locked'|'unauthorized'|'ok'}}
   */
  const evaluate = (req) => {
    const ip = clientIp(req);
    if (isGloballyLocked() || isIpLocked(ip)) return { ip, state: 'locked' };
    if (!isAuthorized(req, user, pass)) {
      registerFailure(ip, req.url);
      return { ip, state: 'unauthorized' };
    }
    if (attempts.has(ip)) attempts.delete(ip);
    return { ip, state: 'ok' };
  };

  /** upstream으로 전달할 헤더를 정리한다(인증/hop-by-hop 제거, Host 재작성). */
  const forwardHeaders = (reqHeaders) => {
    const out = {};
    for (const [key, value] of Object.entries(reqHeaders)) {
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      out[key] = value;
    }
    out.host = `127.0.0.1:${targetPort}`;
    return out;
  };

  /** 보안 헤더를 헤더 객체에 병합해 반환한다. */
  const withSecurity = (headers = {}) => ({ ...headers, ...SECURITY_HEADERS });

  const server = http.createServer((req, res) => {
    const { ip, state } = evaluate(req);

    if (state === 'locked') {
      log(`LOCKED ip=${sanitizeForLog(ip, 64)} path=${sanitizeForLog(req.url)}`);
      res.writeHead(429, withSecurity({ 'Retry-After': '900' }));
      res.end('Too many attempts. Try later.\n');
      return;
    }
    if (state === 'unauthorized') {
      res.writeHead(401, withSecurity({ 'WWW-Authenticate': 'Basic realm="od-mobile"' }));
      res.end('Authentication required\n');
      return;
    }

    // 인증 성공 — 활동 시각 갱신, 헤더 정리 후 OD로 프록시.
    lastActivity = Date.now();
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: forwardHeaders(req.headers),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, withSecurity(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, withSecurity());
      res.end('upstream error\n');
    });
    req.pipe(upstream);
  });

  // WebSocket(HMR 등) 업그레이드.
  // 인증·잠금을 HTTP 경로와 동일하게 적용하고(잠금 우회 차단), upstream이 실제로
  // 101 Switching Protocols로 응답할 때만 양방향 파이프를 연다. 핸드셰이크 실패 시
  // 연결을 끊어, 한 번 인증된 연결을 재사용해 미인증 요청을 보내는 우회를 막는다.
  server.on('upgrade', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());

    const { ip, state } = evaluate(req);
    if (state === 'locked') {
      log(`LOCKED ip=${sanitizeForLog(ip, 64)} path=${sanitizeForLog(req.url)} (upgrade)`);
      clientSocket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 900\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    if (state === 'unauthorized') {
      clientSocket.write(
        'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="od-mobile"\r\nConnection: close\r\n\r\n',
      );
      clientSocket.destroy();
      return;
    }

    // 실제 WebSocket 핸드셰이크인지 검증(요청 스머글링/오용 방어).
    const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
    const hasBodyFraming = req.headers['content-length'] || req.headers['transfer-encoding'];
    const hasControlChars = Object.values(req.headers).some((value) =>
      /[\r\n]/.test(Array.isArray(value) ? value.join(',') : String(value)),
    );
    if (req.method !== 'GET' || upgradeHeader !== 'websocket' || hasBodyFraming || hasControlChars) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    lastActivity = Date.now();
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const headers = forwardHeaders(req.headers);
      // 핸드셰이크에 필요한 hop-by-hop 헤더는 명시적으로 복원한다.
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
      const headerLines = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
    });

    // upstream 첫 응답의 상태줄이 101인지 확인한 뒤에만 파이프를 연다.
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      if (handshakeDone) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > 16384) {
          upstream.destroy();
          clientSocket.destroy();
        }
        return;
      }
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).toString('latin1');
      if (/^HTTP\/1\.\d 101 /.test(statusLine)) {
        handshakeDone = true;
        upstream.removeListener('data', onData);
        clientSocket.write(buffer); // 101 응답(+초기 프레임) 전달
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      } else {
        // 핸드셰이크 실패 → 응답만 전달하고 연결 종료(재사용 차단).
        clientSocket.write(buffer);
        upstream.destroy();
        clientSocket.destroy();
      }
    };
    upstream.on('data', onData);
    upstream.on('error', () => clientSocket.destroy());
    upstream.on('close', () => clientSocket.destroy());
  });

  server.on('error', (error) => {
    console.error(`auth-proxy error: ${error.message}`);
    process.exit(1);
  });

  // 유휴 자동 종료: idleMs 동안 인증된 활동이 없으면 터널까지 정리하고 종료.
  if (idleMs > 0) {
    setInterval(() => {
      pruneExpired();
      if (Date.now() - lastActivity < idleMs) return;
      log(`IDLE_SHUTDOWN after ${idleMs / 60000}min idle`);
      const tunnel = readTunnel();
      // PID 재사용으로 무관한 프로세스를 죽이지 않도록 시그니처를 확인한다.
      if (tunnel?.cfPid && isAlive(tunnel.cfPid) && processMatches(tunnel.cfPid, 'cloudflared')) {
        try {
          process.kill(tunnel.cfPid);
        } catch {
          // 이미 종료됨
        }
      }
      clearTunnel();
      process.exit(0);
    }, 60 * 1000).unref();
  }

  server.listen(listenPort, '127.0.0.1', () => {
    console.error(`auth-proxy up: 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort} (idle=${idleMs}ms)`);
  });
}
