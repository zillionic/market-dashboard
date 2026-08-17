// api/calendar.js
// -----------------------------------------------------------------------------
// 대시보드가 페이지 로드 시 호출하는 "읽기 전용" 엔드포인트입니다.
// cron-briefing.js가 매일 저장해둔 캘린더 데이터(매크로/실적/공시)를 그대로
// 읽어오기만 합니다 (여기엔 외부 API·Claude 호출이 없어서 몇 번을 새로고침해도
// 비용·API 콜 소모가 없습니다).
//
// 원래 macro-calendar.js/earnings-calendar.js/disclosures-calendar.js로 각각
// 따로 있었는데, 셋 다 "정해진 Redis 키 하나를 그대로 반환"하는 로직이 완전히
// 같아서 하나로 합쳤습니다. Vercel Hobby 플랜은 배포당 서버리스 함수를 12개까지만
// 허용하는데, 파일을 따로 두면 이 상한에 쉽게 걸립니다(실제로 disclosures-calendar.js를
// 별도 파일로 추가했다가 13개가 되어 배포가 실패한 적이 있습니다) — 새 "읽기 전용
// 캘린더류" 데이터가 또 필요해지면(예: 뉴스) REDIS_KEYS에 한 줄만 추가하세요.
//
// 호출: GET https://<your-project>.vercel.app/api/calendar?type=macro|earnings|disclosures|news
// 응답: { "events": [...] } (형식은 type마다 다름 — 각 cron-briefing.js 저장 로직 참고)
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const REDIS_KEYS = {
  macro: "macro:calendar",
  earnings: "earnings:calendar",
  disclosures: "disclosures:calendar",
  news: "news:calendar",
};

module.exports = async function handler(req, res) {
  const key = REDIS_KEYS[req.query.type];
  if (!key) {
    res.status(400).json({ error: `type 파라미터는 ${Object.keys(REDIS_KEYS).join("/")} 중 하나여야 합니다.` });
    return;
  }

  try {
    const r = await fetch(`${UPSTASH_URL}/get/${key}`, {
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
