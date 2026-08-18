// api/kr-breadth.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — KRX Open API "전종목 일별매매정보"로 상승/하락/보합 종목 수 집계
//
// ⚠️ 배포 전 확인 필요 (kr-sectors.js와 다른 점):
//   1. 이 API는 "지수"가 아니라 "주식" 카테고리 서비스입니다.
//      KRX Open API 포털에서 아래 두 서비스를 별도로 "이용신청"해야 합니다.
//        - 유가증권 일별매매정보 (KOSPI)
//        - 코스닥 일별매매정보 (KOSDAQ)
//   2. 이 API는 GET이 아니라 POST 요청입니다.
//
// 환경변수: KRX_AUTH_KEY (kr-sectors.js와 동일한 키 재사용)
//
// 호출: GET https://<your-project>.vercel.app/api/kr-breadth
//       GET https://<your-project>.vercel.app/api/kr-breadth?basDd=20260807  ← 특정 날짜 강제 지정
//
// ※ kr-sectors.js와 동일하게, 당일 데이터가 아직 없으면 하루씩 뒤로 가며
//   (주말 자동 스킵) 최대 7일 전까지 자동 재시도합니다.
//
// 응답 예시:
//   {
//     "basDd": "20260807",
//     "requestedBasDd": "20260812",
//     "kospi":  { "up": 554, "down": 322, "flat": 36, "total": 912 },
//     "kosdaq": { "up": 808, "down": 829, "flat": 84, "total": 1721 },
//     "updatedAt": "2026-08-08T01:00:00.000Z"
//   }
// -----------------------------------------------------------------------------

const { fetchWithTimeout } = require("../lib/fetchWithTimeout");

const API_BASE = "https://data-dbg.krx.co.kr/svc/apis/sto";
const ENDPOINTS = {
  KOSPI: "/stk_bydd_trd",   // 유가증권 일별매매정보
  KOSDAQ: "/ksq_bydd_trd",  // 코스닥 일별매매정보
};

function toBasDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

const KR_MARKET_CLOSE_HOUR = 15;
const KR_MARKET_CLOSE_MINUTE = 30; // 코스피·코스닥 정규장 마감 15:30 KST

// 상승/하락 종목 수도 kr-sectors.js의 업종 TOP5/BOTTOM5와 동일하게 항상 "마감 기준"으로만
// 보여줍니다(둘 다 같은 히트맵 패널에 나란히 표시되므로 시점이 어긋나면 안 됨). 오늘 장이
// 아직 안 끝났으면 오늘 날짜는 후보에서 빼고 전 거래일부터 찾습니다.
function candidateDates(maxDays = 7) {
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

async function fetchRows(market, basDd, authKey) {
  const res = await fetchWithTimeout(`${API_BASE}${ENDPOINTS[market]}`, {
    method: "POST",
    headers: {
      AUTH_KEY: authKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ basDd }),
  }, 8000);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`KRX ${market} 응답 실패 (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.OutBlock_1 || [];
}

function summarize(rows) {
  let up = 0, down = 0, flat = 0;
  rows.forEach((r) => {
    const rate = Number(r.FLUC_RT);
    if (Number.isNaN(rate)) return;
    if (rate > 0) up++;
    else if (rate < 0) down++;
    else flat++;
  });
  return { up, down, flat, total: rows.length };
}

// 특정 시장에 대해 후보 날짜들(최대 7개)을 동시에 조회하고, 데이터가 있는 가장
// 최근 날짜를 채택합니다. 예전엔 하나씩 순서대로 await하는 직렬 루프였고 개별
// 호출에 타임아웃도 없어서, KRX 응답이 하나라도 멈추면 이 엔드포인트 전체가
// 무한 대기에 빠질 수 있었습니다(kr-sectors.js와 동일한 문제 패턴).
async function fetchWithRetry(market, attempts, authKey) {
  const settled = await Promise.allSettled(attempts.map((basDd) => fetchRows(market, basDd, authKey)));
  for (let i = 0; i < attempts.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled" && result.value.length > 0) {
      return { basDd: attempts[i], summary: summarize(result.value) };
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  const AUTH_KEY = process.env.KRX_AUTH_KEY;
  if (!AUTH_KEY) {
    res.status(500).json({ error: "KRX_AUTH_KEY 환경변수가 설정되지 않았습니다." });
    return;
  }

  const forcedBasDd = req.query.basDd;
  const attempts = forcedBasDd ? [forcedBasDd] : candidateDates(7);
  const requestedBasDd = forcedBasDd || attempts[0];

  try {
    const [kospiResult, kosdaqResult] = await Promise.all([
      fetchWithRetry("KOSPI", attempts, AUTH_KEY),
      fetchWithRetry("KOSDAQ", attempts, AUTH_KEY),
    ]);

    if (!kospiResult || !kosdaqResult) {
      res.status(404).json({
        error: `최근 ${attempts.length}일 이내 발표된 데이터를 찾지 못했습니다.`,
        triedDates: attempts,
      });
      return;
    }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
    res.status(200).json({
      basDd: kospiResult.basDd, // 두 시장이 서로 다른 날짜에서 데이터를 찾는 경우는 거의 없지만, 대표로 코스피 날짜 사용
      requestedBasDd,
      kospi: kospiResult.summary,
      kosdaq: kosdaqResult.summary,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
