// api/kr-indices.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — Yahoo Finance로 KOSPI/KOSDAQ "지수 값"을 장중 실시간으로 조회.
// 완전 무료, 키(인증) 불필요.
//
// ⚠️ 업종별 TOP5/BOTTOM5는 여전히 KRX Open API(api/kr-sectors.js)를 씁니다 — Yahoo에는
// 한국 업종 단위 데이터가 없어서, 이 파일은 오직 "코스피/코스닥 지수 값"만 담당합니다.
// (지수 값은 장중 실시간, 업종은 여전히 전일 마감 기준으로 섞여 보일 수 있습니다.)
//
// 호출: GET https://<your-project>.vercel.app/api/kr-indices
//
// marketState 값: PRE(장전) / REGULAR(정규장) / POST(장후 시간외) / CLOSED(마감·주말)
// -----------------------------------------------------------------------------

const SYMBOLS = {
  kospi: "^KS11",
  kosdaq: "^KQ11",
  usdkrw: "KRW=X", // 원/달러 환율 (Yahoo Finance FX 심볼)
};

// TODO: 한국 공휴일까지 반영하려면 'YYYY-MM-DD'(한국 날짜 기준) 형식으로 추가하세요.
const KR_HOLIDAYS = [];

function getMarketState() {
  const kstParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => kstParts.find((p) => p.type === type)?.value;
  const weekday = get("weekday");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const minutesNow = hour * 60 + minute;

  const kstDateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const isHoliday = KR_HOLIDAYS.includes(kstDateStr);
  if (isWeekend || isHoliday) return "CLOSED";

  const PRE_START = 8 * 60;          // 08:00 장전 시간외
  const REGULAR_START = 9 * 60;      // 09:00 정규장 시작
  const REGULAR_END = 15 * 60 + 30;  // 15:30 정규장 종료
  const POST_END = 18 * 60;          // 18:00 장후 시간외 종료

  if (minutesNow >= REGULAR_START && minutesNow < REGULAR_END) return "REGULAR";
  if (minutesNow >= PRE_START && minutesNow < REGULAR_START) return "PRE";
  if (minutesNow >= REGULAR_END && minutesNow < POST_END) return "POST";
  return "CLOSED";
}

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
    regularMarketTime: meta.regularMarketTime || null, // unix seconds, 마감 날짜 계산용
  };
}

module.exports = async function handler(req, res) {
  try {
    const [kospi, kosdaq, usdkrw] = await Promise.all([
      fetchOne(SYMBOLS.kospi),
      fetchOne(SYMBOLS.kosdaq),
      fetchOne(SYMBOLS.usdkrw),
    ]);

    const marketState = getMarketState();
    const isOpen = marketState === "REGULAR";

    // 마감 상태일 때 "며칠자 마감인지" 보여주기 위한 날짜 (한국 달력 기준).
    const asOfDate = kospi.regularMarketTime
      ? new Date(kospi.regularMarketTime * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
      : null;

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      marketState,
      isOpen,
      asOfDate, // "YYYY-MM-DD"
      kospi,
      kosdaq,
      usdkrw,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
