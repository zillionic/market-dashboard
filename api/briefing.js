// api/briefing.js
// -----------------------------------------------------------------------------
// 대시보드가 페이지 로드 시 호출하는 "읽기 전용" 엔드포인트입니다.
// cron-briefing.js가 매일 아침 저장해둔 요약을 Upstash에서 그대로 읽어오기만 해서,
// 여기엔 Claude API 호출이 없습니다 (몇 번을 새로고침해도 비용 0원).
//
// 호출: GET https://<your-project>.vercel.app/api/briefing
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/briefing:latest`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!r.ok) throw new Error(`Upstash 조회 실패: ${r.status}`);

    const json = await r.json();
    if (!json.result) {
      res.status(404).json({ error: "아직 생성된 시황 요약이 없습니다. cron-briefing이 한 번은 실행돼야 합니다." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(JSON.parse(json.result));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
