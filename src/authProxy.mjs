// localhost 전용 HTTP 리버스 프록시 + HTTP Basic 인증.
//
// cloudflared 빠른 터널은 공개 URL을 만들지만 누구나 접근 가능하다. OD에는 인증이
// 없으므로, cloudflared → 이 프록시 → OD 순서로 두어 Basic 인증을 강제한다.
// 이 프록시는 127.0.0.1에만 바인딩하고 cloudflared도 localhost로 붙으므로
// macOS 방화벽 인바운드 제약과 무관하다.
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

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
 * Basic 인증 프록시를 기동한다(반환 없이 프로세스 유지).
 * @param {number} listenPort 프록시가 듣는 로컬 포트
 * @param {number} targetPort 전달 대상(OD) 포트
 * @param {string} user 기대 사용자명
 * @param {string} pass 기대 비밀번호
 */
export function runAuthProxy(listenPort, targetPort, user, pass) {
  const server = http.createServer((req, res) => {
    if (!isAuthorized(req, user, pass)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="od-mobile"' });
      res.end('Authentication required\n');
      return;
    }
    const upstream = http.request(
      { hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
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
  server.listen(listenPort, '127.0.0.1', () => {
    console.error(`auth-proxy up: 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}`);
  });
}
