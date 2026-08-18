// lib/fetchWithTimeout.js
// -----------------------------------------------------------------------------
// api/*.js 여러 파일이 공유하는 fetch 타임아웃 헬퍼. api/ 밖에 두는 이유는 Vercel
// Hobby 플랜의 서버리스 함수 12개 제한에 걸리지 않기 위해서입니다(require로만
// 번들되고 별도 함수로 배포되지 않음).
//
// 타임아웃 없는 fetch는 Node에서 응답이 올 때까지 무한정 대기하므로, 외부 API
// 하나가 멈추면 그 함수 전체가 maxDuration까지 끌려가다 죽는 사고로 이어집니다
// (2026-08-18 cron-briefing.js FUNCTION_INVOCATION_TIMEOUT 사고의 근본 원인).
// AbortController로 타임아웃을 걸어서, 하나가 멈춰도 그 호출만 실패 처리되고
// 나머지는 계속 진행되게 합니다.
// -----------------------------------------------------------------------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`요청 타임아웃(${timeoutMs}ms): ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
