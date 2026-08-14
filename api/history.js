// api/history.js
// -----------------------------------------------------------------------------
// 대시보드 추이 차트가 페이지 로드 시 호출하는 "읽기 전용" 엔드포인트입니다.
// cron-briefing.js가 매일 Upstash에 쌓아둔 지수별 종가 히스토리를 그대로 읽어오기만
// 해서, 여기엔 Claude API 호출이 없습니다 (몇 번을 새로고침해도 비용 0원).
//
// 호출: GET https://<your-project>.vercel.app/api/history
// 응답 예시:
//   {
//     "KOSPI": [{ "date": "08.07", "close": 6258.77 }, ...],
//     "KOSDAQ": [...],
//     "S&P 500": [...],
//     "NASDAQ": [...],
//     "DOW": [...]
//   }
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Redis 키(공백 없음) → 대시보드가 쓰는 표시 이름 매핑
const KEYS = {
  KOSPI: "KOSPI",
  KOSDAQ: "KOSDAQ",
  SP500: "S&P 500",
  NASDAQ: "NASDAQ",
  DOW: "DOW",
};

async function redisGet(key) {
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Upstash 조회 실패 (${key}): ${r.status}`);
  const json = await r.json();
  return json.result ? JSON.parse(json.result) : [];
}

module.exports = async function handler(req, res) {
  try {
    const entries = await Promise.all(
      Object.entries(KEYS).map(async ([redisKey, label]) => [label, await redisGet(`history:${redisKey}`)])
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(Object.fromEntries(entries));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
