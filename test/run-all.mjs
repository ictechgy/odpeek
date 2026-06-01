// 무의존성 테스트 러너 — smoke.mjs와 모든 test/*.test.mjs를 순차 실행한다.
// 새 테스트 파일이 늘어도 package.json을 고칠 필요가 없도록 디렉토리에서 자동 수집한다.
// 각 파일을 별도 node 자식 프로세스로 돌려 한 파일의 process.exit가 전체를 끊지 않게 한다.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * 실행할 테스트 파일 목록을 만든다.
 * smoke.mjs(기존 관례 이름)를 먼저 돌리고, 그다음 *.test.mjs를 이름순으로 돌린다.
 * 러너 자신(run-all.mjs)은 제외한다.
 * @returns {string[]} 테스트 파일명 배열
 */
function collectTestFiles() {
  const entries = readdirSync(testDir);
  const dotTests = entries
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  const ordered = [];
  if (entries.includes('smoke.mjs')) ordered.push('smoke.mjs');
  ordered.push(...dotTests);
  return ordered;
}

const files = collectTestFiles();
let failed = 0;
for (const file of files) {
  console.log(`\n===== ${file} =====`);
  const result = spawnSync(process.execPath, [join(testDir, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL: ${file} (exit ${result.status})`);
  }
}

console.log(`\n===== 요약: ${files.length}개 중 ${files.length - failed}개 통과 =====`);
process.exit(failed === 0 ? 0 : 1);
