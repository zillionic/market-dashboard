// api/macro-calendar.js
// -----------------------------------------------------------------------------
// 대시보드가 페이지 로드 시 호출하는 "읽기 전용" 엔드포인트입니다.
// cron-briefing.js가 매일 FRED에서 가져와 Upstash에 저장해둔 "다음 7일 매크로
// 발표 일정"을 그대로 읽어오기만 합니다 (여기엔 FRED/Claude 호출이 없어서 몇 번을
// 새로고침해도 비용·API 콜 소모가 없습니다).
//
// 호출: GET https://<your-project>.vercel.app/api/macro-calendar
// 응답: { "events": [{ "date": "2026-08-20", "name": "FOMC 정례회의" }, ...] }
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/macro:calendar`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!r.ok) throw new Error(`Upstash 조회 실패: ${r.status}`);

    const json = await r.json();
    const events = json.result ? JSON.parse(json.result) : [];

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ events });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
