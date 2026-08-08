// api/kr-sectors.js
// -----------------------------------------------------------------------------
// Vercel 서버리스 함수 — KRX Open API로 KOSPI/KOSDAQ 업종지수 등락률 TOP5 · BOTTOM5 조회
//
// 배포 전 설정 (필수):
//   Vercel 프로젝트 > Settings > Environment Variables 에 추가
//     이름: KRX_AUTH_KEY
//     값:  KRX Open API에서 발급받은 인증키 (data.krx.co.kr, openapi.krx.co.kr)
//   ※ 인증키를 코드에 직접 넣지 마세요. 이 파일은 서버에서만 실행되므로
//     환경변수로 넣으면 클라이언트(브라우저)에는 절대 노출되지 않습니다.
//
// 배포 후 호출 방법:
//   GET https://<your-project>.vercel.app/api/kr-sectors            → KOSPI, 최근 거래일
//   GET https://<your-project>.vercel.app/api/kr-sectors?market=KOSDAQ
//   GET https://<your-project>.vercel.app/api/kr-sectors?basDd=20260807  → 특정 날짜 지정
//
// 응답 예시:
//   {
//     "market": "KOSPI",
//     "basDd": "20260807",
//     "top5":    [{ "name": "코스피 화학", "pct": 3.21, "close": 4820.11 }, ...],
//     "bottom5": [{ "name": "코스피 유통업", "pct": -2.15, "close": 512.4 }, ...],
//     "rawCount": 21,
//     "updatedAt": "2026-08-08T01:00:00.000Z"
//   }
//
// 대시보드 쪽에서는 이 JSON을 받아 DATA.kr.sectorsTop / DATA.kr.sectorsBottom 형태로
// 매핑하면 됩니다. 단, "reason"(왜 올랐는지 한 줄 설명)은 KRX API에 없는 정보라
// 여전히 사람(또는 Claude)이 채워야 합니다 — 숫자만 자동화되는 구조입니다.
// -----------------------------------------------------------------------------

const ENDPOINTS = {
  KOSPI: "https://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd",
  KOSDAQ: "https://data-dbg.krx.co.kr/svc/apis/idx/kosdaq_dd_trd",
};

// 코스피/코스닥 "종합지수"·"규모별 지수"는 업종이 아니므로 순위 계산에서 제외합니다.
// KRX 응답을 실제로 받아본 뒤 이름이 다르면 이 목록을 그에 맞게 다듬어주세요.
const EXCLUDE_NAME_KEYWORDS = [
  "코스피", "코스닥", // 종합지수 자체 (정확히 이 이름인 행만 아래에서 별도 처리)
  "대형주", "중형주", "소형주",
  "200", "100", "50", "150",
  "고배당", "배당성장", "우량기업",
];

function isCompositeOrSizeIndex(name) {
  const trimmed = name.trim();
  if (trimmed === "코스피" || trimmed === "코스닥") return true;
  return EXCLUDE_NAME_KEYWORDS.some((kw) => trimmed.includes(kw));
}

function getLastTradingDay() {
  const d = new Date();
  const day = d.getDay(); // 0=일 6=토
  if (day === 0) d.setDate(d.getDate() - 2);
  if (day === 6) d.setDate(d.getDate() - 1);
  // TODO: 한국 공휴일 목록을 반영하려면 여기에 날짜 보정 로직을 추가하세요.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

module.exports = async function handler(req, res) {
  const AUTH_KEY = process.env.KRX_AUTH_KEY;
  if (!AUTH_KEY) {
    res.status(500).json({ error: "KRX_AUTH_KEY 환경변수가 설정되지 않았습니다." });
    return;
  }

  const market = (req.query.market || "KOSPI").toUpperCase();
  const endpoint = ENDPOINTS[market];
  if (!endpoint) {
    res.status(400).json({ error: "market은 KOSPI 또는 KOSDAQ 이어야 합니다." });
    return;
  }

  const basDd = req.query.basDd || getLastTradingDay();

  try {
    const krxRes = await fetch(`${endpoint}?basDd=${basDd}`, {
      headers: { AUTH_KEY },
    });

    if (!krxRes.ok) {
      const text = await krxRes.text().catch(() => "");
      res.status(krxRes.status).json({ error: `KRX API 오류 (${krxRes.status})`, detail: text });
      return;
    }

    const data = await krxRes.json();
    const rows = data.OutBlock_1 || [];

    const compositeRow = rows.find((r) => r.IDX_NM && r.IDX_NM.trim() === (market === "KOSPI" ? "코스피" : "코스닥"));
    const composite = compositeRow
      ? {
          name: compositeRow.IDX_NM.trim(),
          close: Number(compositeRow.CLSPRC_IDX),
          pct: Number(compositeRow.FLUC_RT),
          change: Number(compositeRow.CMPPREVDD_IDX),
        }
      : null;

    const sectors = rows
      .filter((r) => r.IDX_NM && !isCompositeOrSizeIndex(r.IDX_NM))
      .map((r) => ({
        name: r.IDX_NM.trim(),
        pct: Number(r.FLUC_RT),
        close: Number(r.CLSPRC_IDX),
      }))
      .filter((r) => !Number.isNaN(r.pct));

    sectors.sort((a, b) => b.pct - a.pct);

    const top5 = sectors.slice(0, 5);
    const bottom5 = sectors.slice(-5).reverse();

    // 1시간 캐시 — 하루 여러 번 눌러도 KRX 호출 횟수(일 10,000회 제한)를 아낍니다.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
    res.status(200).json({
      market,
      basDd,
      composite,
      top5,
      bottom5,
      rawCount: sectors.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
