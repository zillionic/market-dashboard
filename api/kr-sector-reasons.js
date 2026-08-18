// api/kr-sector-reasons.js
// -----------------------------------------------------------------------------
// 온디맨드 업종 이유 보완용 엔드포인트.
//
// 배경: cron-briefing.js가 매일 아침 그 시점의 업종 TOP5/BOTTOM5에 대한 이유를
// 미리 만들어두지만, KRX가 데이터를 늦게 올리면 그날 실제로 대시보드에 뜨는
// 업종 목록이 cron이 봤던 것과 달라질 수 있습니다 (업종명이 안 맞아서 이유가
// "다음 업데이트에서 채워집니다" placeholder로 남는 문제).
//
// 이 엔드포인트는 대시보드가 열릴 때마다 "지금 실시간 업종 목록"을 받아서:
//   1. 오늘 날짜 캐시(Upstash)에 이미 있는 업종이면 → 그대로 반환 (Claude 호출 없음, 무료)
//   2. 캐시에 없는(새로 나타난) 업종만 → Claude로 이유 생성 → 캐시에 추가 저장 → 반환
// 같은 날 같은 업종 조합이면 이후 호출은 전부 캐시만 읽으므로,
// "열 때마다 비용 발생"이 아니라 "그날 처음 그 업종이 나타났을 때 딱 한 번"만 비용이 듭니다.
//
// 호출: GET /api/kr-sector-reasons?sectors=<JSON 배열>
//   sectors 예시: [{"name":"전기전자","pct":5.16},{"name":"보험","pct":-1.71},...]
//
// 응답: { "전기전자": "이유...", "보험": "이유...", ... }
// -----------------------------------------------------------------------------

const { fetchWithTimeout } = require("../lib/fetchWithTimeout");
const { fetchLatestPost } = require("../lib/telegramFreshPost");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const res = await fetchWithTimeout(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }, 8000);
  if (!res.ok) throw new Error(`Upstash 조회 실패: ${res.status}`);
  const json = await res.json();
  if (!json.result) return null;
  return JSON.parse(json.result);
}

async function redisSet(key, valueObj) {
  const res = await fetchWithTimeout(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(valueObj),
  }, 8000);
  if (!res.ok) throw new Error(`Upstash 저장 실패: ${res.status}`);
}

function todayKSTCompact() {
  const kst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  return kst.replace(/-/g, "");
}

// 텔레그램에서 국내 마감 시황 원문을 가져옵니다. cron-briefing.js와 동일한 신선도
// 검증(최근 24시간 이내 글만 인정)이 적용된 공유 로직을 그대로 씁니다 — 예전엔 이
// 파일만 별도로 신선도 체크 없이 키워드만 매칭해서, 국내 휴장일에 며칠 전 글로
// 업종 이유를 생성하는 것과 같은 종류의 버그가 여기서도 재발할 수 있었습니다.
// 매칭되는 글이 없으면(오늘 새 시황 글이 없음) null을 반환하므로 호출 측에서 처리합니다.
async function fetchKrRaw() {
  const text = await fetchLatestPost("shStrategy", ["코스피", "코스닥"]);
  if (!text) throw new Error("최근 24시간 이내의 신한투자증권 국내 시황 원문을 찾지 못했습니다.");
  return text;
}

async function generateReasonsFor(sectors, krRaw) {
  const sectorList = sectors.map((s) => `- ${s.name} (${s.pct > 0 ? "+" : ""}${s.pct}%)`).join("\n");
  const prompt = `다음은 오늘 한국 증시 시황을 다루는 증권사 텔레그램 채널 원문입니다.

원문:
${krRaw}

아래 업종들에 대해 왜 그런 움직임을 보였는지 개조식(명사형 종결)으로 한 줄 이유를 작성해주세요. 원문에 담긴 근거의 구체성에 따라 길이를 다르게 하세요:
- 원문에 그 업종을 구체적으로 다룬 내용(원인이 된 사건·수치·발언·다른 종목이나 업종과의 연관 등)이 있으면, 그 내용을 살려 원인→결과가 논리적으로 이어지도록 30~45자 내외까지 풍부하게 쓰세요.
- 원문에 특별한 언급이 없어 업종 특성과 시황 전반만으로 추정하는 경우엔, 15~25자 내외로 간결하게만 쓰세요.
두 경우 모두 한 문장(한 줄)으로 끝내고, 여러 문장으로 나누지 마세요. 원문에 없는 내용을 지어내지 마세요.

업종 목록:
${sectorList}

아래 JSON 배열 형식으로만 출력하세요 (다른 설명, 마크다운 코드블록 금지):
[{"name":"업종명","reason":"이유"}, ...]`;

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  }, 15000);
  if (!res.ok) throw new Error(`Anthropic API 오류 (${res.status}): ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const textBlock = (json.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude 응답에서 텍스트를 찾지 못했습니다.");
  const cleaned = textBlock.text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  return JSON.parse(cleaned);
}

// 실제 대시보드는 코스피 TOP5+BOTTOM5(10개)만 보냅니다. 이보다 훨씬 큰 요청이나, 캐시에
// 없는 이름을 계속 다르게 넣어서 매번 새로 Claude를 부르게 만드는 남용을 막기 위한 상한선.
const MAX_SECTORS_PER_REQUEST = 15;
const MAX_CACHED_SECTORS_PER_DAY = 50; // 실제 코스피 업종은 20여 개뿐이라 하루치로 충분히 넉넉한 상한

module.exports = async function handler(req, res) {
  let requested;
  try {
    requested = JSON.parse(req.query.sectors || "[]");
  } catch {
    res.status(400).json({ error: "sectors 파라미터가 올바른 JSON이 아닙니다." });
    return;
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    res.status(400).json({ error: "sectors 파라미터가 비어있습니다." });
    return;
  }
  if (requested.length > MAX_SECTORS_PER_REQUEST) {
    res.status(400).json({ error: `sectors는 한 번에 최대 ${MAX_SECTORS_PER_REQUEST}개까지만 요청할 수 있습니다.` });
    return;
  }

  const cacheKey = `sector-reasons:${todayKSTCompact()}`;

  try {
    let cache = {};
    try {
      cache = (await redisGet(cacheKey)) || {};
    } catch {
      cache = {}; // 캐시 조회 실패해도 계속 진행 (전부 새로 생성)
    }

    const missing = requested.filter((s) => !cache[s.name]);

    // 하루 캐시가 이미 충분히 찼으면(비정상적으로 많은 서로 다른 이름이 들어왔다는 뜻) 더 이상
    // Claude를 부르지 않고, 이미 캐시에 있는 것만 돌려줍니다 — 실제 사용 패턴에서는 절대
    // 도달하지 않는 상한이라 정상 트래픽에는 영향이 없습니다.
    if (missing.length > 0 && Object.keys(cache).length < MAX_CACHED_SECTORS_PER_DAY) {
      const krRaw = await fetchKrRaw();
      const newReasons = await generateReasonsFor(missing, krRaw);
      newReasons.forEach((r) => { cache[r.name] = r.reason; });
      await redisSet(cacheKey, cache);
    }

    const result = {};
    requested.forEach((s) => { if (cache[s.name]) result[s.name] = cache[s.name]; });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
