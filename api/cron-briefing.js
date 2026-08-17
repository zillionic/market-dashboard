// api/cron-briefing.js
// -----------------------------------------------------------------------------
// Vercel Cron이 매일 아침 8시(KST) 자동 호출하는 함수 (스케줄은 vercel.json 참고).
// 국내는 신한투자증권·유안타증권·키움증권, 해외는 미래에셋증권 리서치
// 텔레그램 채널(KR_TELEGRAM_CHANNELS/US_TELEGRAM_CHANNELS 참고)의 최신 글을 읽어서
// Claude API로 종합 5줄 개조식 요약을 만들고, Upstash Redis에 저장합니다. 국내는
// 여러 소스를 종합하되 증권사별로 시각이 갈리는 이슈는 각각 대비해서 표시합니다.
//
// 필요한 환경변수 (Vercel 프로젝트 > Settings > Environment Variables):
//   ANTHROPIC_API_KEY         - console.anthropic.com에서 발급
//   UPSTASH_REDIS_REST_URL    - upstash.com 무료 Redis 콘솔에서 발급
//   UPSTASH_REDIS_REST_TOKEN  - 위와 동일한 곳에서 발급
//   CRON_SECRET                - 아무 긴 문자열이나 직접 정해서 등록.
//                                 (설정해두면 외부인이 이 URL을 직접 호출해서
//                                  API 비용을 낭비시키는 걸 막아줍니다.
//                                  처음 테스트할 땐 일부러 안 넣고 브라우저로
//                                  직접 열어봐도 됩니다.)
//   NOTION_API_KEY             - notion.so/my-integrations에서 발급한 Integration Secret
//   NOTION_PAGE_ID              - 노션 페이지 URL의 32자리 ID 부분
//   NOTION_ANCHOR_BLOCK_ID      - 페이지 맨 위에 만들어둔 구분선 블록의 ID
//                                 (이 셋 중 하나라도 없으면 노션 업데이트는 조용히 건너뜁니다)
//   FRED_API_KEY                - fred.stlouisfed.org/docs/api/api_key.html 에서 무료 발급
//                                 (없으면 매크로 캘린더 갱신만 조용히 건너뜁니다)
//   FINNHUB_API_KEY              - finnhub.io/register 에서 무료 발급 (개인용, 분당 60콜)
//                                 (없으면 실적 캘린더 갱신만 조용히 건너뜁니다)
//   DART_API_KEY                 - opendart.fss.or.kr 에서 무료 발급(개인, 즉시 이메일 발급)
//                                 (없으면 노션 "개별 종목 및 이슈"의 공시 요약과 대시보드
//                                  "공시" 탭 갱신만 조용히 건너뜁니다)
//   NAVER_CLIENT_ID               - developers.naver.com/apps 에서 "검색" API로 무료 발급
//   NAVER_CLIENT_SECRET            - 위와 동일한 곳에서 발급
//                                 (둘 중 하나라도 없으면 대시보드 "뉴스" 탭의 국내 뉴스만
//                                  조용히 건너뜁니다. FINNHUB_API_KEY 미설정 시 해외 뉴스도
//                                  마찬가지로 건너뜁니다)
//
// 휴일 처리: 오늘이 한국 기준 토/일이면 아무 것도 안 하고 종료합니다.
// Upstash에 저장된 값(가장 최근 평일 요약)이 그대로 유지되므로,
// 대시보드에는 자동으로 "최근 거래일 기준" 시황이 계속 표시됩니다.
// -----------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// TODO: 한국 공휴일까지 건너뛰려면 'YYYY-MM-DD' 형식으로 날짜를 추가하세요.
const KR_HOLIDAYS = [];

async function redisSet(key, valueObj) {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(valueObj),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstash 저장 실패 (${res.status}): ${text} | url=${UPSTASH_URL} tokenLen=${(UPSTASH_TOKEN||"").length}`);
  }
}

async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Upstash 조회 실패 (${key}, ${res.status})`);
  const json = await res.json();
  return json.result ? JSON.parse(json.result) : null;
}

// ============================================================================
// 지수 추이 히스토리 — 대시보드 스파크라인용으로 매일 종가를 누적 저장합니다
// ============================================================================
const HISTORY_MAX_DAYS = 20;

// 같은 날짜로 다시 실행되면(재시도 등) 새 값으로 덮어쓰고 중복 추가하지 않습니다.
async function appendIndexHistory(historyKey, dateStr, close) {
  if (!dateStr || !Number.isFinite(close)) return;
  let history = [];
  try {
    history = (await redisGet(`history:${historyKey}`)) || [];
  } catch (err) {
    console.warn(`히스토리 조회 실패 (${historyKey}), 빈 배열로 새로 시작:`, err);
  }
  const idx = history.findIndex((h) => h.date === dateStr);
  if (idx >= 0) history[idx] = { date: dateStr, close };
  else history.push({ date: dateStr, close });
  history = history.slice(-HISTORY_MAX_DAYS);
  await redisSet(`history:${historyKey}`, history);
}

// Yahoo Finance에서 오늘자 지수/환율 종가를 직접 가져옵니다.
// (예전엔 같은 배포의 /api/kr-indices, /api/us-indices를 VERCEL_URL로 다시 호출하는
//  방식이었는데, Vercel Deployment Protection이 이런 서버 대 서버 내부 요청을 로그인
//  페이지로 가로채면서 JSON 파싱이 "Unexpected token '<'"로 조용히 실패해 히스토리가
//  전혀 안 쌓이는 문제가 있었습니다. 외부 API를 직접 호출하면 이 문제와 무관해집니다.)
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance 응답 실패 (${symbol}, ${res.status})`);
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice)) throw new Error(`Yahoo Finance 데이터 없음: ${symbol}`);
  return { close: Number(meta.regularMarketPrice.toFixed(2)), regularMarketTime: meta.regularMarketTime || null };
}

async function fetchIndexCloses() {
  const [kospi, kosdaq, usdkrw, sp500, nasdaq, dow] = await Promise.all([
    fetchYahooQuote("^KS11"),
    fetchYahooQuote("^KQ11"),
    fetchYahooQuote("KRW=X"),
    fetchYahooQuote("^GSPC"),
    fetchYahooQuote("^IXIC"),
    fetchYahooQuote("^DJI"),
  ]);
  const krAsOfDate = kospi.regularMarketTime
    ? new Date(kospi.regularMarketTime * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
    : null;
  const usAsOfDate = sp500.regularMarketTime
    ? new Date(sp500.regularMarketTime * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    : null;
  return {
    kr: { asOfDate: krAsOfDate, kospi, kosdaq, usdkrw },
    us: { asOfDate: usAsOfDate, sp500, nasdaq, dow },
  };
}

// ============================================================================
// 매크로 캘린더 — FRED(세인트루이스 연준)의 공식 발표 일정 API에서 다음 7일치를
// 가져옵니다. FRED는 500개가 넘는 release를 관리해서 그대로 쓰면 지엽적인
// 발표까지 다 뜨므로, 시장에 영향이 큰 지표 위주로 이름을 필터링합니다.
// ============================================================================
const FRED_API_KEY = process.env.FRED_API_KEY;

// release_name에 keyword가 포함되면(대소문자 무관) 통과시키고, 대시보드에는 원문 대신
// 한국에서 통용되는 이름(ko)으로 표시합니다. 새 지표를 더 보고 싶으면 이 목록에
// { keyword, ko, periodOffset } 한 줄만 추가하면 필터링·한글 표시명·데이터 기준월이
// 동시에 적용됩니다.
//
// periodOffset: 발표월 대비 실제 데이터가 몇 달 전 것인지 (예: 8월에 발표하는 7월 소매판매는 -1).
// 미국 월간 지표는 거의 다 "발표 전월" 데이터를 다루는 관행이라 -1이 기본값입니다.
//   - 예외 1) 소비자신뢰지수는 그 달 설문을 그 달에 바로 발표하는 실시간 서베이라 0.
//   - 예외 2) GDP는 분기 데이터라 "몇 월"로 표기하는 게 오히려 헷갈려서 null(표기 생략).
//
// seriesId/units: 발표 당일이면 FRED series/observations에서 발표치·직전치를 같이
// 가져옵니다. units는 FRED가 서버에서 계산해주는 변환 방식이라 우리가 직접 전년비·
// 전월비를 계산할 필요가 없습니다 (pc1=전년비%, pch=전월비%, chg=전월 대비 절대 변화량,
// lin=원값 그대로). ISM처럼 FRED에 원본 시리즈가 없는 지표는 seriesId를 비워둡니다
// (컨센서스/예상치는 FRED에 아예 없는 데이터라 나중에 다른 소스가 필요합니다).
//
// units는 우선순위 배열입니다 — 시장은 보통 전월비(MoM)에 더 민감하게 반응하므로 MoM을
// 먼저 시도하고, 그 값이 없으면(결측치 등) 그다음 후보인 전년비(YoY)로 넘어갑니다.
// 실제로 쓰인 후보의 period("MoM"/"YoY"/"QoQ")를 대시보드에 함께 표시합니다.
const MACRO_RELEASES = [
  { keyword: "Employment Situation", ko: "미국 고용보고서", periodOffset: -1, seriesId: "PAYEMS",
    units: [{ param: "chg", displayFormat: "jobsChg", period: "MoM" }] },
  { keyword: "Consumer Price Index", ko: "미국 소비자물가지수(CPI)", periodOffset: -1, seriesId: "CPIAUCSL",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Producer Price Index", ko: "미국 생산자물가지수(PPI)", periodOffset: -1, seriesId: "PPIACO",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Personal Income and Outlays", ko: "미국 개인소득·지출(PCE 물가)", periodOffset: -1, seriesId: "PCEPI",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Advance Monthly Sales for Retail", ko: "미국 소매판매", periodOffset: -1, seriesId: "RSAFS",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Gross Domestic Product", ko: "미국 GDP(국내총생산)", periodOffset: null, seriesId: "A191RL1Q225SBEA",
    units: [{ param: "lin", displayFormat: "pct", period: "QoQ" }] }, // 분기 데이터라 MoM/YoY 대신 전기비(연율)
  { keyword: "Industrial Production", ko: "미국 산업생산·설비가동률", periodOffset: -1, seriesId: "INDPRO",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Housing Starts", ko: "미국 주택착공건수", periodOffset: -1, seriesId: "HOUST",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Existing Home Sales", ko: "미국 기존주택판매", periodOffset: -1, seriesId: "EXHOSLUSM495S",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "New Residential Sales", ko: "미국 신규주택판매", periodOffset: -1, seriesId: "HSN1F",
    units: [{ param: "pch", displayFormat: "pct", period: "MoM" }, { param: "pc1", displayFormat: "pct", period: "YoY" }] },
  { keyword: "Consumer Confidence", ko: "미국 소비자신뢰지수", periodOffset: 0, seriesId: "UMCSENT",
    units: [{ param: "lin", displayFormat: "index", period: null }] }, // 지수 레벨이라 MoM/YoY 표시 대상 아님
  { keyword: "ISM", ko: "미국 ISM 제조업·서비스업 지수", periodOffset: -1, seriesId: null, units: [] },
];
// FRED의 "FOMC Press Release"·"H.15 Selected Interest Rates"는 실제 회의 일정이 아니라
// 영업일마다(주말 포함으로 뜨는 경우도 있음) 갱신되는 시리즈라서 일부러 제외했습니다.
// FOMC 회의 자체는 정책 결정이라 FRED "release"로 잡히지 않아 이 소스로는 가져올 수 없습니다.

function nyDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // "YYYY-MM-DD"
}

// 매크로/실적 캘린더 둘 다 "지난 영업일부터" 보여주기 위한 기준일 계산입니다. 어제가
// 토/일이면(월요일에 조회하는 경우 등) 계속 거슬러 올라가서 가장 최근 평일(금요일)을 찾습니다.
// TODO: 공휴일까지 건너뛰려면 KR_HOLIDAYS처럼 날짜 목록을 추가해서 같이 걸러주세요.
function previousBusinessDayStr() {
  for (let offset = -1; offset >= -3; offset--) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
    if (weekday !== "Sat" && weekday !== "Sun") {
      return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }
  }
  return nyDateStr(-1); // 이론상 도달하지 않음(3일 연속 주말일 수 없음)
}

// releaseDate("YYYY-MM-DD") 기준으로 offsetMonths만큼 이전 달을 "(N월)" 형태로 반환합니다.
function periodLabel(releaseDate, offsetMonths) {
  if (offsetMonths === null || offsetMonths === undefined) return "";
  const d = new Date(releaseDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return `(${d.getUTCMonth() + 1}월)`;
}

// 최신 관측치(발표치)와 그 직전 관측치(직전치)를 가져옵니다. units는 FRED가 서버에서
// 미리 계산해주는 변환이라, 우리는 최근 2개 값만 받아서 그대로 쓰면 됩니다.
async function fetchFredObservations(seriesId, unitsParam) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}` +
    `&units=${unitsParam}&sort_order=desc&limit=2&file_type=json&api_key=${FRED_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED series 조회 실패 (${seriesId}, ${res.status})`);
  const json = await res.json();
  const obs = (json.observations || []).filter((o) => o.value !== "."); // FRED는 결측치를 "."으로 표시
  return {
    actual: obs[0] ? Number(obs[0].value) : null,
    previous: obs[1] ? Number(obs[1].value) : null,
  };
}

// units 후보를 우선순위(MoM 먼저) 순서로 시도하다가, 발표치가 실제로 있는 첫 후보를 채택합니다.
async function fetchFredActualPrevious(seriesId, unitCandidates) {
  for (const candidate of unitCandidates) {
    const { actual, previous } = await fetchFredObservations(seriesId, candidate.param);
    if (actual !== null) return { actual, previous, displayFormat: candidate.displayFormat, period: candidate.period };
  }
  return { actual: null, previous: null, displayFormat: null, period: null };
}

function formatFredValue(value, displayFormat) {
  if (value === null || !Number.isFinite(value)) return null;
  if (displayFormat === "pct") return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  if (displayFormat === "jobsChg") {
    const manMyeong = value / 10; // PAYEMS는 천 명 단위 → 만 명 단위로 변환
    return `${manMyeong >= 0 ? "+" : ""}${manMyeong.toFixed(1)}만명`;
  }
  if (displayFormat === "index") return value.toFixed(1);
  return String(value);
}

async function fetchMacroCalendar() {
  if (!FRED_API_KEY) return [];

  // 지난 영업일(전일, 주말이면 그 전 금요일)부터 오늘+5일까지 — 아침에 전일 발표 확인 +
  // 앞으로 한 주 확인을 둘 다 할 수 있게 합니다.
  const realtimeStart = previousBusinessDayStr();
  const todayStr = nyDateStr(0);
  const realtimeEnd = nyDateStr(5);
  const url = `https://api.stlouisfed.org/fred/releases/dates?api_key=${FRED_API_KEY}&file_type=json` +
    `&realtime_start=${realtimeStart}&realtime_end=${realtimeEnd}` +
    `&include_release_dates_with_no_data=true&sort_order=asc&limit=1000`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED API 오류 (${res.status}): ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const rows = json.release_dates || [];

  // 원문 release_name으로 keyword를 찾아서, 필터 통과 여부와 한글 표시명(ko)을 동시에 얻습니다.
  const matched = rows
    .map((r) => {
      const hit = MACRO_RELEASES.find((m) =>
        (r.release_name || "").toLowerCase().includes(m.keyword.toLowerCase())
      );
      return hit ? { date: r.date, rawName: r.release_name, ...hit } : null;
    })
    .filter(Boolean);

  // 같은 release가 같은 날 중복으로 들어오는 경우가 있어 (date+원문명) 기준으로 dedup.
  const seen = new Set();
  const deduped = [];
  for (const r of matched) {
    const key = `${r.date}|${r.rawName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  // 안전장치: 정상적인 월간·분기 지표는 7일짜리 창에 한 번만 뜹니다. 원문 release명 기준으로
  // 두 번 이상 나오면(H.15류처럼 매일·영업일마다 갱신되는 release) 통째로 제외합니다.
  // (한글 표시명이 아니라 원문 기준으로 세는 이유: 서로 다른 두 release가 우연히 같은
  //  한글명에 매핑되는 경우까지 "중복"으로 오판해 지워버리는 걸 막기 위함입니다.)
  const rawCounts = {};
  deduped.forEach((e) => { rawCounts[e.rawName] = (rawCounts[e.rawName] || 0) + 1; });
  const filtered = deduped.filter((e) => rawCounts[e.rawName] === 1);

  // 오늘 이전(전일 포함) 이벤트는 "이미 발표됐을 수 있다"고 보고 FRED에서 발표치·직전치를
  // 같이 가져옵니다 (창이 지난 영업일부터 시작하니 오늘 하루만 볼 게 아니라 과거로 걸린 날짜
  // 전부 시도합니다). 내일 이후 이벤트는 아직 안 나온 데이터라 시도해봤자 의미가 없습니다.
  // 컨센서스(예상치)는 FRED에 아예 없는 데이터라 여기 포함되지 않습니다 — 나중에 다른 소스로
  // 보강할 부분입니다.
  const events = await Promise.all(filtered.map(async (e) => {
    const item = { date: e.date, name: `${e.ko}${periodLabel(e.date, e.periodOffset)}` };
    if (e.date <= todayStr && e.seriesId) {
      try {
        const { actual, previous, displayFormat, period } = await fetchFredActualPrevious(e.seriesId, e.units);
        const actualStr = formatFredValue(actual, displayFormat);
        const previousStr = formatFredValue(previous, displayFormat);
        if (actualStr) item.actual = actualStr;
        if (previousStr) item.previous = previousStr;
        if (actualStr && period) item.period = period;
      } catch (err) {
        console.warn(`FRED 시리즈 조회 실패 (${e.seriesId}), 발표치 없이 진행:`, err);
      }
    }
    return item;
  }));

  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

// ============================================================================
// 실적 캘린더 — 이번 주(다음 7일) 실적 발표 예정인 S&P 500 종목만 추려서 보여줍니다.
// - S&P 500 구성종목: GitHub에 공개된 datasets/s-and-p-500-companies CSV를 매번 새로
//   받아옵니다(코드에 하드코딩하지 않음 — 종목 교체가 있어도 자동으로 반영됩니다).
// - 실적 일정·EPS 실적/컨센서스: Finnhub 무료 티어(finnhub.io, 개인용, 분당 60콜).
// - 시가총액: 역시 Finnhub(stock/profile2)에서 받아오는데, 매일 새로 부르면 호출이
//   너무 많아질 수 있어서 Upstash에 종목별로 캐싱해두고, 캐시에 아직 없는 종목만
//   (최대 MAX_NEW_MARKETCAP_LOOKUPS개) 그날 새로 조회합니다.
// ============================================================================
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const SP500_CONSTITUENTS_CSV_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

const GICS_SECTOR_KO = {
  "Information Technology": "IT",
  "Health Care": "헬스케어",
  "Financials": "금융",
  "Consumer Discretionary": "임의소비재",
  "Communication Services": "커뮤니케이션",
  "Industrials": "산업재",
  "Consumer Staples": "필수소비재",
  "Energy": "에너지",
  "Utilities": "유틸리티",
  "Real Estate": "부동산",
  "Materials": "소재",
};

// 이 데이터셋은 회사명에 쉼표가 들어갈 때만 따옴표로 감싸는 표준 CSV 형태라
// 아주 단순한 상태기반 파서로도 안전하게 분리할 수 있습니다.
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

async function fetchSp500Constituents() {
  const res = await fetch(SP500_CONSTITUENTS_CSV_URL);
  if (!res.ok) throw new Error(`S&P 500 구성종목 조회 실패: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const symbolIdx = header.indexOf("Symbol");
  const nameIdx = header.indexOf("Security");
  const sectorIdx = header.indexOf("GICS Sector");

  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const symbol = cells[symbolIdx];
    if (!symbol) continue;
    map[symbol] = { name: cells[nameIdx], sector: cells[sectorIdx] };
  }
  return map;
}

async function fetchFinnhubEarningsCalendar(fromStr, toStr) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub 실적 캘린더 조회 실패: ${res.status}`);
  const json = await res.json();
  return json.earningsCalendar || [];
}

async function fetchFinnhubMarketCap(symbol) {
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub 시총 조회 실패 (${symbol}): ${res.status}`);
  const json = await res.json();
  return Number.isFinite(json.marketCapitalization) ? json.marketCapitalization : null; // 단위: 백만 달러
}

const MAX_NEW_MARKETCAP_LOOKUPS = 30; // 캐시에 없는 신규 종목에 대해서만, 하루 최대 이만큼만 새로 조회

async function fetchEarningsCalendar() {
  if (!FINNHUB_API_KEY) return [];

  // 매크로 캘린더와 같은 규칙: 지난 영업일(전일, 주말이면 그 전 금요일)부터 오늘+5일까지.
  const fromStr = previousBusinessDayStr();
  const toStr = nyDateStr(5);

  const [sp500Map, rawEntries, mcapCache] = await Promise.all([
    fetchSp500Constituents(),
    fetchFinnhubEarningsCalendar(fromStr, toStr),
    redisGet("earnings:marketcap").catch(() => null).then((v) => v || {}),
  ]);

  // S&P 500 구성종목만 남기고, 같은 종목이 여러 번 잡히면(드물게 있음) 첫 항목만 사용합니다.
  const seen = new Set();
  const filtered = [];
  for (const e of rawEntries) {
    if (!sp500Map[e.symbol]) continue;
    if (seen.has(e.symbol)) continue;
    seen.add(e.symbol);
    filtered.push(e);
  }

  // 시총 캐시에 없는 종목만, 하루 상한 안에서 새로 조회합니다(나머지는 다음날 자동으로 채워짐).
  const missing = filtered.filter((e) => !mcapCache[e.symbol]).slice(0, MAX_NEW_MARKETCAP_LOOKUPS);
  for (const e of missing) {
    try {
      const mcap = await fetchFinnhubMarketCap(e.symbol);
      if (mcap !== null) mcapCache[e.symbol] = { value: mcap, updatedAt: new Date().toISOString() };
    } catch (err) {
      console.warn(`Finnhub 시총 조회 실패, 건너뜀 (${e.symbol}):`, err);
    }
  }
  if (missing.length > 0) {
    try { await redisSet("earnings:marketcap", mcapCache); } catch (err) { console.warn("시총 캐시 저장 실패:", err); }
  }

  const events = filtered.map((e) => {
    const info = sp500Map[e.symbol];
    return {
      date: e.date,
      symbol: e.symbol,
      name: info.name,
      sector: GICS_SECTOR_KO[info.sector] || info.sector,
      marketCap: mcapCache[e.symbol] ? mcapCache[e.symbol].value : null, // 단위: 백만 달러
      epsActual: Number.isFinite(e.epsActual) ? e.epsActual : null,
      epsEstimate: Number.isFinite(e.epsEstimate) ? e.epsEstimate : null,
      hour: e.hour || null,
    };
  });

  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

// t.me/s/{channel} 미리보기 페이지에서 메시지 텍스트를 대략 추출합니다.
// ⚠️ 텔레그램이 페이지 구조를 바꾸면 이 정규식도 손봐야 할 수 있습니다.
//
// mustContainAll이 주어지면, 채널이 하루에 여러 번 다른 주제로 글을 올리는 경우
// (예: 아침엔 "간밤 미국 시장 요약", 오후엔 "국내 마감 시황")를 대비해
// 최신 글부터 거슬러 올라가며 해당 키워드를 모두 포함하는 첫 글을 찾습니다.
// 못 찾으면 null을 반환합니다(그 채널이 오늘 시황 형태 글을 안 올렸다는 뜻).
// 예전엔 최신 글로 무조건 폴백했는데, 소스가 1개뿐이던 시절엔 "완전히 빈 결과보단
// 낫다"는 논리가 맞았지만, 여러 채널을 종합하는 지금은 무관한 글(예: 개별 종목
// 실적 리뷰)이 "그 증권사의 오늘 시황"으로 잘못 채택되는 게 소스 하나가 빠지는
// 것보다 더 나쁩니다(메리츠증권 채널에서 실제로 확인된 문제).
function stripHtml(rawHtml) {
  return rawHtml
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

async function fetchLatestPost(channel, mustContainAll = []) {
  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`텔레그램(${channel}) 응답 실패: ${res.status}`);
  const html = await res.text();

  const blocks = [...html.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  if (blocks.length === 0) throw new Error(`텔레그램(${channel})에서 메시지를 찾지 못했습니다.`);

  if (mustContainAll.length > 0) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const text = stripHtml(blocks[i][1]);
      if (mustContainAll.every((kw) => text.includes(kw))) return text;
    }
    return null;
  }

  return stripHtml(blocks[blocks.length - 1][1]);
}

// ============================================================================
// 시황 원문 소스 — 국내는 여러 증권사 리서치 채널을 종합합니다. 채널 하나가 그날
// 글 형식을 바꾸거나 응답이 없어도(휴가, 채널명 변경 등) 나머지 소스만으로 계속
// 진행되도록 Promise.allSettled로 개별 실패를 허용합니다.
//
// ⚠️ mustContainAll 키워드는 신한(shStrategy)·미래에셋(ehdwl)·유안타(tRadarnewsdesk)·
// 키움(KiwoomResearch) 채널 전부 ?debugRaw=1로 실제 확인됨. 새 채널을 추가할 땐
// 배포 후 ?debugRaw=1로 먼저 확인해주세요 — 메리츠증권·교보증권처럼 이 채널이 오늘
// 시황 형태 글 자체를 안 올렸거나(또는 전일 마감 시황을 다음날 올리는 등 발행
// 주기가 다르거나) 형식이 안 맞으면 자동으로 제외됩니다(위 fetchLatestPost 참고).
// ============================================================================
const KR_TELEGRAM_CHANNELS = [
  { id: "shStrategy", firm: "신한투자증권" },
  { id: "tRadarnewsdesk", firm: "유안타증권" },
  { id: "KiwoomResearch", firm: "키움증권" },
];
const US_TELEGRAM_CHANNELS = [
  { id: "ehdwl", firm: "미래에셋증권" },
];
const KR_RAW_KEYWORDS = ["코스피", "코스닥"];
const US_RAW_KEYWORDS = ["S&P", "나스닥"];

// 채널별 성공/실패 사유를 전부 담아 반환합니다(디버그용). 실제 소스로 쓸 것만
// 추리려면 onlySuccessful()을 거치세요.
async function fetchMarketSources(channels, mustContainAll) {
  const settled = await Promise.allSettled(channels.map((c) => fetchLatestPost(c.id, mustContainAll)));
  return channels.map((c, i) => {
    if (settled[i].status === "rejected") return { firm: c.firm, text: null, error: String(settled[i].reason) };
    if (settled[i].value === null) return { firm: c.firm, text: null, error: "오늘자 시황 형태 글을 찾지 못함(키워드 불일치)" };
    return { firm: c.firm, text: settled[i].value, error: null };
  });
}
function onlySuccessful(sources) {
  return sources.filter((s) => s.text);
}

// Claude 프롬프트에 넣을 "[증권사명]\n원문" 블록. 여러 소스일 때 Claude가 어느
// 내용이 어느 증권사 것인지 알아야 "시각이 갈리면 각각 표시"를 할 수 있습니다.
function formatSourcesBlock(sources) {
  return sources.map((s) => `[${s.firm}]\n${s.text}`).join("\n\n---\n\n");
}

async function summarize(sources, marketLabel) {
  const multi = sources.length > 1;
  const divergenceNote = multi
    ? ` 여러 증권사의 공통된 시각은 하나로 종합해서 쓰고, 같은 이슈에 대해 증권사별로 시각이 뚜렷하게 갈리는 부분이 있으면(업황 전망, 금리 영향 해석 등) "OO증권은 ~로 보는 반면 XX증권은 ~로 봄"처럼 구체적으로 대비해서 한 줄로 짚어주세요. 사소한 표현 차이까지 다 짚을 필요는 없고, 실제로 시각이 갈리는 중요한 지점만 다루면 됩니다.`
    : "";
  const prompt = `다음은 ${marketLabel} 시황을 다루는 증권사 리서치 텔레그램 채널${multi ? ` ${sources.length}곳` : ""}의 오늘자 글입니다.

${formatSourcesBlock(sources)}

이 내용을 참고해서 5줄 내외의 간결한 시황 요약을 작성해주세요.${divergenceNote}

스타일 규칙 (반드시 지켜주세요):
- 개조식(명사형 종결)으로 작성. 예: "고용 7만 건으로 컨센서스 6만 대비 상회" (O) / "고용이 7만 건으로 컨센서스 6만 대비 상회했습니다" (X)
- 각 줄은 <br> 태그로 구분해서 하나의 문자열로 작성 (예: "내용1<br>내용2<br>내용3<br>내용4<br>내용5")
- 핵심 수치와 종목명은 <strong>태그로 감싸서 강조
- 부연 설명이나 전제 문구 없이, 최종 결과 문자열만 출력하세요 (따옴표나 마크다운 코드블록도 넣지 마세요)`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API 오류 (${res.status}): ${text}`);
  }

  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답에서 텍스트를 찾지 못했습니다.");
  return textBlock.text.trim();
}

function isWeekendKST() {
  const kstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const day = kstNow.getDay(); // 0=일 6=토
  const iso = kstNow.toISOString().slice(0, 10);
  // 토요일 아침엔 "전일(금요일)"이 실제 거래일이었으므로 실행해서 금요일 마감 시황을 반영합니다.
  // 일요일 아침엔 "전일(토요일)"도 휴장이라 가져올 새 내용이 없으므로 건너뜁니다
  // (돌려도 금요일 글을 또 찾아 똑같은 내용을 재생성할 뿐이라 비용만 낭비됩니다).
  return day === 0 || KR_HOLIDAYS.includes(iso);
}

const US_MARKET_CLOSE_HOUR = 16; // 미국 정규장 마감 4:00pm ET (서머타임 여부와 무관하게 America/New_York 기준 시각으로 판단)

// 지금 크론은 UTC 22:30(vercel.json)에 돌아서 미국 정규장 마감(EST 21:00Z / EDT 20:00Z UTC)보다
// 항상 늦게 실행되니 이 체크가 걸릴 일이 원래는 없지만, 나중에 크론 시각이 바뀌어도 미국 업종
// 시황이 장중 값을 조용히 캡처하지 않도록 명시적으로 막아둡니다(국내 kr-sectors.js의
// candidateDates()와 같은 목적).
function isUsMarketClosedNow() {
  const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = nyNow.getDay(); // 0=일 6=토
  if (day === 0 || day === 6) return true; // 주말은 이미 마감 상태
  return nyNow.getHours() >= US_MARKET_CLOSE_HOUR;
}

// KRX Open API에서 오늘 KOSPI 업종 TOP5/BOTTOM5를 직접 가져옵니다 (api/kr-sectors.js와
// 로직은 같지만, fetchIndexCloses()와 같은 이유로 자기 자신을 다시 호출하지 않습니다).
const KRX_AUTH_KEY = process.env.KRX_AUTH_KEY;
const KRX_KOSPI_ENDPOINT = "https://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd";
const KRX_EXCLUDE_NAME_KEYWORDS = [
  "코스피", "코스닥",
  "대형주", "중형주", "소형주",
  "200", "100", "50", "150",
  "고배당", "배당성장", "우량기업",
];

function isKrCompositeOrSizeIndex(name) {
  const trimmed = name.trim();
  if (trimmed === "코스피" || trimmed === "코스닥") return true;
  return KRX_EXCLUDE_NAME_KEYWORDS.some((kw) => trimmed.includes(kw));
}

function toBasDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

const KR_MARKET_CLOSE_HOUR = 15;
const KR_MARKET_CLOSE_MINUTE = 30; // 코스피 정규장 마감 15:30 KST

// 오늘부터 하루씩 거슬러 올라가며 시도할 날짜 후보 목록 (주말은 건너뜀, KRX 데이터 처리 지연 대비).
// 업종 시황은 항상 "마감 기준"만 쓰므로, 오늘 장이 아직 안 끝났으면 오늘 날짜는 후보에서
// 빼고 전 거래일부터 찾습니다 (api/kr-sectors.js의 candidateDates()와 동일한 규칙).
function krxCandidateDates(maxDays = 7) {
  const nowKST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const marketClosedToday =
    nowKST.getHours() > KR_MARKET_CLOSE_HOUR ||
    (nowKST.getHours() === KR_MARKET_CLOSE_HOUR && nowKST.getMinutes() >= KR_MARKET_CLOSE_MINUTE);

  const d = nowKST;
  if (!marketClosedToday) d.setDate(d.getDate() - 1);

  const dates = [];
  while (dates.length < maxDays) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) dates.push(toBasDd(d));
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

async function fetchKrSectors() {
  if (!KRX_AUTH_KEY) throw new Error("KRX_AUTH_KEY 환경변수가 설정되지 않았습니다.");

  let rows = [];
  for (const basDd of krxCandidateDates(7)) {
    const res = await fetch(`${KRX_KOSPI_ENDPOINT}?basDd=${basDd}`, { headers: { AUTH_KEY: KRX_AUTH_KEY } });
    if (!res.ok) continue;
    const data = await res.json();
    const result = data.OutBlock_1 || [];
    if (result.length > 0) { rows = result; break; }
  }
  if (rows.length === 0) throw new Error("최근 7일 이내 발표된 KRX 업종 데이터를 찾지 못했습니다.");

  const sectors = rows
    .filter((r) => r.IDX_NM && !isKrCompositeOrSizeIndex(r.IDX_NM))
    .map((r) => ({ name: r.IDX_NM.trim(), pct: Number(r.FLUC_RT), close: Number(r.CLSPRC_IDX) }))
    .filter((r) => !Number.isNaN(r.pct));
  sectors.sort((a, b) => b.pct - a.pct);

  return { top5: sectors.slice(0, 5), bottom5: sectors.slice(-5).reverse() };
}

// 업종 TOP5/BOTTOM5 각각에 대해 "왜 그렇게 움직였는지" 한 줄 이유를 Claude가 생성합니다.
// 텔레그램 원문에 관련 내용이 있으면 그걸 활용하고, 없으면 업종 특성 기반으로 합리적으로 추정합니다.
async function generateSectorReasons(sources, sectors, marketLabel) {
  if (sectors.length === 0) return [];

  const sectorList = sectors.map((s) => `- ${s.name} (${s.pct > 0 ? "+" : ""}${s.pct}%)`).join("\n");
  const prompt = `다음은 오늘 ${marketLabel} 시황을 다루는 증권사 리서치 텔레그램 채널의 오늘자 글입니다.

${formatSourcesBlock(sources)}

아래는 오늘 실제로 상승·하락 상위로 집계된 업종 목록입니다. 각 업종별로 왜 그런 움직임을 보였는지 개조식(명사형 종결)으로 15~25자 내외의 아주 간결한 한 줄 이유를 작성해주세요. 원문에 관련 내용이 있으면 그걸 활용하고, 없으면 업종 특성과 시황 전반을 참고해 합리적으로 추정해서 작성하세요.

업종 목록:
${sectorList}

아래 JSON 배열 형식으로만 출력하세요. 다른 설명, 마크다운 코드블록, 전제 문구 없이 JSON만 출력합니다:
[{"name":"업종명","reason":"이유"}, ...]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API 오류 (업종 이유, ${res.status}): ${text}`);
  }

  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답(업종 이유)에서 텍스트를 찾지 못했습니다.");

  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  return JSON.parse(cleaned);
}

// S&P 500 공식 GICS 섹터 지수를 Yahoo Finance에서 직접 가져옵니다 (ETF 아님, 지수 자체).
// ⚠️ 이 심볼들(^SP500-XX)이 Yahoo에서 지금도 정상 작동하는지 직접 테스트는 못 해봤습니다.
// 배포 후 ?debugSectors=1 로 먼저 확인해주세요 — 심볼이 죽어있으면 그 업종만 조용히 빠집니다.
const US_SECTOR_INDEX_SYMBOLS = {
  "^SP500-45": "정보기술",
  "^SP500-40": "금융",
  "^SP500-35": "헬스케어",
  "^SP500-25": "임의소비재",
  "^SP500-30": "필수소비재",
  "^GSPE": "에너지",
  "^SP500-20": "산업재",
  "^SP500-15": "소재",
  "^SP500-55": "유틸리티",
  "^SP500-60": "부동산",
  "^SP500-50": "커뮤니케이션서비스",
};

async function fetchUsSectorIndices() {
  const symbols = Object.keys(US_SECTOR_INDEX_SYMBOLS);
  const settled = await Promise.allSettled(
    symbols.map(async (sym) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      if (!res.ok) throw new Error(`${sym} 응답 실패 (${res.status})`);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error(`${sym} 데이터 없음`);
      const close = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose;
      if (!Number.isFinite(close) || !Number.isFinite(prevClose)) throw new Error(`${sym} 필드 누락`);
      const pct = ((close - prevClose) / prevClose) * 100;
      return { name: US_SECTOR_INDEX_SYMBOLS[sym], pct: Number(pct.toFixed(2)) };
    })
  );

  const results = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
  const failed = settled
    .map((r, i) => (r.status === "rejected" ? { symbol: symbols[i], error: String(r.reason) } : null))
    .filter(Boolean);

  if (results.length === 0) throw new Error("모든 섹터 지수 심볼이 실패했습니다: " + JSON.stringify(failed));

  results.sort((a, b) => b.pct - a.pct);
  return { top5: results.slice(0, 5), bottom5: results.slice(-5).reverse(), failed };
}

// ============================================================================
// 개별 종목 공시 요약 — DART(전자공시, opendart.fss.or.kr) 오픈 API로 그날 전체
// 시장 공시를 가져온 뒤, "시장에 영향 줄 만한 유형"만 기계적으로 1차 필터링하고
// 그 소수만 Claude로 최종 선별·한 줄 요약합니다.
//
// list.json 응답엔 공시유형 코드(pblntf_ty/pblntf_detail_ty)가 유상증자·자기주식·
// 합병 등을 전부 "B001 주요사항보고서" 하나로 뭉뚱그려서 줘서 코드만으로는 세부
// 구분이 안 됩니다 — 보고서 제목(report_nm) 키워드 매칭으로 구분합니다(공개된
// DART API 래퍼들도 공통적으로 쓰는 방식). 계약금액 등 숫자 데이터는 이 API에
// 아예 없어서(별도의 회사별 전용 API가 필요) 이번 버전에서는 제외했습니다.
// ============================================================================
const DART_API_KEY = process.env.DART_API_KEY;
const DART_LIST_ENDPOINT = "https://opendart.fss.or.kr/api/list.json";

// [라벨, 제목에 포함되면 "주목할 만함"으로 보는 정규식]. 새 유형을 더 잡고 싶으면
// 한 줄만 추가하면 됩니다.
const DART_NOTABLE_PATTERNS = [
  { label: "유상증자", pattern: /유상증자/ },
  { label: "무상증자", pattern: /무상증자/ },
  { label: "자기주식 취득", pattern: /자기주식.*취득/ },
  { label: "자기주식 처분", pattern: /자기주식.*처분/ },
  // "발행" 여부와 무관하게 사채 종류 키워드만 있으면 걸렸는데, 실제로는 "만기전취득"
  // (조기상환)ㆍ"재매각" 같은 발행과 반대되는 이벤트까지 전부 "발행"으로 잘못 분류되는
  // 문제가 있었습니다(예: "자기교환사채만기전취득결정"). 조기취득/상환/재매각 패턴을
  // 먼저 검사해서 우선 매칭되게 하고, 나머지만 "발행"으로 분류합니다.
  { label: "전환사채 조기취득·상환", pattern: /전환사채.*(만기전취득|조기상환|취득|상환)/ },
  { label: "전환사채 발행", pattern: /전환사채.*발행/ },
  { label: "신주인수권부사채 조기취득·재매각", pattern: /신주인수권부사채.*(만기전취득|조기상환|취득|재매각|매각)/ },
  { label: "신주인수권부사채 발행", pattern: /신주인수권부사채.*발행/ },
  { label: "교환사채 조기취득·상환", pattern: /교환사채.*(만기전취득|조기상환|취득|상환)/ },
  { label: "교환사채 발행", pattern: /교환사채.*발행/ },
  { label: "회사분할", pattern: /회사분할/ },
  { label: "회사합병", pattern: /회사합병|합병\s*결정/ },
  { label: "주식교환·이전", pattern: /주식교환|주식이전/ },
  { label: "영업양수도", pattern: /영업양수|영업양도/ },
  { label: "자산양수도", pattern: /자산양수|자산양도/ },
  { label: "타법인 지분 양수도", pattern: /타법인.*(양수|양도)/ },
  { label: "공급계약체결", pattern: /단일판매.*공급계약|공급계약체결/ },
  { label: "잠정실적", pattern: /잠정실적/ },
  { label: "손익구조 변경", pattern: /매출액.*변경|손익구조.*변경/ },
  { label: "부도·영업정지·회생절차", pattern: /부도발생|영업정지|회생절차|해산사유/ },
  { label: "소송", pattern: /소송/ },
  { label: "해외상장·상장폐지", pattern: /해외증권시장상장/ },
];

// [기재정정]/[첨부정정] 등은 원본 공시와 같은 사안에 대한 후속 정정일 뿐이라,
// 걸러내지 않으면 하나의 사건이 Claude 요약에 중복으로 들어갈 수 있습니다.
const DART_AMENDMENT_TITLE_PATTERN = /^\[(기재정정|첨부정정|첨부추가|정정신고)\]/;

async function fetchDartDisclosuresRaw(bgnDe, endDe = bgnDe) {
  let rows = [];
  // total_page가 이 상한을 넘는 비정상 상황(무한루프)을 막기 위한 안전장치일 뿐이라
  // 넉넉하게 잡습니다 — 실제로 60(=6,000건)을 밑도는 날에는 total_page를 만나는 대로
  // 그전에 멈춥니다.
  for (let page = 1; page <= 60; page++) {
    const url = `${DART_LIST_ENDPOINT}?crtfc_key=${DART_API_KEY}&bgn_de=${bgnDe}&end_de=${endDe}&page_no=${page}&page_count=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DART API 오류 (${res.status})`);
    const json = await res.json();
    if (json.status === "013") break; // 그날 공시 없음(정상)
    if (json.status !== "000") throw new Error(`DART API 오류 (status ${json.status}): ${json.message || ""}`);
    const list = Array.isArray(json.list) ? json.list : json.list ? [json.list] : [];
    rows = rows.concat(list);
    const totalPage = Number(json.total_page) || 1;
    if (page >= totalPage) break;
  }
  return rows;
}

// 기계적 1차 필터: 화이트리스트 유형만, 정정공시 제외, 같은 회사+같은 유형 하루 1건만.
function filterNotableDisclosures(rows) {
  const seen = new Set();
  const result = [];
  for (const r of rows) {
    const title = (r.report_nm || "").trim();
    if (!title || DART_AMENDMENT_TITLE_PATTERN.test(title)) continue;
    const hit = DART_NOTABLE_PATTERNS.find((p) => p.pattern.test(title));
    if (!hit) continue;
    const dedupeKey = `${r.corp_code}|${hit.label}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push({ date: r.rcept_dt, corpName: r.corp_name, corpCode: r.corp_code, title, type: hit.label, rceptNo: r.rcept_no });
  }
  return result;
}

// 1차 필터를 통과한(보통 하루 수 건 수준) 후보만 Claude에 보내서, 그 중에서도 정말
// 중요한 것만 최종 선별하고 기존 "개별 종목 및 이슈" 스타일 한 줄로 요약합니다.
async function generateDisclosureSummaries(disclosures) {
  if (disclosures.length === 0) return [];

  const listText = disclosures.map((d) => `- [${d.type}] ${d.corpName}: ${d.title}`).join("\n");
  const prompt = `다음은 오늘 한국 상장기업들이 전자공시(DART)에 제출한 공시 중, 시장에 영향을 줄 수 있는 유형만 기계적으로 1차 필터링한 후보 목록입니다.

${listText}

이 중에서 실제로 시장/주가에 영향을 줄 만큼 중요한 것만 골라 개조식(명사형 종결)으로 한 줄 요약해주세요. 제목만으로 판단이 애매하면 회사명·유형을 참고해 합리적으로 판단하되, 절차적이거나 사소해 보이는 건 제외하세요. 최대 5개까지만 고르세요(전부 사소하면 빈 배열을 반환하세요).

아래 JSON 배열 형식으로만 출력하세요 (다른 설명, 마크다운 코드블록 없이):
[{"corpName":"회사명","summary":"한 줄 요약"}, ...]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API 오류 (공시 요약, ${res.status}): ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답(공시 요약)에서 텍스트를 찾지 못했습니다.");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  return JSON.parse(cleaned);
}

async function fetchAndSummarizeDisclosures(dateStr) {
  if (!DART_API_KEY) return [];
  const rawRows = await fetchDartDisclosuresRaw(dateStr);
  const notable = filterNotableDisclosures(rawRows);
  return generateDisclosureSummaries(notable);
}

function kstDateStrOffset(offsetDays) {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  kst.setDate(kst.getDate() + offsetDays);
  const y = kst.getFullYear(), m = String(kst.getMonth() + 1).padStart(2, "0"), d = String(kst.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// 대시보드 "공시" 탭용 — 최근 1주일치를 기계적 1차 필터만 거쳐 전부 반환합니다
// (노션용과 달리 Claude 최종 선별은 안 함: 대시보드는 스크롤 가능한 목록이라
// 노션 노트 한 줄 길이 제약이 없고, 매일 조금씩 갱신되니 며칠 지켜보며
// 화이트리스트 자체를 다듬는 게 더 유용합니다). 최신 날짜가 먼저 오도록 정렬합니다.
async function fetchDisclosuresCalendar() {
  if (!DART_API_KEY) return [];
  const bgnDe = kstDateStrOffset(-7);
  const endDe = kstDateStrOffset(0);
  const rawRows = await fetchDartDisclosuresRaw(bgnDe, endDe);
  const notable = filterNotableDisclosures(rawRows);
  notable.sort((a, b) => b.date.localeCompare(a.date));
  return notable;
}

// ============================================================================
// 뉴스 — 국내는 네이버 뉴스 검색 API(고정 매크로 키워드)로, 해외는 Finnhub 일반
// 뉴스 피드로 후보를 모은 뒤, 둘 다 기계적으로 1차 필터링(최근 36시간·신뢰
// 언론사(국내만)·중복 제거)하고 그 후보군에서 Claude가 "오늘 정말 시장에
// 의미있는" 것만 최종 5개씩 골라줍니다(공시 파이프라인과 같은 철학 — 기계적
// 필터가 노이즈를 줄이고, Claude는 이미 걸러진 후보 중 최종 판단만 합니다).
// Claude는 후보 인덱스로만 선택하고 제목·링크·출처는 원문 그대로 씁니다(요약·
// 재구성 없음 — 실제 기사로 링크가 걸리는 헤드라인이라 왜곡 위험을 없애는 게
// 더 중요합니다).
// ============================================================================
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// 임의 종목명 전수 검색은 노이즈만 늘어나므로, 시장 전반에 영향 있는 고정
// 키워드로만 좁게 검색합니다. 더 넓히고 싶으면 이 배열에 키워드만 추가하세요.
const NAVER_NEWS_QUERIES = ["코스피", "코스닥", "원달러 환율"];

// 네이버 뉴스 검색은 "뉴스" 카테고리 전체가 대상이라 군소 매체·중복 송고 기사가
// 섞여 나옵니다. 주요 통신사·경제지 도메인만 화이트리스트로 통과시킵니다.
// (텔레그램 채널처럼, 새 도메인을 추가하면 ?debugNewsRaw=1로 실제 검색 결과에서
// 매칭되는 기사가 있는지 먼저 확인해주세요.)
const NEWS_TRUSTED_DOMAINS = [
  { domain: "yna.co.kr", name: "연합뉴스" },
  { domain: "hankyung.com", name: "한국경제" },
  { domain: "mk.co.kr", name: "매일경제" },
  { domain: "sedaily.com", name: "서울경제" },
  { domain: "edaily.co.kr", name: "이데일리" },
  { domain: "mt.co.kr", name: "머니투데이" },
  { domain: "news1.kr", name: "뉴스1" },
  { domain: "asiae.co.kr", name: "아시아경제" },
  { domain: "fnnews.com", name: "파이낸셜뉴스" },
  { domain: "newsis.com", name: "뉴시스" },
  { domain: "biz.chosun.com", name: "조선비즈" },
  { domain: "einfomax.co.kr", name: "연합인포맥스" },
];

const NEWS_LOOKBACK_HOURS = 36; // 하루 1번(아침) 크론이라 "오늘 0시부터"가 아니라 "최근 36시간"으로 봅니다.

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// 헤드라인 앞의 [속보]/[포토] 같은 태그·공백 차이만 다른 중복 기사를 걸러내기 위한 정규화.
function normalizeNewsTitle(title) {
  return title.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, "").toLowerCase();
}

function isWithinLookbackHours(date, hours) {
  return Number.isFinite(date.getTime()) && (Date.now() - date.getTime()) <= hours * 3600 * 1000;
}

async function fetchNaverNews(query) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=100&sort=date`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    },
  });
  if (!res.ok) throw new Error(`네이버 뉴스 검색 실패 (${query}, ${res.status})`);
  const json = await res.json();
  return json.items || [];
}

async function fetchKrNewsCandidates() {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return [];
  const settled = await Promise.allSettled(NAVER_NEWS_QUERIES.map(fetchNaverNews));
  const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const seen = new Set();
  const candidates = [];
  for (const it of items) {
    const link = it.originallink || it.link;
    const domain = hostnameOf(link);
    const trusted = NEWS_TRUSTED_DOMAINS.find((t) => domain === t.domain || domain.endsWith(`.${t.domain}`));
    if (!trusted) continue;
    const pubDate = new Date(it.pubDate);
    if (!isWithinLookbackHours(pubDate, NEWS_LOOKBACK_HOURS)) continue;
    const title = stripHtml(it.title);
    const key = normalizeNewsTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ title, source: trusted.name, link, pubDate: pubDate.toISOString() });
  }
  return candidates;
}

async function fetchFinnhubGeneralNews() {
  const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub 뉴스 조회 실패 (${res.status})`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

async function fetchUsNewsCandidates() {
  if (!FINNHUB_API_KEY) return [];
  const items = await fetchFinnhubGeneralNews();

  const seen = new Set();
  const candidates = [];
  for (const it of items) {
    if (!it.headline || !it.url || !Number.isFinite(it.datetime)) continue;
    const pubDate = new Date(it.datetime * 1000);
    if (!isWithinLookbackHours(pubDate, NEWS_LOOKBACK_HOURS)) continue;
    const key = normalizeNewsTitle(it.headline);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ title: it.headline, source: it.source || "", link: it.url, pubDate: pubDate.toISOString() });
  }
  return candidates;
}

// 1차 필터를 통과한 후보(보통 국내·해외 각 수십 건 이내)를 Claude에 인덱스와 함께
// 보내서, 정말 중요한 것만 최종 5개씩 고르게 합니다. Claude는 제목을 다시 쓰지
// 않고 인덱스만 골라서 돌려주므로, 실제 기사 링크·제목·출처는 항상 원문 그대로
// 유지됩니다.
async function generateNewsSelections(krCandidates, usCandidates) {
  if (krCandidates.length === 0 && usCandidates.length === 0) return { kr: [], us: [] };

  const listText = (label, list) => list.length
    ? list.map((c, i) => `${label}-${i}: [${c.source}] ${c.title}`).join("\n")
    : "(후보 없음)";

  const prompt = `다음은 최근 신뢰 가능한 언론사 위주로 1차 필터링한 국내·해외 뉴스 헤드라인 후보입니다.

[국내 후보]
${listText("KR", krCandidates)}

[해외 후보]
${listText("US", usCandidates)}

이 중에서 실제로 시장에 영향을 줄 만큼 중요한 것만 국내·해외 각각 최대 5개씩 골라주세요. 같은 사안을 다루는 중복·유사 기사는 하나만, 단순 통계 재탕이나 시장과 무관한 사건은 제외하세요. 후보 인덱스(예: "KR-0")로만 답하고, 전부 사소하면 해당 배열은 비워도 됩니다.

아래 JSON 형식으로만 출력하세요 (다른 설명, 마크다운 코드블록 없이):
{"kr": ["KR-0", "KR-3", ...], "us": ["US-1", ...]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API 오류 (뉴스 선별, ${res.status}): ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답(뉴스 선별)에서 텍스트를 찾지 못했습니다.");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  const picked = JSON.parse(cleaned); // { kr: ["KR-0", ...], us: ["US-1", ...] }

  const pickByIndex = (label, list, ids) => (ids || [])
    .map((id) => {
      const m = id.match(new RegExp(`^${label}-(\\d+)$`));
      return m ? list[Number(m[1])] : null;
    })
    .filter(Boolean);

  return {
    kr: pickByIndex("KR", krCandidates, picked.kr),
    us: pickByIndex("US", usCandidates, picked.us),
  };
}

// 대시보드 "뉴스" 탭용 — 국내·해외 각 최종 선별 결과를 하나의 목록으로 합쳐 반환합니다.
async function fetchNewsCalendar() {
  const [krCandidates, usCandidates] = await Promise.all([
    fetchKrNewsCandidates(),
    fetchUsNewsCandidates(),
  ]);
  const { kr, us } = await generateNewsSelections(krCandidates, usCandidates);
  const toEvent = (market) => (c) => ({
    date: c.pubDate.slice(0, 10),
    title: c.title,
    source: c.source,
    link: c.link,
    market,
  });
  const events = [...kr.map(toEvent("KR")), ...us.map(toEvent("US"))];
  events.sort((a, b) => b.date.localeCompare(a.date));
  return events;
}

// ============================================================================
// Notion 연동 — 매일 "시장" / "개별 종목 및 이슈" 항목을 노션 페이지 맨 위에 추가
// ============================================================================
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const NOTION_ANCHOR_BLOCK_ID = process.env.NOTION_ANCHOR_BLOCK_ID;

// Notion 블록 ID는 대시(-) 포함 UUID 형식을 기대합니다. URL에서 복사한 값이
// 대시 없이 32자리로 오는 경우를 대비해 표준 형식으로 보정합니다.
function formatNotionId(id) {
  if (!id) return id;
  const hex = id.replace(/[^a-f0-9]/gi, "");
  if (hex.length !== 32) return id; // 이미 다른 형식이면 그대로 시도
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function notionInsertBlocks(children) {
  const pageId = formatNotionId(NOTION_PAGE_ID);
  const after = formatNotionId(NOTION_ANCHOR_BLOCK_ID);

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ children, after }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notion API 오류 (${res.status}): ${text}`);
  }
  return res.json();
}

function rt(text, bold = false) {
  return { type: "text", text: { content: text }, annotations: { bold } };
}

// "**굵게**" 마크다운이 섞인 문단을 Notion rich_text 배열로 변환합니다.
function parseBoldMarkdown(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) => {
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    return m ? rt(m[1], true) : rt(p, false);
  });
}

function heading2(text) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [rt(text)] } };
}
function heading3(text) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: [rt(text)] } };
}
function paragraph(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: parseBoldMarkdown(text) } };
}
function bullet(text) {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [rt(text)] } };
}

// 오늘의 "시장" 문단을 노트 스타일(국내/해외 굵게 리드인 + 서술형)로 생성합니다.
async function generateMarketSection(krSources, usSources) {
  const prompt = `아래는 오늘 국내·해외 시황을 다루는 증권사 리서치 텔레그램 채널 원문입니다.

[국내 시황 원문 — ${krSources.length}곳]
${formatSourcesBlock(krSources)}

[해외 시황 원문 — ${usSources.length}곳]
${formatSourcesBlock(usSources)}

이 내용을 참고해서, 매일 아침 운용팀 회의용으로 정리하는 "시장" 섹션을 작성해주세요. 대시보드용 5줄 요약보다 훨씬 자세하게, 등락 수치 나열이 아니라 "왜 그렇게 움직였는지" 배경과 논리 중심으로 불릿 형태로 작성합니다. 여러 증권사의 공통된 시각은 하나로 종합하고, 같은 이슈에 대해 증권사별로 시각이 뚜렷하게 갈리는 부분이 있으면 "OO증권은 ~로 보는 반면 XX증권은 ~로 봄"처럼 구체적으로 대비해서 다뤄주세요.

아래 예시 스타일 그대로 작성하세요 (실제 20260812 노트에서 발췌):

국내 예시:
- 개장은 지정학 리스크 심화, 미 국채금리·유가 상승, 뉴욕증시 기술주 약세 여파로 6,240선까지 밀리며 약세 출발
- 오후 들어 반도체 8월 수출 호조(약 100억 달러, YoY 155%)가 확인되며 메모리 가격 정점 통과 우려가 일부 완화
- 외국인·기관 동반 순매수(각각 446억·319억 원)에 힘입어 6,300선 재탈환, 개인은 724억 원 순매도
- 삼성전자 +4.13%, SK하이닉스 +0.35%로 반도체 대형주가 지수 견인
- 전일 급등했던 코스닥은 차익실현 매물에 상승폭 크게 둔화(+0.39%)

해외 예시:
- 미-이란 간 호르무즈 해협 재개 협상이 교착 국면에 빠지며(이란, 미군 철수·손해배상 요구) 유가가 배럴당 83달러 상회
- 유가 상승이 기술주 중심 매도 압력으로 이어지며 지수 2거래일 연속 하락
- 알파벳이 -2.9~3.6%대 급락하며 지수 낙폭 확대, 온홀딩은 실적 부진 가이던스로 20% 넘게 폭락
- 다음날 예정된 CPI 발표를 앞두고 리스크 회피 심리 부각
- 다만 샌디스크·SK하이닉스 ADR 등 메모리업체는 반등, 코어위브는 컨센서스 상회 실적에 애프터마켓 14% 상승

규칙:
- 개조식(명사형 종결), 각 불릿은 "왜 그런 흐름이 나왔는지" 인과관계·배경 설명 중심 (단순 "OO +X%" 나열 금지, 반드시 이유·맥락과 함께 서술)
- 등락 수치는 배경 설명을 뒷받침하는 용도로만 포함 (수치 자체가 불릿의 핵심이 되지 않게)
- 국내 정확히 5개, 해외 정확히 5개 불릿 (초과 금지). 각 불릿은 1문장 이내로 (대시보드 5줄 요약과 개수는 같게, 다만 등락 배경·이유는 대시보드보다 한 단계 더 자세히)
- 원문에 없는 내용은 지어내지 말 것
- 아래 JSON 형식으로만 출력 (다른 설명, 마크다운 코드블록 금지):
{"kr": ["불릿1", "불릿2", ...], "us": ["불릿1", "불릿2", ...]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4096, // 짧게 쓰라는 지시는 프롬프트로, 이 값은 잘림 방지용 여유분입니다
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API 오류 (시장 섹션, ${res.status}): ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답(시장 섹션)에서 텍스트를 찾지 못했습니다.");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  try {
    return JSON.parse(cleaned); // { kr: [...], us: [...] }
  } catch (err) {
    throw new Error(`시장 섹션 JSON 파싱 실패: ${err.message} | stop_reason: ${json.stop_reason} | 응답 길이: ${cleaned.length} | 끝부분: ${cleaned.slice(-200)}`);
  }
}

// "개별 종목 및 이슈" 불릿 리스트 — 원문에 언급된 종목별 실적·공시·뉴스만 추립니다.
// (팀 내부 미팅/NDR 판단 내용은 원문에 없으므로 여기 포함되지 않습니다.)
async function generateStockNewsSection(krSources, usSources) {
  const prompt = `아래는 오늘 국내·해외 시황을 다루는 증권사 리서치 텔레그램 채널 원문입니다.

[국내 시황 원문 — ${krSources.length}곳]
${formatSourcesBlock(krSources)}

[해외 시황 원문 — ${usSources.length}곳]
${formatSourcesBlock(usSources)}

이 원문에서 "개별 종목별 실적 발표, 공시(공급계약·유상증자 등), 주가에 영향을 줄 만한 뉴스"만 뽑아서 불릿 목록으로 정리해주세요. 여러 채널에서 같은 뉴스가 중복으로 언급되면 한 번만 포함하세요. 아래 예시 스타일 그대로 작성하세요.

예시:
- KT, 2Q26 매출 6.7조(YoY 10%), 영업이익 6,483억(YoY -36%), 컨센서스 상회
- 메리츠금융지주 순이익 7,914억(YoY 7.3%) → 방어주 역할
- 코어위브 컨센서스 상회 실적 발표, 애프터마켓에서 14% 상승

규칙:
- 개조식(명사형 종결)
- 원문에 없는 내용(팀 내부 판단, 포트폴리오 비중 조절 등)은 절대 지어내지 말 것
- 원문에서 종목별 뉴스가 없으면 빈 배열([])을 반환
- 아래 JSON 배열 형식으로만 출력 (다른 설명, 마크다운 코드블록 금지):
["불릿 텍스트1", "불릿 텍스트2", ...]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API 오류 (종목 이슈, ${res.status}): ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답(종목 이슈)에서 텍스트를 찾지 못했습니다.");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  return JSON.parse(cleaned);
}

function todayKSTCompact() {
  const kst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  return kst.replace(/-/g, "");
}

async function postToNotion(krSources, usSources, disclosureSummaries) {
  const [marketSection, stockNews] = await Promise.all([
    generateMarketSection(krSources, usSources),
    generateStockNewsSection(krSources, usSources),
  ]);

  const krBullets = (marketSection.kr || []).map(bullet);
  const usBullets = (marketSection.us || []).map(bullet);

  // 텔레그램 원문 기반 종목 뉴스에 DART 공시 요약을 더하되, 이미 같은 회사가
  // 텔레그램 쪽에서 언급됐으면 중복으로 추가하지 않습니다. 둘 다 활발한 날엔
  // 합쳐서 너무 길어질 수 있어서, 최종 개수를 MAX_STOCK_NEWS_BULLETS로 제한하고
  // 텔레그램(애널리스트가 이미 한 번 걸러서 언급한 것)을 우선 채운 뒤 남는
  // 자리만 DART 쪽으로 채웁니다.
  const MAX_STOCK_NEWS_BULLETS = 5;
  const mentionedText = stockNews.join(" ");
  const dartOnly = (disclosureSummaries || []).filter((d) => !mentionedText.includes(d.corpName));
  const combinedStockNews = [
    ...stockNews,
    ...dartOnly.map((d) => `${d.corpName}, ${d.summary} (공시)`),
  ].slice(0, MAX_STOCK_NEWS_BULLETS);
  const stockBullets = combinedStockNews.length ? combinedStockNews.map(bullet) : [bullet("(오늘은 원문에서 종목별 이슈를 찾지 못했습니다)")];

  const children = [
    heading2(todayKSTCompact()),
    heading3("시장"),
    paragraph("**국내(코스피·코스닥)**"),
    ...krBullets,
    paragraph("**미국(S&P·나스닥·다우)**"),
    ...usBullets,
    heading3("개별 종목 및 이슈"),
    ...stockBullets,
    heading3("일정"),
    bullet(""), // 직접 채워 넣을 빈 칸
  ];

  await notionInsertBlocks(children);
}

// 대부분의 ?debug*=1 진단 라우트는 비용이 없어서(Claude·Notion 호출 없음) 인증 없이 열어둬도
// 안전하지만, debugMarket(Claude 호출)·debugNotion(실제 노션 쓰기)처럼 진짜 비용/부작용이 있는
// 라우트는 누구나 반복 호출해서 낭비시킬 수 있으므로 CRON_SECRET이 설정돼 있으면 요구합니다.
// (CRON_SECRET 자체를 아직 설정 안 하셨다면 이 보호는 적용되지 않습니다 — 파일 상단 안내 참고.)
function requireCronSecret(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized — 비용이 발생하는 진단 라우트라 CRON_SECRET 인증이 필요합니다." });
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  // 진단용: ?debugSectors=1 로 호출하면 Claude/Upstash 없이 Yahoo 섹터 지수 결과만 확인합니다
  // (비용 없음, 저장도 안 함 — CRON_SECRET 없이 브라우저로 바로 테스트 가능).
  if (req.query.debugSectors) {

    try {
      const result = await fetchUsSectorIndices();
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugRaw=1 로 호출하면 Claude 호출 없이 각 채널에서 실제로 가져온 원문과
  // 성공/실패 여부를 그대로 보여줍니다. 새로 채널을 추가하면 실제로
  // mustContainAll 키워드로 오늘자 시황 글을 잘 찾아내는지 이걸로 확인하세요 — 못
  // 찾으면 해당 채널의 KR_TELEGRAM_CHANNELS 항목 옆에 채널별 키워드를 따로 지정해야
  // 할 수 있습니다.
  if (req.query.debugRaw) {
    try {
      const [krSources, usSources] = await Promise.all([
        fetchMarketSources(KR_TELEGRAM_CHANNELS, KR_RAW_KEYWORDS),
        fetchMarketSources(US_TELEGRAM_CHANNELS, US_RAW_KEYWORDS),
      ]);
      const failedChannels = [...krSources, ...usSources]
        .filter((s) => !s.text)
        .map((s) => `${s.firm}: ${s.error}`);
      res.status(200).json({ kr: krSources, us: usSources, failedChannels });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugMarket=1 로 호출하면 새 "시장" 섹션 형식만 미리 확인합니다.
  // (Claude 호출은 발생하지만 노션에는 올리지 않습니다 — 형식 검증용. 비용이 발생하므로 인증 필요.)
  if (req.query.debugMarket) {
    if (!requireCronSecret(req, res)) return;
    try {
      const [krSources, usSources] = await Promise.all([
        fetchMarketSources(KR_TELEGRAM_CHANNELS, KR_RAW_KEYWORDS),
        fetchMarketSources(US_TELEGRAM_CHANNELS, US_RAW_KEYWORDS),
      ]);
      const marketSection = await generateMarketSection(onlySuccessful(krSources), onlySuccessful(usSources));
      res.status(200).json(marketSection);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugNotionEnv=1 로 호출하면 환경변수가 실제로 서버에 전달됐는지만 안전하게 확인합니다
  // (키 전체를 노출하지 않고 길이·접두사만 보여줍니다. 401 오류가 계속되면 이걸로 먼저 확인해주세요.)
  if (req.query.debugNotionEnv) {
    const key = NOTION_API_KEY || "";
    res.status(200).json({
      keyExists: !!NOTION_API_KEY,
      keyLength: key.length,
      trimmedLength: key.trim().length,
      hasHiddenWhitespace: key.length !== key.trim().length,
      keyPrefix: key.slice(0, 10),
      pageIdExists: !!NOTION_PAGE_ID,
      pageIdFormatted: formatNotionId(NOTION_PAGE_ID),
      anchorIdExists: !!NOTION_ANCHOR_BLOCK_ID,
      anchorIdFormatted: formatNotionId(NOTION_ANCHOR_BLOCK_ID),
    });
    return;
  }

  // 진단용: ?debugNotion=1 로 호출하면 Claude 없이 테스트 블록 하나만 노션에 실제로 꼽아봅니다.
  // (연결·권한·앵커 블록 ID가 맞는지 확인용. 성공하면 노션 페이지에 테스트 항목이 실제로 생깁니다.
  //  실제로 페이지에 쓰기 때문에 인증 필요.)
  if (req.query.debugNotion) {
    if (!requireCronSecret(req, res)) return;
    try {
      await notionInsertBlocks([
        heading3(`테스트 — ${new Date().toISOString()}`),
        paragraph("이 블록이 보이면 Notion 연동이 정상 작동하는 거예요. 확인 후 삭제하셔도 됩니다."),
      ]);
      res.status(200).json({ ok: true, message: "노션 페이지를 확인해보세요." });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugHistory=1 로 호출하면 오늘자 지수 종가 조회만 확인합니다 (Upstash에 쓰지 않음, 비용 없음).
  if (req.query.debugHistory) {
    try {
      const { kr, us } = await fetchIndexCloses();
      res.status(200).json({
        kr: { asOfDate: kr.asOfDate, kospi: kr.kospi, kosdaq: kr.kosdaq, usdkrw: kr.usdkrw },
        us: { asOfDate: us.asOfDate, sp500: us.sp500, nasdaq: us.nasdaq, dow: us.dow },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugKrSectors=1 로 호출하면 KRX에서 가져온 KOSPI 업종 TOP5/BOTTOM5만 확인합니다
  // (Upstash에 쓰지 않음, 비용 없음). fetchKrSectors()가 내부 자기 호출 대신 KRX를 직접
  // 부르도록 고친 뒤 실제로 잘 도는지 확인할 때 씁니다.
  if (req.query.debugKrSectors) {
    try {
      const { top5, bottom5 } = await fetchKrSectors();
      res.status(200).json({ top5, bottom5 });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugMacro=1 로 호출하면 FRED에서 가져온 다음 7일 매크로 일정만 확인합니다
  // (기본은 Upstash에 쓰지 않음, FRED_API_KEY 미설정이면 빈 배열이 정상입니다).
  // ?debugMacro=1&save=1 을 붙이면 대시보드가 실제로 읽는 캐시(macro:calendar)에도
  // 그 자리에서 바로 저장합니다 — 정식 크론(밤 22:30 KST)을 안 기다리고 지금 바로
  // 반영하고 싶을 때 씁니다. Claude 호출이 없어 비용은 들지 않습니다.
  if (req.query.debugMacro) {
    try {
      const events = await fetchMacroCalendar();
      let saved = false;
      if (req.query.save) {
        await redisSet("macro:calendar", events);
        saved = true;
      }
      res.status(200).json({ hasApiKey: !!FRED_API_KEY, saved, events });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugEarnings=1 로 호출하면 이번 주 S&P 500 실적 캘린더만 확인합니다
  // (기본은 Upstash에 쓰지 않음, FINNHUB_API_KEY 미설정이면 빈 배열이 정상입니다).
  // ?debugEarnings=1&save=1 을 붙이면 대시보드가 실제로 읽는 캐시(earnings:calendar)에도
  // 그 자리에서 바로 저장합니다.
  if (req.query.debugEarnings) {
    try {
      const events = await fetchEarningsCalendar();
      let saved = false;
      if (req.query.save) {
        await redisSet("earnings:calendar", events);
        saved = true;
      }
      res.status(200).json({ hasApiKey: !!FINNHUB_API_KEY, saved, events });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugDisclosuresCalendar=1 로 호출하면 대시보드 "공시" 탭용 최근 1주일
  // 목록만 확인합니다(Claude 호출 없음, 비용 없음, 기본은 Upstash에 쓰지 않음).
  // ?debugDisclosuresCalendar=1&save=1 을 붙이면 대시보드가 실제로 읽는 캐시
  // (disclosures:calendar)에도 그 자리에서 바로 저장합니다.
  if (req.query.debugDisclosuresCalendar) {
    try {
      const events = await fetchDisclosuresCalendar();
      let saved = false;
      if (req.query.save) {
        await redisSet("disclosures:calendar", events);
        saved = true;
      }
      res.status(200).json({ hasApiKey: !!DART_API_KEY, saved, events });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugDartRaw=1 로 호출하면 오늘 DART 공시 중 1차 필터를 통과한 후보 목록만
  // 확인합니다 (Claude 호출 없음, 비용 없음, 저장도 안 함). 화이트리스트 정규식을
  // 튜닝할 때 Claude 비용 없이 반복 확인하는 용도입니다.
  if (req.query.debugDartRaw) {
    try {
      const dateStr = req.query.date || todayKSTCompact();
      const rawRows = await fetchDartDisclosuresRaw(dateStr);
      const notable = filterNotableDisclosures(rawRows);
      res.status(200).json({ hasApiKey: !!DART_API_KEY, date: dateStr, rawCount: rawRows.length, notable });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugDart=1 로 호출하면 1차 필터 + Claude 최종 선별·요약까지 전체 파이프라인을
  // 확인합니다 (Claude 호출 발생, 비용 있음 — 인증 필요. 노션에는 쓰지 않습니다).
  if (req.query.debugDart) {
    if (!requireCronSecret(req, res)) return;
    try {
      const dateStr = req.query.date || todayKSTCompact();
      const summaries = await fetchAndSummarizeDisclosures(dateStr);
      res.status(200).json({ hasApiKey: !!DART_API_KEY, date: dateStr, summaries });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugNewsRaw=1 로 호출하면 네이버/Finnhub에서 가져와 기계적 1차 필터(신뢰
  // 언론사·최근 36시간·중복 제거)까지만 거친 후보 목록을 확인합니다 (Claude 호출 없음,
  // 비용 없음). 화이트리스트 도메인·검색어를 튜닝할 때 Claude 비용 없이 반복 확인하는 용도입니다.
  if (req.query.debugNewsRaw) {
    try {
      const [kr, us] = await Promise.all([fetchKrNewsCandidates(), fetchUsNewsCandidates()]);
      res.status(200).json({
        hasNaverKey: !!(NAVER_CLIENT_ID && NAVER_CLIENT_SECRET),
        hasFinnhubKey: !!FINNHUB_API_KEY,
        kr, us,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugNews=1 로 호출하면 1차 필터 + Claude 최종 선별까지 전체 파이프라인을
  // 확인합니다 (Claude 호출 발생, 비용 있음 — 인증 필요). ?debugNews=1&save=1 을 붙이면
  // 대시보드가 실제로 읽는 캐시(news:calendar)에도 그 자리에서 바로 저장합니다.
  if (req.query.debugNews) {
    if (!requireCronSecret(req, res)) return;
    try {
      const events = await fetchNewsCalendar();
      let saved = false;
      if (req.query.save) {
        await redisSet("news:calendar", events);
        saved = true;
      }
      res.status(200).json({ saved, events });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // Vercel Cron 검증 (CRON_SECRET을 설정한 경우에만 강제)
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (isWeekendKST()) {
    res.status(200).json({ skipped: true, reason: "주말/공휴일 — 기존 저장값을 그대로 유지합니다." });
    return;
  }

  try {
    // 지수 종가 히스토리 누적과 매크로 캘린더는 아래 텔레그램/Claude 브리핑 단계와 무관하니
    // 먼저 독립적으로 처리합니다. (예전엔 이 아래, 텔레그램 원문 fetch·summarize()보다 뒤에
    // 있었는데, 텔레그램 스크레이핑이나 Claude 요약이 실패하면 그 실패가 여기까지 전파돼서
    // 각자 try/catch로 감싸놨어도 아예 실행조차 안 되는 버그가 있었습니다 — 히스토리가 계속
    // 안 쌓이던 원인.)
    try {
      const { kr, us } = await fetchIndexCloses();
      await Promise.all([
        appendIndexHistory("KOSPI", kr.asOfDate, kr.kospi?.close),
        appendIndexHistory("KOSDAQ", kr.asOfDate, kr.kosdaq?.close),
        appendIndexHistory("USDKRW", kr.asOfDate, kr.usdkrw?.close),
        appendIndexHistory("SP500", us.asOfDate, us.sp500?.close),
        appendIndexHistory("NASDAQ", us.asOfDate, us.nasdaq?.close),
        appendIndexHistory("DOW", us.asOfDate, us.dow?.close),
      ]);
    } catch (err) {
      console.warn("지수 히스토리 누적 실패, 이 부분만 건너뜁니다:", err);
    }

    try {
      const events = await fetchMacroCalendar();
      await redisSet("macro:calendar", events);
    } catch (err) {
      console.warn("매크로 캘린더 갱신 실패, 이 부분만 건너뜁니다:", err);
    }

    try {
      const events = await fetchEarningsCalendar();
      await redisSet("earnings:calendar", events);
    } catch (err) {
      console.warn("실적 캘린더 갱신 실패, 이 부분만 건너뜁니다:", err);
    }

    try {
      const events = await fetchDisclosuresCalendar();
      await redisSet("disclosures:calendar", events);
    } catch (err) {
      console.warn("공시 캘린더 갱신 실패, 이 부분만 건너뜁니다:", err);
    }

    try {
      const events = await fetchNewsCalendar();
      await redisSet("news:calendar", events);
    } catch (err) {
      console.warn("뉴스 캘린더 갱신 실패, 이 부분만 건너뜁니다:", err);
    }

    // 채널 하나가 그날 실패해도(휴가, 형식 변경, 시황 형태 글 없음 등) 나머지
    // 소스만으로 계속 진행됩니다.
    const [krSourcesRaw, usSourcesRaw] = await Promise.all([
      fetchMarketSources(KR_TELEGRAM_CHANNELS, KR_RAW_KEYWORDS),
      fetchMarketSources(US_TELEGRAM_CHANNELS, US_RAW_KEYWORDS),
    ]);
    krSourcesRaw.filter((s) => !s.text).forEach((s) => console.warn(`시황 소스 제외 (${s.firm}): ${s.error}`));
    usSourcesRaw.filter((s) => !s.text).forEach((s) => console.warn(`시황 소스 제외 (${s.firm}): ${s.error}`));
    const krSources = onlySuccessful(krSourcesRaw);
    const usSources = onlySuccessful(usSourcesRaw);
    if (krSources.length === 0) throw new Error("국내 시황 원문을 어느 채널에서도 가져오지 못했습니다.");
    if (usSources.length === 0) throw new Error("해외 시황 원문을 어느 채널에서도 가져오지 못했습니다.");

    const [krBriefing, usBriefing] = await Promise.all([
      summarize(krSources, "국내(코스피/코스닥)"),
      summarize(usSources, "해외(S&P500/나스닥/다우)"),
    ]);

    // 업종별 이유는 별도 실패로 전체가 죽지 않도록 따로 try/catch 처리합니다.
    let krSectorReasons = [];
    try {
      const { top5, bottom5 } = await fetchKrSectors();
      krSectorReasons = await generateSectorReasons(krSources, [...top5, ...bottom5], "한국 증시");
    } catch (err) {
      console.warn("국내 업종별 이유 생성 실패, 이 부분만 건너뜁니다:", err);
    }

    let usSectorsTop = [], usSectorsBottom = [], usSectorReasons = [];
    try {
      if (!isUsMarketClosedNow()) {
        throw new Error("미국 정규장이 아직 마감 전이라(장중 값 캡처 방지) 이번 실행에서는 건너뜁니다.");
      }
      const { top5, bottom5 } = await fetchUsSectorIndices();
      usSectorReasons = await generateSectorReasons(usSources, [...top5, ...bottom5], "미국 증시");
      const reasonMap = {};
      usSectorReasons.forEach(r => { reasonMap[r.name] = r.reason; });
      usSectorsTop = top5.map(s => ({ ...s, reason: reasonMap[s.name] || "" }));
      usSectorsBottom = bottom5.map(s => ({ ...s, reason: reasonMap[s.name] || "" }));
    } catch (err) {
      console.warn("해외 업종 데이터/이유 생성 실패, 이 부분만 건너뜁니다:", err);
    }

    // 실제로 그날 성공한 소스만 출처에 표시합니다(채널 하나가 실패했으면 자동으로 빠짐).
    const krFirms = krSources.map(s => s.firm).join("·");
    const usFirms = usSources.map(s => s.firm).join("·");

    const payload = {
      kr: {
        briefing: krBriefing,
        briefingSource: `출처: ${krFirms}(국내 시황) · Claude 자동 종합`,
        sectorReasons: krSectorReasons,
      },
      us: {
        briefing: usBriefing,
        briefingSource: `출처: ${usFirms}(해외 시황) · Claude 자동 종합`,
        sectorsTop: usSectorsTop,
        sectorsBottom: usSectorsBottom,
        sectorsSource: "출처: Yahoo Finance(S&P 500 GICS 섹터 지수) · Claude 자동 요약",
      },
      generatedAt: new Date().toISOString(),
    };

    await redisSet("briefing:latest", payload);

    // 노션 업데이트는 실패해도 대시보드 데이터 저장에는 영향 없도록 별도 try/catch.
    let notionResult = { skipped: true, reason: "NOTION_API_KEY/NOTION_PAGE_ID/NOTION_ANCHOR_BLOCK_ID 미설정" };
    if (NOTION_API_KEY && NOTION_PAGE_ID && NOTION_ANCHOR_BLOCK_ID) {
      try {
        let disclosureSummaries = [];
        try {
          disclosureSummaries = await fetchAndSummarizeDisclosures(todayKSTCompact());
        } catch (err) {
          console.warn("공시 요약 생성 실패, 이 부분만 건너뜁니다:", err);
        }
        await postToNotion(krSources, usSources, disclosureSummaries);
        notionResult = { ok: true };
      } catch (err) {
        console.warn("Notion 업데이트 실패:", err);
        notionResult = { ok: false, error: String(err) };
      }
    }

    res.status(200).json({ ok: true, notion: notionResult, ...payload });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
