// cloudflared 빠른 터널 상태 관리 + URL 추출 헬퍼.
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';

const STATE_DIR = join(homedir(), '.od-mobile');
const STATE_FILE = join(STATE_DIR, 'tunnel.json');

// cloudflared 프로세스의 stdout/stderr 로그(여기서 공개 URL을 파싱한다).
export const CF_LOG = join(STATE_DIR, 'cloudflared.log');

/** 상태 디렉토리를 보장한다. */
export function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** 터널 상태(pid/포트/url 등)를 저장한다. */
export function saveTunnel(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** 저장된 터널 상태를 읽는다. 없거나 손상되면 null. */
export function readTunnel() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 저장된 터널 상태를 제거한다. */
export function clearTunnel() {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
}

/** 해당 PID가 살아있는지 확인한다. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * cloudflared 로그 텍스트에서 trycloudflare 공개 URL을 추출한다.
 * @returns {string|null} 예: "https://abc-def.trycloudflare.com"
 */
export function extractTrycloudflareUrl(text) {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}
