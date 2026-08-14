// api/cron-briefing.js
// -----------------------------------------------------------------------------
// Vercel Cron이 매일 아침 8시(KST) 자동 호출하는 함수 (스케줄은 vercel.json 참고).
// 신한투자증권(t.me/shStrategy)·미래에셋증권(t.me/ehdwl) 최신 글을 읽어서
// Claude API로 5줄 개조식 요약을 만들고, Upstash Redis에 저장합니다.
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

// t.me/s/{channel} 미리보기 페이지에서 메시지 텍스트를 대략 추출합니다.
// ⚠️ 텔레그램이 페이지 구조를 바꾸면 이 정규식도 손봐야 할 수 있습니다.
//
// mustContainAll이 주어지면, 채널이 하루에 여러 번 다른 주제로 글을 올리는 경우
// (예: 아침엔 "간밤 미국 시장 요약", 오후엔 "국내 마감 시황")를 대비해
// 최신 글부터 거슬러 올라가며 해당 키워드를 모두 포함하는 첫 글을 찾습니다.
// 못 찾으면 그냥 가장 최근 글을 반환합니다(안전장치).
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
    // 조건에 맞는 글을 못 찾으면 최신 글로 폴백 (완전히 빈 결과보다 낫습니다)
  }

  return stripHtml(blocks[blocks.length - 1][1]);
}

async function summarize(rawText, marketLabel) {
  const prompt = `다음은 ${marketLabel} 시황을 다루는 증권사 텔레그램 채널의 최신 글입니다. 이 내용을 참고해서 5줄 내외의 간결한 시황 요약을 작성해주세요.

스타일 규칙 (반드시 지켜주세요):
- 개조식(명사형 종결)으로 작성. 예: "고용 7만 건으로 컨센서스 6만 대비 상회" (O) / "고용이 7만 건으로 컨센서스 6만 대비 상회했습니다" (X)
- 각 줄은 <br> 태그로 구분해서 하나의 문자열로 작성 (예: "내용1<br>내용2<br>내용3<br>내용4<br>내용5")
- 핵심 수치와 종목명은 <strong>태그로 감싸서 강조
- 부연 설명이나 전제 문구 없이, 최종 결과 문자열만 출력하세요 (따옴표나 마크다운 코드블록도 넣지 마세요)

원문:
${rawText}`;

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

// 같은 배포 안의 /api/kr-sectors를 호출해서 오늘 실제 업종 TOP5/BOTTOM5 숫자를 가져옵니다.
async function fetchKrSectors() {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
  const res = await fetch(`${base}/api/kr-sectors?market=KOSPI`);
  if (!res.ok) throw new Error(`kr-sectors 조회 실패: ${res.status}`);
  const json = await res.json();
  return { top5: json.top5 || [], bottom5: json.bottom5 || [] };
}

// 업종 TOP5/BOTTOM5 각각에 대해 "왜 그렇게 움직였는지" 한 줄 이유를 Claude가 생성합니다.
// 텔레그램 원문에 관련 내용이 있으면 그걸 활용하고, 없으면 업종 특성 기반으로 합리적으로 추정합니다.
async function generateSectorReasons(rawText, sectors, marketLabel) {
  if (sectors.length === 0) return [];

  const sectorList = sectors.map((s) => `- ${s.name} (${s.pct > 0 ? "+" : ""}${s.pct}%)`).join("\n");
  const prompt = `다음은 오늘 ${marketLabel} 시황을 다루는 증권사 텔레그램 채널의 최신 글입니다.

원문:
${rawText}

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
async function generateMarketSection(krRaw, usRaw) {
  const prompt = `아래는 오늘 국내·해외 시황을 다루는 증권사 텔레그램 채널 원문 2개입니다.

[국내 시황 원문]
${krRaw}

[해외 시황 원문]
${usRaw}

이 내용을 참고해서, 매일 아침 운용팀 회의용으로 정리하는 "시장" 섹션을 작성해주세요. 대시보드용 5줄 요약보다 훨씬 자세하게, 등락 수치 나열이 아니라 "왜 그렇게 움직였는지" 배경과 논리 중심으로 불릿 형태로 작성합니다.

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
async function generateStockNewsSection(krRaw, usRaw) {
  const prompt = `아래는 오늘 국내·해외 시황을 다루는 증권사 텔레그램 채널 원문 2개입니다.

[국내 시황 원문]
${krRaw}

[해외 시황 원문]
${usRaw}

이 원문에서 "개별 종목별 실적 발표, 공시(공급계약·유상증자 등), 주가에 영향을 줄 만한 뉴스"만 뽑아서 불릿 목록으로 정리해주세요. 아래 예시 스타일 그대로 작성하세요.

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

async function postToNotion(krRaw, usRaw) {
  const [marketSection, stockNews] = await Promise.all([
    generateMarketSection(krRaw, usRaw),
    generateStockNewsSection(krRaw, usRaw),
  ]);

  const krBullets = (marketSection.kr || []).map(bullet);
  const usBullets = (marketSection.us || []).map(bullet);
  const stockBullets = stockNews.length ? stockNews.map(bullet) : [bullet("(오늘은 원문에서 종목별 이슈를 찾지 못했습니다)")];

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

  // 진단용: ?debugRaw=1 로 호출하면 Claude 호출 없이 텔레그램에서 실제로 가져온 원문 그대로 보여줍니다.
  // (국내/해외 내용이 뒤바뀌어 보일 때, 소스 자체 문제인지 Claude 문제인지 구분하는 용도)
  if (req.query.debugRaw) {
    try {
      const [krRaw, usRaw] = await Promise.all([
        fetchLatestPost("shStrategy", ["코스피", "코스닥"]),
        fetchLatestPost("ehdwl", ["S&P", "나스닥"]),
      ]);
      res.status(200).json({ krRaw, usRaw });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  // 진단용: ?debugMarket=1 로 호출하면 새 "시장" 섹션 형식만 미리 확인합니다.
  // (Claude 호출은 발생하지만 노션에는 올리지 않습니다 — 형식 검증용.)
  if (req.query.debugMarket) {
    try {
      const [krRaw, usRaw] = await Promise.all([
        fetchLatestPost("shStrategy", ["코스피", "코스닥"]),
        fetchLatestPost("ehdwl", ["S&P", "나스닥"]),
      ]);
      const marketSection = await generateMarketSection(krRaw, usRaw);
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
  // (연결·권한·앵커 블록 ID가 맞는지 확인용. 성공하면 노션 페이지에 테스트 항목이 실제로 생깁니다.)
  if (req.query.debugNotion) {
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
    const [krRaw, usRaw] = await Promise.all([
      fetchLatestPost("shStrategy", ["코스피", "코스닥"]),
      fetchLatestPost("ehdwl", ["S&P", "나스닥"]),
    ]);

    const [krBriefing, usBriefing] = await Promise.all([
      summarize(krRaw, "국내(코스피/코스닥)"),
      summarize(usRaw, "해외(S&P500/나스닥/다우)"),
    ]);

    // 업종별 이유는 별도 실패로 전체가 죽지 않도록 따로 try/catch 처리합니다.
    let krSectorReasons = [];
    try {
      const { top5, bottom5 } = await fetchKrSectors();
      krSectorReasons = await generateSectorReasons(krRaw, [...top5, ...bottom5], "한국 증시");
    } catch (err) {
      console.warn("국내 업종별 이유 생성 실패, 이 부분만 건너뜁니다:", err);
    }

    let usSectorsTop = [], usSectorsBottom = [], usSectorReasons = [];
    try {
      const { top5, bottom5 } = await fetchUsSectorIndices();
      usSectorReasons = await generateSectorReasons(usRaw, [...top5, ...bottom5], "미국 증시");
      const reasonMap = {};
      usSectorReasons.forEach(r => { reasonMap[r.name] = r.reason; });
      usSectorsTop = top5.map(s => ({ ...s, reason: reasonMap[s.name] || "" }));
      usSectorsBottom = bottom5.map(s => ({ ...s, reason: reasonMap[s.name] || "" }));
    } catch (err) {
      console.warn("해외 업종 데이터/이유 생성 실패, 이 부분만 건너뜁니다:", err);
    }

    const payload = {
      kr: {
        briefing: krBriefing,
        briefingSource: "출처: 신한투자증권 강진혁(국내 시황, t.me/shStrategy) · Claude 자동 요약",
        sectorReasons: krSectorReasons,
      },
      us: {
        briefing: usBriefing,
        briefingSource: "출처: 사제콩이_서상영(미래에셋증권, t.me/ehdwl) · Claude 자동 요약",
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
        await postToNotion(krRaw, usRaw);
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
