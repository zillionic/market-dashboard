// lib/textUtils.js
// -----------------------------------------------------------------------------
// 여러 api/*.js가 공유하는 작은 텍스트 유틸리티 (HTML 태그 제거, 최근 N시간 이내
// 여부 판정). api/ 밖에 둔 이유는 lib/fetchWithTimeout.js와 동일합니다.
// -----------------------------------------------------------------------------

function stripHtml(rawHtml) {
  return rawHtml
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function isWithinLookbackHours(date, hours) {
  return Number.isFinite(date.getTime()) && (Date.now() - date.getTime()) <= hours * 3600 * 1000;
}

module.exports = { stripHtml, isWithinLookbackHours };
