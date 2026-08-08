// api/us-indices.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — Yahoo Finance 비공식 차트 API로 S&P500/Nasdaq/Dow 조회
// 완전 무료, 키(인증) 불필요. (stooq.com은 서버 요청을 막아서 이 방식으로 교체)
//
// 호출: GET https://<your-project>.vercel.app/api/us-indices
//
// 응답 예시:
//   {
//     "sp500":  { "symbol": "^GSPC", "close": 7757.64, "change": 47.68, "pct": 0.62 },
//     "nasdaq": { "symbol": "^IXIC", "close": 26690.62, "change": 342.27, "pct": 1.30 },
//     "dow":    { "symbol": "^DJI",  "close": 54036.93, "change": 151.83, "pct": 0.28 },
//     "updatedAt": "2026-08-08T01:00:00.000Z"
//   }
// -----------------------------------------------------------------------------

const SYMBOLS = {
  sp500: "^GSPC",
  nasdaq: "^IXIC",
  dow: "^DJI",
};

async function fetchOne(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: {
      // Yahoo가 브라우저처럼 보이지 않는 요청을 막는 경우가 있어 User-Agent를 지정합니다.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance 응답 실패 (${res.status}) for ${symbol}`);

  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo Finance 데이터 없음: ${symbol}`);

  const close = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  if (!Number.isFinite(close) || !Number.isFinite(prevClose)) {
    throw new Error(`Yahoo Finance 필드 누락: ${symbol}`);
  }

  const change = close - prevClose;
  const pct = (change / prevClose) * 100;

  return {
    symbol,
    close: Number(close.toFixed(2)),
    change: Number(change.toFixed(2)),
    pct: Number(pct.toFixed(2)),
  };
}

module.exports = async function handler(req, res) {
  try {
    const [sp500, nasdaq, dow] = await Promise.all([
      fetchOne(SYMBOLS.sp500),
      fetchOne(SYMBOLS.nasdaq),
      fetchOne(SYMBOLS.dow),
    ]);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");
    res.status(200).json({
      sp500,
      nasdaq,
      dow,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
