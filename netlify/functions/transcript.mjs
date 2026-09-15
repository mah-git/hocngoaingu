// Netlify Function: lấy phụ đề YouTube phía server (tin cậy hơn scrape client).
// GET /.netlify/functions/transcript?v=VIDEO_ID&lang=en
// Trả JSON: { segs:[{start,end,text}], name, lang }  hoặc { error }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Cắt JSON cân bằng ngoặc bắt đầu từ marker (an toàn hơn regex cho object lớn)
function extractJSON(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const j = html.indexOf("{", i);
  if (j < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = j; k < html.length; k++) {
    const ch = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return html.slice(j, k + 1); }
    }
  }
  return null;
}

// Gộp cue nhỏ thành câu hoàn chỉnh theo dấu kết câu
function cues2sent(cues) {
  const out = [];
  let buf = "", st = null, en = null;
  const flush = () => { if (buf.trim()) out.push({ start: st, end: en, text: buf.trim().replace(/\s+/g, " ") }); buf = ""; st = null; };
  for (const c of cues) {
    const t = (c.text || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (st === null) st = c.start;
    en = c.end;
    buf += (buf ? " " : "") + t;
    if (/[.!?…]["')\]]?$/.test(t)) flush();
  }
  flush();
  return out;
}

export const handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const v = qs.v;
  const langPref = qs.lang || "";
  const H = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  };
  if (!v || !/^[\w-]{11}$/.test(v))
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: "video id không hợp lệ" }) };

  try {
    const watch = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(v) + "&hl=en", {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+1" },
    });
    const html = await watch.text();

    // 1) ưu tiên ytInitialPlayerResponse (đầy đủ, chuẩn)
    let tracks = null;
    const prRaw = extractJSON(html, "ytInitialPlayerResponse");
    if (prRaw) {
      try {
        const pr = JSON.parse(prRaw);
        tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
                 pr.captions.playerCaptionsTracklistRenderer.captionTracks;
      } catch (e) {}
    }
    // 2) fallback: bắt trực tiếp captionTracks
    if (!tracks) {
      const cm = html.match(/"captionTracks":(\[.*?\])/s);
      if (cm) { try { tracks = JSON.parse(cm[1].replace(/\\u0026/g, "&")); } catch (e) {} }
    }
    if (!tracks || !tracks.length) {
      const dbg = qs.debug ? {
        _debug: {
          len: html.length,
          hasPlayerResponse: !!prRaw,
          hasCaptionTracksStr: html.indexOf('"captionTracks"') >= 0,
          consentOrBot: /consent|sign in to confirm|not a bot|unusual traffic|\/sorry\//i.test(html),
          snippet: html.slice(0, 220).replace(/\s+/g, " "),
        },
      } : {};
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: "video không có phụ đề", ...dbg }) };
    }

    // chọn track: đúng ngôn ngữ ưu tiên, ưu tiên phụ đề người tạo hơn tự động (asr)
    const pick = (a) => a.slice().sort((x, y) => (x.kind === "asr") - (y.kind === "asr"))[0];
    let track;
    if (langPref) {
      const s = tracks.filter((t) => (t.languageCode || "").startsWith(langPref));
      track = s.length ? pick(s) : pick(tracks);
    } else track = pick(tracks);

    let baseUrl = track.baseUrl.replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
    if (!/[?&]fmt=/.test(baseUrl)) baseUrl += "&fmt=json3";

    const tr = await fetch(baseUrl, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    const data = await tr.json();
    const cues = (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: (e.tStartMs || 0) / 1000,
        end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " "),
      }))
      .filter((c) => c.text.trim());

    const segs = cues2sent(cues);
    if (!segs.length)
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: "phụ đề rỗng" }) };

    const name =
      (track.name && (track.name.simpleText ||
        (track.name.runs && track.name.runs[0] && track.name.runs[0].text))) ||
      track.languageCode;

    return { statusCode: 200, headers: H, body: JSON.stringify({ segs, name, lang: track.languageCode }) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
