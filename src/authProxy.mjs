// localhost 전용 HTTP 리버스 프록시 + HTTP Basic 인증(하드닝 포함).
//
// cloudflared 빠른 터널은 공개 URL을 만들지만 누구나 접근 가능하다. OD에는 인증이
// 없으므로, cloudflared → 이 프록시 → OD 순서로 두어 Basic 인증을 강제한다.
// 이 프록시는 127.0.0.1에만 바인딩하고 cloudflared도 localhost로 붙으므로
// macOS 방화벽 인바운드 제약과 무관하다.
//
// 하드닝: 실제 클라이언트 IP(CF-Connecting-IP) 기준 무차별대입 잠금, 보안 응답
// 헤더, 인증 시도 로그, 유휴 자동 종료(터널까지 정리).
import http from 'node:http';
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { readTunnel, clearTunnel, isAlive } from './tunnel.mjs';

// 무차별대입 방어: 한 IP가 MAX_FAILS회 실패하면 LOCK_MS 동안 차단.
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

// 모든 응답에 적용할 보안 헤더(OD 동작을 깨지 않는 안전한 항목만).
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
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

/** Cloudflare가 전달하는 실제 클라이언트 IP를 얻는다(없으면 소켓 주소). */
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
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
  let lastActivity = Date.now();

  const log = (line) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 로그 실패는 무시(서비스 지속)
    }
  };

  /** 보안 헤더를 헤더 객체에 병합해 반환한다. */
  const withSecurity = (headers = {}) => ({ ...headers, ...SECURITY_HEADERS });

  const server = http.createServer((req, res) => {
    const ip = clientIp(req);
    const record = attempts.get(ip);

    // 1) 잠금 상태면 차단(429).
    if (record?.lockUntil && Date.now() < record.lockUntil) {
      log(`LOCKED ip=${ip} path=${req.url}`);
      res.writeHead(429, withSecurity({ 'Retry-After': '900' }));
      res.end('Too many attempts. Try later.\n');
      return;
    }

    // 2) 인증 검사.
    if (!isAuthorized(req, user, pass)) {
      const fails = (record?.fails || 0) + 1;
      if (fails >= MAX_FAILS) {
        attempts.set(ip, { fails: 0, lockUntil: Date.now() + LOCK_MS });
        log(`LOCKOUT ip=${ip} (${MAX_FAILS} fails) for ${LOCK_MS / 60000}min`);
      } else {
        attempts.set(ip, { fails, lockUntil: 0 });
        log(`AUTH_FAIL ip=${ip} fails=${fails} path=${req.url}`);
      }
      res.writeHead(401, withSecurity({ 'WWW-Authenticate': 'Basic realm="od-mobile"' }));
      res.end('Authentication required\n');
      return;
    }

    // 3) 인증 성공 — 카운터 리셋, 활동 시각 갱신, OD로 프록시.
    if (record) attempts.delete(ip);
    lastActivity = Date.now();
    const upstream = http.request(
      { hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
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

  // WebSocket(HMR 등) 업그레이드 — 인증 후 raw 소켓 파이프.
  server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthorized(req, user, pass)) {
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="od-mobile"\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    lastActivity = Date.now();
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const headerLines = Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  server.on('error', (error) => {
    console.error(`auth-proxy error: ${error.message}`);
    process.exit(1);
  });

  // 유휴 자동 종료: idleMs 동안 인증된 활동이 없으면 터널까지 정리하고 종료.
  if (idleMs > 0) {
    setInterval(() => {
      if (Date.now() - lastActivity < idleMs) return;
      log(`IDLE_SHUTDOWN after ${idleMs / 60000}min idle`);
      const tunnel = readTunnel();
      if (tunnel?.cfPid && isAlive(tunnel.cfPid)) {
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
