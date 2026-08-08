// api/kr-breadth.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — KRX Open API "전종목 일별매매정보"로 상승/하락/보합 종목 수 집계
//
// ⚠️ 배포 전 확인 필요 (기존 kr-sectors.js와 다른 점):
//   1. 이 API는 "지수"가 아니라 "주식" 카테고리 서비스입니다.
//      KRX Open API 포털에서 아래 두 서비스를 별도로 "이용신청"해야 합니다.
//        - 유가증권 일별매매정보 (KOSPI)
//        - 코스닥 일별매매정보 (KOSDAQ)
//   2. 이 API는 GET이 아니라 POST 요청입니다 (kr-sectors.js는 GET이었음).
//
// 환경변수: KRX_AUTH_KEY (kr-sectors.js와 동일한 키 재사용, 새로 만들 필요 없음)
//
// 호출: GET https://<your-project>.vercel.app/api/kr-breadth
//       GET https://<your-project>.vercel.app/api/kr-breadth?basDd=20260807
//
// 응답 예시:
//   {
//     "basDd": "20260807",
//     "kospi":  { "up": 554, "down": 322, "flat": 36, "total": 912 },
//     "kosdaq": { "up": 808, "down": 829, "flat": 84, "total": 1721 },
//     "updatedAt": "2026-08-08T01:00:00.000Z"
//   }
// -----------------------------------------------------------------------------

const API_BASE = "https://data-dbg.krx.co.kr/svc/apis/sto";
const ENDPOINTS = {
  KOSPI: "/stk_bydd_trd",   // 유가증권 일별매매정보
  KOSDAQ: "/ksq_bydd_trd",  // 코스닥 일별매매정보
};

function getLastTradingDay() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2);
  if (day === 6) d.setDate(d.getDate() - 1);
  // TODO: 한국 공휴일 목록을 반영하려면 여기에 날짜 보정 로직을 추가하세요.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

async function fetchBreadth(market, basDd, authKey) {
  const res = await fetch(`${API_BASE}${ENDPOINTS[market]}`, {
    method: "POST",
    headers: {
      AUTH_KEY: authKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ basDd }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`KRX ${market} 응답 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  const rows = data.OutBlock_1 || [];

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

module.exports = async function handler(req, res) {
  const AUTH_KEY = process.env.KRX_AUTH_KEY;
  if (!AUTH_KEY) {
    res.status(500).json({ error: "KRX_AUTH_KEY 환경변수가 설정되지 않았습니다." });
    return;
  }

  const basDd = req.query.basDd || getLastTradingDay();

  try {
    const [kospi, kosdaq] = await Promise.all([
      fetchBreadth("KOSPI", basDd, AUTH_KEY),
      fetchBreadth("KOSDAQ", basDd, AUTH_KEY),
    ]);

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
    res.status(200).json({
      basDd,
      kospi,
      kosdaq,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
