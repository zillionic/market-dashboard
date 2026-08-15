// api/extra-tickers.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — Yahoo Finance로 WTI 원유·금·비트코인 시세 조회.
// 완전 무료, 키(인증) 불필요.
//
// 주가지수와 달리 선물·암호화폐라 "정규장" 개념이 없어서(비트코인은 24시간 거래,
// WTI·금 선물도 사실상 하루 대부분 거래) marketState는 따로 계산하지 않습니다.
//
// 호출: GET https://<your-project>.vercel.app/api/extra-tickers
// -----------------------------------------------------------------------------

const SYMBOLS = {
  oil: "CL=F",  // WTI 원유 선물
  gold: "GC=F", // 금 선물
  btc: "BTC-USD",
};

async function fetchOne(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: {
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
    const [oil, gold, btc] = await Promise.all([
      fetchOne(SYMBOLS.oil),
      fetchOne(SYMBOLS.gold),
      fetchOne(SYMBOLS.btc),
    ]);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ oil, gold, btc, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
