// api/treasury-yields.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — FRED에서 미국 10년물·2년물 국채금리(Constant Maturity Rate)를
// 조회합니다. 매 요청마다 FRED에서 최신 2개 관측치(발표치·직전치)를 바로 가져오는
// 방식이라(cron 캐시를 거치지 않음) 항상 FRED에 올라온 최신 값을 보여줍니다.
//
// 국채금리는 하루 한 번(영업일 마감 기준)만 갱신되는 데이터라 장중 실시간은 아니지만,
// 자체 발표 주기가 원래 일 단위라 그걸로 충분합니다.
//
// FRED_API_KEY 필요 (api/cron-briefing.js의 매크로 캘린더와 같은 키를 그대로 씁니다).
//
// 호출: GET https://<your-project>.vercel.app/api/treasury-yields
// -----------------------------------------------------------------------------

const { fetchWithTimeout } = require("../lib/fetchWithTimeout");

const FRED_API_KEY = process.env.FRED_API_KEY;

async function fetchYield(seriesId) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
    `&units=lin&sort_order=desc&limit=2&file_type=json&api_key=${FRED_API_KEY}`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) throw new Error(`FRED 조회 실패 (${seriesId}, ${res.status})`);
  const json = await res.json();
  const obs = (json.observations || []).filter((o) => o.value !== "."); // FRED는 결측치를 "."으로 표시
  const actual = obs[0] ? Number(obs[0].value) : null;
  const previous = obs[1] ? Number(obs[1].value) : null;
  if (actual === null) throw new Error(`FRED 값 없음: ${seriesId}`);
  return { actual, previous, change: previous !== null ? Number((actual - previous).toFixed(2)) : null };
}

module.exports = async function handler(req, res) {
  if (!FRED_API_KEY) {
    res.status(500).json({ error: "FRED_API_KEY가 설정되지 않았습니다." });
    return;
  }
  try {
    const [us10y, us2y] = await Promise.all([
      fetchYield("DGS10"),
      fetchYield("DGS2"),
    ]);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ us10y, us2y, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
