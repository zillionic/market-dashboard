// api/us-indices.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — Yahoo Finance 비공식 차트 API로 S&P500/Nasdaq/Dow 조회
// 완전 무료, 키(인증) 불필요.
//
// ⚠️ 이전 버전은 Yahoo가 주는 meta.marketState 필드로 장중/마감을 판단했는데,
// 이 지수 심볼들(^GSPC 등)에는 그 필드가 거의 항상 null로 와서 실제로 장이
// 열려있어도 "마감"으로 잘못 표시되는 버그가 있었습니다. 그래서 이번 버전은
// Yahoo 값을 믿지 않고, 뉴욕 시간을 직접 계산해서 정규장 여부를 판단합니다.
// (미국 공휴일은 반영하지 않음 — 그날은 실제로 장이 닫혀있어도 "장중"으로 잘못
//  표시될 수 있습니다. 필요하면 US_HOLIDAYS 배열에 날짜를 추가하세요.)
//
// 호출: GET https://<your-project>.vercel.app/api/us-indices
//
// marketState 값: PRE(프리마켓) / REGULAR(정규장) / POST(애프터마켓) / CLOSED(마감·주말)
// -----------------------------------------------------------------------------

const SYMBOLS = {
  sp500: "^GSPC",
  nasdaq: "^IXIC",
  dow: "^DJI",
};

// TODO: 미국 공휴일까지 반영하려면 'YYYY-MM-DD'(뉴욕 날짜 기준) 형식으로 추가하세요.
const US_HOLIDAYS = [];

function getMarketState() {
  const nyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => nyParts.find((p) => p.type === type)?.value;
  const weekday = get("weekday"); // "Mon".."Sun"
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const minutesNow = hour * 60 + minute;

  const nyDateStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD

  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const isHoliday = US_HOLIDAYS.includes(nyDateStr);

  if (isWeekend || isHoliday) return "CLOSED";

  const PRE_START = 4 * 60;        // 04:00
  const REGULAR_START = 9 * 60 + 30; // 09:30
  const REGULAR_END = 16 * 60;      // 16:00
  const POST_END = 20 * 60;         // 20:00

  if (minutesNow >= REGULAR_START && minutesNow < REGULAR_END) return "REGULAR";
  if (minutesNow >= PRE_START && minutesNow < REGULAR_START) return "PRE";
  if (minutesNow >= REGULAR_END && minutesNow < POST_END) return "POST";
  return "CLOSED";
}

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
  };
}

module.exports = async function handler(req, res) {
  try {
    const [sp500, nasdaq, dow] = await Promise.all([
      fetchOne(SYMBOLS.sp500),
      fetchOne(SYMBOLS.nasdaq),
      fetchOne(SYMBOLS.dow),
    ]);

    const marketState = getMarketState(); // 뉴욕 시간 기준 직접 계산 (Yahoo 필드 사용 안 함)
    const isOpen = marketState === "REGULAR";

    // 캐시 없이 매번 새로 가져옵니다.
    res.setHeader("Cache-Control", "no-store");

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
