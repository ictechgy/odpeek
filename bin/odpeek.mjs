#!/usr/bin/env node
// odpeek 진입점 — 인자 파싱/실행은 src/cli.mjs에 위임하고, 여기선 에러만 정돈한다.
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exit(1);
});
