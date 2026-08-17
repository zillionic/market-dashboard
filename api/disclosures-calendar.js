// api/disclosures-calendar.js
// -----------------------------------------------------------------------------
// 대시보드가 페이지 로드 시 호출하는 "읽기 전용" 엔드포인트입니다.
// cron-briefing.js가 매일 DART(전자공시)에서 가져와 기계적으로 필터링한
// "최근 일주일 국내 주요 공시" 목록을 Upstash에 저장해두면 그대로 읽어오기만
// 합니다(여기엔 DART·Claude 호출이 없어서 몇 번을 새로고침해도 API 콜 소모가
// 없습니다).
//
// 호출: GET https://<your-project>.vercel.app/api/disclosures-calendar
// 응답: { "events": [{ "date", "corpName", "corpCode", "title", "type", "rceptNo" }, ...] }
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/disclosures:calendar`, {
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
