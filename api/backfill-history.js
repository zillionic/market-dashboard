// api/backfill-history.js
// -----------------------------------------------------------------------------
// 1회성 백필(backfill) 엔드포인트 — 추이 차트의 목업 데이터를 실제 과거 종가로
// 교체합니다. Yahoo Finance에서 최근 ~2개월치 일별 종가를 가져와 최근 20거래일만
// 골라서 Upstash의 history:* 키를 덮어씁니다.
//
// 배포 후 브라우저로 딱 한 번만 열어주세요:
//   GET https://<your-project>.vercel.app/api/backfill-history
//
// 이후로는 cron-briefing.js가 매일 최신 종가를 이어서 쌓아갑니다. 이미 실제
// 데이터가 쌓여 있는 상태에서 다시 호출해도 최신값으로 다시 채울 뿐이라 안전합니다
// (이 사이트 자체가 실질적인 인증 없이도 낮은 위험도로 설계돼 있어, 다른 진단용
// 엔드포인트들처럼 별도 보호 없이 열어뒀습니다).
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const SYMBOLS = {
  KOSPI: { symbol: "^KS11", tz: "Asia/Seoul" },
  KOSDAQ: { symbol: "^KQ11", tz: "Asia/Seoul" },
  SP500: { symbol: "^GSPC", tz: "America/New_York" },
  NASDAQ: { symbol: "^IXIC", tz: "America/New_York" },
  DOW: { symbol: "^DJI", tz: "America/New_York" },
};

const DAYS_TO_KEEP = 20;

async function redisSet(key, valueObj) {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(valueObj),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstash 저장 실패 (${res.status}): ${text}`);
  }
}

async function fetchHistory(symbol, tz) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance 응답 실패 (${symbol}, ${res.status})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance 데이터 없음: ${symbol}`);

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  const rows = timestamps
    .map((t, i) => ({ t, close: closes[i] }))
    .filter((r) => Number.isFinite(r.close))
    .map((r) => ({
      date: new Date(r.t * 1000).toLocaleDateString("en-CA", { timeZone: tz }), // "YYYY-MM-DD"
      close: Number(r.close.toFixed(2)),
    }));

  return rows.slice(-DAYS_TO_KEEP);
}

module.exports = async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    res.status(500).json({ error: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수가 설정되지 않았습니다." });
    return;
  }

  const results = {};
  const errors = {};
  await Promise.all(
    Object.entries(SYMBOLS).map(async ([key, { symbol, tz }]) => {
      try {
        const history = await fetchHistory(symbol, tz);
        if (history.length < 2) throw new Error(`데이터가 너무 적습니다 (${history.length}일)`);
        await redisSet(`history:${key}`, history);
        results[key] = { count: history.length, from: history[0].date, to: history[history.length - 1].date };
      } catch (err) {
        errors[key] = String(err);
      }
    })
  );

  res.status(200).json({ ok: Object.keys(errors).length === 0, results, errors });
}
