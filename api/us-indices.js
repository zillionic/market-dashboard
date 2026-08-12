// api/us-indices.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — Yahoo Finance 비공식 차트 API로 S&P500/Nasdaq/Dow 조회
// 완전 무료, 키(인증) 불필요.
//
// Yahoo의 regularMarketPrice 필드는 원래 "장중엔 실시간가, 마감 후엔 종가"를
// 그대로 반환합니다. marketState 필드로 지금이 장중인지 마감인지도 함께 줍니다.
//
// 호출: GET https://<your-project>.vercel.app/api/us-indices
//
// 응답 예시 (장중):
//   {
//     "marketState": "REGULAR",
//     "isOpen": true,
//     "sp500":  { "symbol": "^GSPC", "close": 7751.08, "change": 22.88, "pct": 0.30 },
//     "nasdaq": { "symbol": "^IXIC", "close": 26595.50, "change": 150.06, "pct": 0.57 },
//     "dow":    { "symbol": "^DJI",  "close": 53858.84, "change": 66.99, "pct": 0.12 },
//     "updatedAt": "2026-08-12T13:44:39.880Z"
//   }
//
// marketState 값: PRE(프리마켓) / REGULAR(정규장) / POST(애프터마켓) / CLOSED(마감)
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

  const close = meta.regularMarketPrice;         // 장중이면 실시간가, 마감이면 종가
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
    marketState: meta.marketState || null, // PRE / REGULAR / POST / CLOSED
  };
}

module.exports = async function handler(req, res) {
  try {
    const [sp500, nasdaq, dow] = await Promise.all([
      fetchOne(SYMBOLS.sp500),
      fetchOne(SYMBOLS.nasdaq),
      fetchOne(SYMBOLS.dow),
    ]);

    // 세 지수의 marketState는 사실상 항상 같으므로 대표로 하나만 상단에 노출합니다.
    const marketState = sp500.marketState;
    const isOpen = marketState === "REGULAR";

    // 장중에는 짧게(1분), 마감 후에는 좀 더 길게(10분) 캐시해서
    // 장중엔 자주 갱신되면서도 불필요한 호출은 줄입니다.
    const cacheSeconds = isOpen ? 60 : 600;
    res.setHeader("Cache-Control", `s-maxage=${cacheSeconds}, stale-while-revalidate=60`);

    res.status(200).json({
      marketState,
      isOpen,
      sp500,
      nasdaq,
      dow,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
