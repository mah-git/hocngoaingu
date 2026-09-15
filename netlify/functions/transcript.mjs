// Netlify Function: lấy phụ đề YouTube phía server qua InnerTube player API.
// GET /.netlify/functions/transcript?v=VIDEO_ID&lang=en[&debug=1]
// Trả JSON: { segs:[{start,end,text}], name, lang, via }  hoặc { error }

const IT_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // public INNERTUBE web key (ổn định nhiều năm)

// Các client thử theo thứ tự — ANDROID/IOS né được tường "confirm you're not a bot"
const CLIENTS = [
  { name: "ANDROID", ver: "19.09.37", extra: { androidSdkVersion: 30 },
    ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
  { name: "IOS", ver: "19.09.3", extra: {},
    ua: "com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)" },
  { name: "WEB", ver: "2.20240304.00.00", extra: {},
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" },
];

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

async function itPlayer(v, c) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + IT_KEY + "&prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": c.ua, "Accept-Language": "en" },
    body: JSON.stringify({
      context: { client: Object.assign({ clientName: c.name, clientVersion: c.ver, hl: "en", gl: "US" }, c.extra) },
      videoId: v,
    }),
  });
  return r.json();
}

// json3 (ưu tiên) rồi XML (dự phòng) → mảng cue {start,end,text}
async function fetchCues(baseUrl, ua) {
  baseUrl = baseUrl.replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
  const jUrl = /[?&]fmt=/.test(baseUrl) ? baseUrl : baseUrl + "&fmt=json3";
  try {
    const r = await fetch(jUrl, { headers: { "User-Agent": ua, "Accept-Language": "en" } });
    const d = await r.json();
    const cues = (d.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: (e.tStartMs || 0) / 1000,
        end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " "),
      }))
      .filter((c) => c.text.trim());
    if (cues.length) return cues;
  } catch (e) {}
  // dự phòng: XML <text start dur>
  try {
    const xurl = baseUrl.replace(/&fmt=\w+/, "");
    const r = await fetch(xurl, { headers: { "User-Agent": ua, "Accept-Language": "en" } });
    const xml = await r.text();
    const cues = [];
    const re = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(xml))) {
      const s = parseFloat(m[1]) || 0, dur = parseFloat(m[2]) || 0;
      const txt = m[3]
        .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (txt) cues.push({ start: s, end: s + dur, text: txt });
    }
    return cues;
  } catch (e) {}
  return [];
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

  const tried = [];
  const detail = [];
  try {
    let tracks = null, usedClient = null, playability = null;
    for (const c of CLIENTS) {
      let pr;
      try { pr = await itPlayer(v, c); } catch (e) { tried.push(c.name + ":err"); continue; }
      const st = pr && pr.playabilityStatus && pr.playabilityStatus.status;
      playability = playability || st;
      const t = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
                pr.captions.playerCaptionsTracklistRenderer.captionTracks;
      tried.push(c.name + ":" + (st || "?") + (t ? "(" + t.length + ")" : ""));
      if (qs.debug) detail.push({ client: c.name, status: st,
        reason: pr && pr.playabilityStatus && pr.playabilityStatus.reason,
        keys: Object.keys(pr || {}).slice(0, 12), hasCaptions: !!(pr && pr.captions) });
      if (t && t.length) { tracks = t; usedClient = c; break; }
    }

    if (!tracks || !tracks.length) {
      const dbg = qs.debug ? { _debug: { tried, playability, detail } } : {};
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: "video không có phụ đề", ...dbg }) };
    }

    const pick = (a) => a.slice().sort((x, y) => (x.kind === "asr") - (y.kind === "asr"))[0];
    let track;
    if (langPref) {
      const s = tracks.filter((t) => (t.languageCode || "").startsWith(langPref));
      track = s.length ? pick(s) : pick(tracks);
    } else track = pick(tracks);

    const cues = await fetchCues(track.baseUrl, usedClient.ua);
    const segs = cues2sent(cues);
    if (!segs.length) {
      const dbg = qs.debug ? { _debug: { tried, gotTrack: track.languageCode, cueCount: cues.length } } : {};
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: "phụ đề rỗng", ...dbg }) };
    }

    const name =
      (track.name && (track.name.simpleText ||
        (track.name.runs && track.name.runs[0] && track.name.runs[0].text))) ||
      track.languageCode;

    const dbg = qs.debug ? { _debug: { tried, via: usedClient.name } } : {};
    return { statusCode: 200, headers: H, body: JSON.stringify({ segs, name, lang: track.languageCode, via: usedClient.name, ...dbg }) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: String((e && e.message) || e), tried }) };
  }
};
