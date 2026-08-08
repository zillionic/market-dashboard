// api/us-indices.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — stooq.com에서 S&P500 / Nasdaq / Dow 최신 종가·등락률 조회
// 완전 무료, 키(인증) 불필요.
//
// 호출: GET https://<your-project>.vercel.app/api/us-indices
//
// 응답 예시:
//   {
//     "sp500":  { "symbol": "^SPX", "close": 7757.64, "change": 47.68, "pct": 0.62 },
//     "nasdaq": { "symbol": "^NDQ", "close": 26690.62, "change": 342.27, "pct": 1.30 },
//     "dow":    { "symbol": "^DJI", "close": 54036.93, "change": 151.83, "pct": 0.28 },
//     "updatedAt": "2026-08-08T01:00:00.000Z"
//   }
//
// ⚠️ 배포 전 확인 필요: stooq는 공식 문서화된 API가 아니라 필드 순서가
// 예고 없이 바뀔 수 있습니다. 배포 후 이 엔드포인트를 직접 열어서
// 숫자가 실제 지수 값과 맞는지 한 번은 육안으로 확인해주세요.
// 심볼(^spx 등)이 stooq에서 다르게 나오면 SYMBOLS 아래 값만 바꾸면 됩니다.
// -----------------------------------------------------------------------------

const SYMBOLS = {
  sp500: "^spx",
  nasdaq: "^ndq",
  dow: "^dji",
};

// f=필드 순서 지정: s(심볼) d1(날짜) t1(시간) o h l c(종가) v(거래량) p2(등락률%)
const FIELDS = "sd1t1ohlcvp2";

async function fetchOne(key, symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=${FIELDS}&h&e=csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stooq 응답 실패 (${res.status}) for ${symbol}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error(`stooq 데이터 없음: ${symbol}`);

  // 헤더: Symbol,Date,Time,Open,High,Low,Close,Volume,Change %
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  const pct = Number(cols[8]);
  const change = Number.isFinite(close) && Number.isFinite(pct)
    ? close - close / (1 + pct / 100)
    : null;

  return {
    symbol,
    close: Number.isFinite(close) ? close : null,
    pct: Number.isFinite(pct) ? pct : null,
    change: change !== null ? Number(change.toFixed(2)) : null,
  };
}

module.exports = async function handler(req, res) {
  try {
    const [sp500, nasdaq, dow] = await Promise.all([
      fetchOne("sp500", SYMBOLS.sp500),
      fetchOne("nasdaq", SYMBOLS.nasdaq),
      fetchOne("dow", SYMBOLS.dow),
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
