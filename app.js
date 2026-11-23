import { FFmpeg } from './vendor/ffmpeg/index.js';

const $ = (id) => document.getElementById(id);
const base = location.origin;
let ff = null, tail = [];

function log(m) { const l = $('log'); l.textContent += '\n' + m; l.scrollTop = l.scrollHeight; }
function fail(m) { $('log').textContent = m; const s = $('status'); s.textContent = m; s.style.color = '#ff6b6b'; }
function setBar(p) { $('bar').firstElementChild.style.width = Math.max(0, Math.min(100, p * 100)) + '%'; }

// ---------- settings UI ----------
for (const [id, out] of [['len', 'lenV'], ['num', 'numV']]) $(id).oninput = () => ($(out).textContent = $(id).value);
$('focus').oninput = () => { const v = +$('focus').value; $('focV').textContent = v < 35 ? 'left' : v > 65 ? 'right' : 'center'; };
try { $('groq').value = localStorage.getItem('cc_groq') || ''; $('gem').value = localStorage.getItem('cc_gem') || ''; } catch (e) {}

// ---------- ffmpeg ----------
async function loadFF() {
  if (ff) return ff;
  ff = new FFmpeg();
  ff.on('log', ({ message }) => { tail.push(message); if (tail.length > 400) tail.shift(); });
  ff.on('progress', ({ progress }) => { if (window.__renderProgress) window.__renderProgress(progress); });
  log('Loading video engine (first load downloads ~30 MB)...');
  await ff.load({ coreURL: base + '/vendor/core/ffmpeg-core.js', wasmURL: base + '/vendor/core/ffmpeg-core.wasm', classWorkerURL: base + '/vendor/ffmpeg/worker.js' });
  const font = new Uint8Array(await (await fetch('font.ttf')).arrayBuffer());
  await ff.createDir('/fonts'); await ff.writeFile('/fonts/font.ttf', font);
  return ff;
}
async function run(args) {
  tail = [];
  const code = await ff.exec(args);
  if (code !== 0) throw new Error('ffmpeg failed: ' + tail.slice(-6).join(' | ').slice(0, 400));
}
async function probe(path) {
  tail = []; try { await ff.exec(['-hide_banner', '-i', path]); } catch (e) {}
  const t = tail.join('\n');
  const d = t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = t.match(/Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!d) throw new Error('Could not read this video. Try an mp4.');
  let w = v ? +v[1] : 1280, h = v ? +v[2] : 720;
  const r = t.match(/rotation of (-?\d+)/); if (r && Math.abs(+r[1]) % 180 === 90) [w, h] = [h, w];
  return { dur: +d[1] * 3600 + +d[2] * 60 + +d[3], w, h, hasAudio: /Audio:/.test(t) };
}

// ---------- transcription (Groq) ----------
async function groq(bytes, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const fd = new FormData();
    fd.append('file', new File([bytes], 'audio.m4a', { type: 'audio/mp4' }));
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    fd.append('timestamp_granularities[]', 'segment');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < 3) { log('Groq rate limit, waiting 20s...'); await new Promise((s) => setTimeout(s, 20000)); continue; }
    if (r.status === 401) throw new Error('Groq rejected the API key. Check it at console.groq.com/keys.');
    throw new Error('Groq error ' + r.status + ': ' + (await r.text()).slice(0, 200));
  }
}
function mergeChunk(res, off) {
  const words = (res.words || []).map((w) => ({ word: w.word, start: w.start + off, end: w.end + off }));
  const segs = (res.segments || []).map((s) => ({ start: s.start + off, end: s.end + off, text: (s.text || '').trim(), words: [] }));
  if (!segs.length && words.length) segs.push({ start: words[0].start, end: words.at(-1).end, text: words.map((w) => w.word).join(' '), words: [] });
  for (const w of words) { const m = (w.start + w.end) / 2; const s = segs.find((s) => m >= s.start && m <= s.end + 0.3) || segs.at(-1); if (s) s.words.push(w); }
  for (const s of segs) if (!s.words.length && s.text) { // fallback: spread words evenly
    const ws = s.text.split(/\s+/), d = (s.end - s.start) / ws.length;
    s.words = ws.map((t, k) => ({ word: t, start: s.start + k * d, end: s.start + (k + 1) * d }));
  }
  return segs;
}

// ---------- clip selection ----------
function heuristic(segs, dur, L, n) {
  L = Math.min(L, dur); const step = Math.max(5, Math.floor(L / 2)), c = [];
  for (let st = 0; st <= Math.max(0, dur - L); st += step) {
    const en = st + L; let cov = 0; for (const s of segs) cov += Math.max(0, Math.min(en, s.end) - Math.max(st, s.start));
    c.push({ cov, start: st, end: en });
  }
  c.sort((a, b) => b.cov - a.cov); const out = [];
  for (const x of c) { if (out.every((o) => x.end <= o.start || x.start >= o.end)) out.push({ start: x.start, end: Math.min(x.end, dur), title: 'Clip ' + (out.length + 1) }); if (out.length >= n) break; }
  return out.length ? out : [{ start: 0, end: Math.min(dur, L), title: 'Clip 1' }];
}
async function geminiPick(segs, dur, L, n, key) {
  const lines = segs.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n').slice(0, 60000);
  const prompt = `Pick the ${n} most engaging, self-contained clips from this transcript. Each about ${L} seconds (between ${Math.max(10, L - 10)} and ${L + 15}), opening with a strong hook and ending on a complete thought. No overlaps. Return ONLY a JSON array like [{"start":12.3,"end":45.6,"title":"..."}]. Use exact timestamps from the transcript.\n\nTranscript:\n${lines}`;
  let last;
  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); const txt = j.candidates[0].content.parts.map((p) => p.text).join('');
      const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
      const out = arr.map((d) => ({ start: Math.max(0, +d.start), end: Math.min(dur, +d.end), title: String(d.title || 'Clip').slice(0, 60) }))
        .filter((d) => d.end - d.start >= 8).map((d) => ({ ...d, end: Math.min(d.end, d.start + 90) }));
      if (out.length) return out;
    } catch (e) { last = e; }
  }
  throw last || new Error('no result');
}
function snap(c, segs, dur) {
  const near = (arr, key, v) => arr.reduce((a, b) => (Math.abs(b[key] - v) < Math.abs(a[key] - v) ? b : a));
  const s0 = near(segs, 'start', c.start); if (Math.abs(s0.start - c.start) <= 4) c.start = s0.start;
  const e0 = near(segs, 'end', c.end); if (Math.abs(e0.end - c.end) <= 4 && e0.end - c.start >= 8) c.end = e0.end;
  c.start = Math.max(0, c.start); c.end = Math.min(dur, c.end); return c;
}

// ---------- captions (ASS) ----------
const ass_t = (s) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const clean = (t) => t.replace(/[\\{}\n]/g, '').trim().toUpperCase();
function makeAss(c, segs) {
  const words = [];
  for (const s of segs) { if (s.end <= c.start || s.start >= c.end) continue;
    for (const w of s.words) { const t = clean(w.word); if (t && w.end > c.start && w.start < c.end) words.push([Math.max(w.start, c.start) - c.start, Math.min(w.end, c.end) - c.start, t]); } }
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,54,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,40,40,200,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  for (let i = 0; i < words.length; i += 3) { const g = words.slice(i, i + 3);
    g.forEach(([ws, we], j) => { let end = j + 1 < g.length ? g[j + 1][0] : we; if (end - ws < 0.05) end = ws + 0.05;
      const text = g.map((x, k) => (k === j ? `{\\c&H00FFFF&}${x[2]}{\\c&HFFFFFF&}` : x[2])).join(' ');
      out += `Dialogue: 0,${ass_t(ws)},${ass_t(end)},Default,,0,0,0,,${text}\n`; }); }
  return { text: out, count: words.length };
}

// ---------- ZIP (store only) ----------
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + f.data.length;
  }
  const csz = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csz, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

// ---------- main ----------
let results = [];
$('zip').onclick = () => { const b = makeZip(results.map((r) => ({ name: r.name, data: r.data }))); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'clipcraft_clips.zip'; a.click(); };

$('go').onclick = async () => {
  const file = $('file').files[0], gk = $('groq').value.trim(), mk = $('gem').value.trim();
  if (!file) return fail('Please choose a video file first (step 1).');
  if (!gk) return fail('Please paste your free Groq API key (step 2). Get one at console.groq.com/keys.');
  try { if ($('remember').checked) { localStorage.setItem('cc_groq', gk); localStorage.setItem('cc_gem', mk); } else { localStorage.removeItem('cc_groq'); localStorage.removeItem('cc_gem'); } } catch (e) {}
  $('go').disabled = true; $('status').textContent = 'Working... keep this tab open.'; $('status').style.color = ''; $('results').hidden = true; $('clips').innerHTML = ''; results = []; $('log').textContent = 'Starting...'; setBar(0);
  const L = +$('len').value, N = +$('num').value, focus = +$('focus').value / 100;
  try {
    await loadFF();
    const ext = (file.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
    try { await ff.unmount('/in'); } catch (e) {} try { await ff.deleteDir('/in'); } catch (e) {}
    await ff.createDir('/in'); await ff.mount('WORKERFS', { files: [new File([file], 'input.' + ext)] }, '/in');
    const inp = '/in/input.' + ext;
    const { dur, w, h, hasAudio } = await probe(inp);
    if (!hasAudio) throw new Error('This video has no audio track to transcribe.');
    log(`Video: ${(dur / 60).toFixed(1)} min, ${w}x${h}`);

    // 1) transcribe in 15-min audio chunks
    const CH = 900, nch = Math.ceil(dur / CH); let segs = [];
    for (let i = 0; i < nch; i++) {
      log(`Extracting audio ${i + 1}/${nch}...`); setBar(0.05 + 0.2 * (i / nch));
      await run(['-ss', String(i * CH), '-t', String(CH), '-i', inp, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', '/a.m4a']);
      const bytes = await ff.readFile('/a.m4a'); await ff.deleteFile('/a.m4a');
      if (bytes.length > 24e6) throw new Error('Audio chunk too large for Groq.');
      log(`Transcribing ${i + 1}/${nch} with Whisper (Groq)...`);
      segs = segs.concat(mergeChunk(await groq(bytes, gk), i * CH));
    }
    if (!segs.length) throw new Error('No speech detected in this video.');
    log(`Transcript ready: ${segs.length} segments.`); setBar(0.3);

    // 2) pick clips
    let sel = null, method = 'speech-density';
    if (mk) { try { log('Asking Gemini for the best moments...'); sel = await geminiPick(segs, dur, L, N, mk); method = 'Gemini'; } catch (e) { log('Gemini failed (' + e.message + '), using fallback.'); } }
    if (!sel) sel = heuristic(segs, dur, L, N);
    sel = sel.map((c) => snap(c, segs, dur)).sort((a, b) => a.start - b.start);
    const kept = []; for (const c of sel) if (c.end - c.start >= 5 && kept.every((k) => c.start >= k.end)) kept.push(c);
    sel = (kept.length ? kept : heuristic(segs, dur, L, N)).slice(0, N);
    sel.forEach((c, i) => { if (/^Clip \d+$/.test(c.title)) c.title = 'Clip ' + (i + 1); });
    log(`Picked ${sel.length} clips using ${method}.`);

    // 3) render
    const sw = (w * 1280) / h;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i], dd = c.end - c.start;
      log(`Rendering clip ${i + 1}/${sel.length} (${c.start.toFixed(0)}s-${c.end.toFixed(0)}s, ${c.title})... this can take a few minutes`);
      window.__renderProgress = (p) => setBar(0.35 + 0.65 * ((i + Math.min(1, Math.max(0, p))) / sel.length));
      await ff.writeFile(`/c${i}.ass`, new TextEncoder().encode(makeAss(c, segs).text));
      let crop = 'scale=720:1280:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=720:1280';
      if (sw > 720) { let x = Math.round((sw - 720) * focus); x -= x % 2; crop = `scale=-2:1280:flags=fast_bilinear,crop=720:1280:${x}:0`; }
      await run(['-ss', c.start.toFixed(3), '-i', inp, '-t', dd.toFixed(3), '-vf', `${crop},ass=/c${i}.ass:fontsdir=/fonts`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `/clip${i}.mp4`]);
      const data = await ff.readFile(`/clip${i}.mp4`); await ff.deleteFile(`/clip${i}.mp4`); await ff.deleteFile(`/c${i}.ass`);
      const name = `clip_${i + 1}.mp4`; results.push({ name, data });
      const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      const d = document.createElement('div'); d.className = 'clip';
      d.innerHTML = `<video controls playsinline src="${url}"></video><b></b><a download="${name}" href="${url}">Download ${name}</a>`;
      d.querySelector('b').textContent = c.title; $('clips').appendChild(d); $('results').hidden = false;
    }
    setBar(1); log('Done! Your clips are ready below.');
    try { await ff.unmount('/in'); } catch (e) {}
  } catch (e) { console.error(e); log('ERROR: ' + (e.message || e)); }
  window.__renderProgress = null; $('go').disabled = false; $('status').textContent = 'Ready.';
};

$('go').disabled = false; $('go').textContent = 'Generate clips'; $('status').textContent = 'Ready. Choose a video, paste your Groq key, then click Generate clips.';
