// lib/telegramFreshPost.js
// -----------------------------------------------------------------------------
// 텔레그램 채널(t.me/s/) 미리보기 페이지에서 "오늘자로 보기에 안전한" 최신 글을
// 가져오는 공유 로직. api/ 밖에 둔 이유는 lib/fetchWithTimeout.js와 동일합니다.
//
// 채널이 오늘 새 글을 안 올렸어도(휴장일 등) 키워드만 맞으면 며칠 전 글을 "오늘 글"로
// 잘못 채택하던 버그가 실제로 있었습니다(2026-08-18, 국내 휴장일에 시황이 바뀜 —
// t.me/s/ 미리보기 페이지는 최근 메시지 ~20개를 그냥 보여줄 뿐이라, 키워드 매칭만으로는
// 그 글이 "오늘" 것인지 알 수 없었습니다). 각 메시지의 <time datetime="..."> 값도 같이
// 뽑아서, 최근 TELEGRAM_POST_LOOKBACK_HOURS 이내 글만 인정합니다.
// -----------------------------------------------------------------------------
const { fetchWithTimeout } = require("./fetchWithTimeout");
const { stripHtml, isWithinLookbackHours } = require("./textUtils");

const TELEGRAM_POST_LOOKBACK_HOURS = 24;

// mustContainAll이 주어지면, 채널이 하루에 여러 번 다른 주제로 글을 올리는 경우
// (예: 아침엔 "간밤 미국 시장 요약", 오후엔 "국내 마감 시황")를 대비해 최신 글부터
// 거슬러 올라가며 해당 키워드를 모두 포함하는 첫 글을 찾습니다. 못 찾으면 null을
// 반환합니다(그 채널이 오늘 시황 형태 글을 안 올렸다는 뜻 — 무관한 글을 잘못
// 채택하는 것보다 소스 하나가 빠지는 게 낫다는 판단, 메리츠증권 채널에서 실제로
// 확인된 문제).
async function fetchLatestPost(channel, mustContainAll = []) {
  const res = await fetchWithTimeout(`https://t.me/s/${channel}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  }, 10000);
  if (!res.ok) throw new Error(`텔레그램(${channel}) 응답 실패: ${res.status}`);
  const html = await res.text();

  // 텍스트 블록과 그 뒤에 바로 나오는 <time datetime="..."> 하나를 같은 메시지로
  // 묶습니다. 사진만 있는 메시지처럼 텍스트 없이 시각만 있는 항목은 pendingText가
  // 없을 때 나타나므로 자연스럽게 건너뜁니다(뒤섞이지 않음).
  const combined = [...html.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>|<time datetime="([^"]+)"/g)];
  const messages = [];
  let pendingText = null;
  for (const m of combined) {
    if (m[1] !== undefined) {
      pendingText = m[1];
    } else if (m[2] !== undefined && pendingText !== null) {
      messages.push({ text: pendingText, date: new Date(m[2]) });
      pendingText = null;
    }
  }
  if (messages.length === 0) throw new Error(`텔레그램(${channel})에서 메시지를 찾지 못했습니다.`);

  if (mustContainAll.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = stripHtml(messages[i].text);
      if (!mustContainAll.every((kw) => text.includes(kw))) continue;
      if (!isWithinLookbackHours(messages[i].date, TELEGRAM_POST_LOOKBACK_HOURS)) continue;
      return text;
    }
    return null;
  }

  return stripHtml(messages[messages.length - 1].text);
}

module.exports = { fetchLatestPost, TELEGRAM_POST_LOOKBACK_HOURS };
