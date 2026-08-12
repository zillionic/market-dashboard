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
  if (!res.ok) throw new Error(`Upstash 저장 실패: ${res.status}`);
}

// t.me/s/{channel} 미리보기 페이지에서 가장 최근 메시지의 텍스트만 대략 추출합니다.
// ⚠️ 텔레그램이 페이지 구조를 바꾸면 이 정규식도 손봐야 할 수 있습니다.
async function fetchLatestPost(channel) {
  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`텔레그램(${channel}) 응답 실패: ${res.status}`);
  const html = await res.text();

  const blocks = [...html.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  if (blocks.length === 0) throw new Error(`텔레그램(${channel})에서 메시지를 찾지 못했습니다.`);

  const lastHtml = blocks[blocks.length - 1][1];
  return lastHtml
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
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
      model: "claude-sonnet-4-6",
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
  return day === 0 || day === 6 || KR_HOLIDAYS.includes(iso);
}

module.exports = async function handler(req, res) {
  // 진단용: ?debug=1 로 호출하면 키가 실제로 서버에 전달됐는지만 안전하게 확인합니다
  // (키 전체를 노출하지 않고 길이와 앞 7자리만 보여줍니다). 확인 끝나면 이 블록은 지워도 됩니다.
  if (req.query.debug) {
    const key = process.env.ANTHROPIC_API_KEY || "";
    res.status(200).json({
      keyExists: !!process.env.ANTHROPIC_API_KEY,
      keyLength: key.length,
      trimmedLength: key.trim().length,
      hasHiddenWhitespace: key.length !== key.trim().length,
      keyPrefix: key.slice(0, 12),
      keySuffix: key.slice(-6),
      upstashUrlExists: !!process.env.UPSTASH_REDIS_REST_URL,
      upstashTokenExists: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    });
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
      fetchLatestPost("shStrategy"),
      fetchLatestPost("ehdwl"),
    ]);

    const [krBriefing, usBriefing] = await Promise.all([
      summarize(krRaw, "국내(코스피/코스닥)"),
      summarize(usRaw, "해외(S&P500/나스닥/다우)"),
    ]);

    const payload = {
      kr: {
        briefing: krBriefing,
        briefingSource: "출처: 신한투자증권 강진혁(국내 시황, t.me/shStrategy) · Claude 자동 요약",
      },
      us: {
        briefing: usBriefing,
        briefingSource: "출처: 사제콩이_서상영(미래에셋증권, t.me/ehdwl) · Claude 자동 요약",
      },
      generatedAt: new Date().toISOString(),
    };

    await redisSet("briefing:latest", payload);
    res.status(200).json({ ok: true, ...payload });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
