// api/earnings-calendar.js
// -----------------------------------------------------------------------------
// 대시보드가 페이지 로드 시 호출하는 "읽기 전용" 엔드포인트입니다.
// cron-briefing.js가 매일 Finnhub·S&P 500 구성종목 목록에서 가져와 Upstash에
// 저장해둔 "이번 주 S&P 500 실적 발표 일정"을 그대로 읽어오기만 합니다
// (여기엔 Finnhub 호출이 없어서 몇 번을 새로고침해도 API 콜 소모가 없습니다).
//
// 호출: GET https://<your-project>.vercel.app/api/earnings-calendar
// 응답: { "events": [{ "date", "symbol", "name", "sector", "marketCap",
//                       "epsActual", "epsEstimate", "hour" }, ...] }
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/earnings:calendar`, {
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
