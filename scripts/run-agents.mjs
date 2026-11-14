#!/usr/bin/env node
/**
 * StockPulse AI — Multi-Agent Microstock Trend Radar
 * =================================================
 * Riset tren mikrostock harian (Adobe Stock, Vecteezy, Dreamstime) dengan
 * 5 agen AI berurutan ke Gemini 3.8 Flash (Google Search Grounding).
 * (gemini-2.5-flash sudah deprecated Google per 2 Nov 2026 — untuk
 * key/proyek yang belum pernah memakainya, API mengembalikan 404
 * "no longer available to new users". Model utama kini gemini-3.8-flash.)
 *
 * Alur:
 *   0. Sinyal mentah: Google Trends RSS (US + ID), 15 topik teratas.
 *   1. Agent 01 — Peak-Hour Buyer Search Radar        (google_search)
 *   2. Agent 02 — 3-Platform Insight Auditor          (google_search)
 *   3. Agent 03 — Format & Visual Style Classifier    (tanpa search)
 *   4. Agent 04 — Seasonal Lead-Time & Demand Scorer  (tanpa search)
 *   5. Agent 05 — Fable 5.2 JSON Synthesizer          (JSON mode, tanpa search)
 *
 * Output: public/data/history.json  (snapshot hari ini di days[0], maks 30 hari)
 * Dijalankan oleh GitHub Actions setiap hari 15:00 UTC / 22:00 WIB,
 * atau manual:  npm run update-trends
 *
 * Env:  GEMINI_API_KEY (wajib), THEME (opsional, dari workflow_dispatch)
 *
 * Node.js >= 20, tanpa dependency eksternal (fetch bawaan Node).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Konfigurasi & path
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const THEME = (process.env.THEME || '').trim();
// Model utama + fallback. gemini-2.5-flash deprecated 2 Nov 2026 (404 untuk
// key/proyek baru) — Google menyarankan gemini-3.8-flash sebagai pengganti.
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];
const MODEL = MODELS[0];
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = path.join(ROOT, 'public', 'data', 'history.json');
const MAX_DAYS = 30;
const MIN_IDEAS = 12;
const MIN_PER_CATEGORY = 3;

// ---------------------------------------------------------------------------
// Tanggal & zona waktu Indonesia (Asia/Jakarta)
// ---------------------------------------------------------------------------
function jakartaNow() {
  const now = new Date();

  // Bagian tanggal (hari, bulan, tahun, nama hari) dalam WIB
  const dParts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatToParts(now);
  const get = (t) => dParts.find((p) => p.type === t)?.value;
  const weekday = get('weekday'); // "Sabtu"
  const day = get('day');         // "14"
  const month = get('month');     // "November"
  const year = get('year');       // "2026"

  // ISO YYYY-MM-DD dalam WIB
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // "2026-11-14"

  // Jam HH:mm:ss dalam WIB (untuk lastUpdated)
  const tParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now); // "22:09:41"

  const dateLabel = `${day} ${month} ${year}`;            // "14 November 2026"
  const fullLabel = `${weekday}, ${dateLabel}`;           // "Sabtu, 14 November 2026"
  const lastUpdated = `${iso}T${tParts}+07:00`;           // "2026-11-14T22:09:41+07:00"

  return { iso, dateLabel, fullLabel, lastUpdated, weekday, day, month, year };
}

// ---------------------------------------------------------------------------
// Kalender musiman (untuk Agent 04 — lead time 45–90 hari)
// Imlek 2027 = Tahun KAMBING API (Fire Goat), 6 Februari 2027 — BUKAN kuda.
// ---------------------------------------------------------------------------
const SEASONAL_EVENTS = [
  { name: 'Natal 2026', date: '2026-12-25' },
  { name: 'Tahun Baru 2027', date: '2027-01-01' },
  { name: 'Imlek 2027 (Tahun Kambing Api / Fire Goat)', date: '2027-02-06' },
  { name: 'Valentine 2027', date: '2027-02-14' },
  { name: 'Ramadan 2027 (awal puasa)', date: '2027-02-08' },
  { name: 'Idul Fitri 2027', date: '2027-03-20' },
  { name: 'Idul Adha 2027', date: '2027-05-27' },
  { name: 'HUT RI ke-82', date: '2027-08-17' },
  { name: 'Halloween 2027', date: '2027-10-31' },
];

function upcomingEvents(todayIso) {
  const today = new Date(`${todayIso}T00:00:00+07:00`);
  return SEASONAL_EVENTS
    .map((e) => {
      const d = new Date(`${e.date}T00:00:00+07:00`);
      const daysLeft = Math.round((d - today) / 86400000);
      return { ...e, daysLeft };
    })
    .filter((e) => e.daysLeft >= -7) // masih relevan (baru lewat max 7 hari)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 6)
    .map((e) => `- ${e.name} (${e.date}): ${e.daysLeft >= 0 ? `${e.daysLeft} hari lagi` : `${-e.daysLeft} hari lalu`}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Taksonomi (Agent 03) — HARUS dipakai secara ketat, tanpa mengarang gaya baru
// ---------------------------------------------------------------------------
const TAXONOMY = `
KATEGORI & TAKSONOMI RESMI (pakai HANYA nilai di bawah ini, jangan mengarang gaya baru):

VIDEO — formatType (pilih 1 dari 17 ini):
Looping Background Abstrak | Sinematik Alam (Aerial/Drone) | Timelapse | Slow Motion Makro | Food & Drink B-roll | Teknologi Futuristik | Animasi 2D Flat / Motion Graphic | Musiman (Natal, Lebaran, Imlek) | Budaya Nusantara | Unboxing & Hands-on | Tutorial Langkah-demi-Langkah | Stop Motion | Hyperlapse Kota | Product Reveal Sinematik | Alam & Satwa | Olahraga & Fitness | Workspace & Produktivitas
- visualStyle Video: pilih 1 dari 17 format di atas juga (sebagai tema/gaya visual).
- videoMeta (WAJIB untuk Video): ratio "16:9 Horizontal" ATAU "9:16 Vertikal"; camera "Diam / Static" | "Pan" | "Zoom in" | "Drone" | "Orbit"; loop "Looping Mulus" ATAU "Klip Biasa".

FOTO — formatType: Scene Penuh | Subjek Isolasi (BG polos) | Copy Space
- visualStyle Foto (JPEG): Cinematic | Studio Putih Minimalis | Flat Lay Top-Down | Macro Close-up | Golden Hour | Blue Hour Twilight | Moody Low-Key | High-Key Bright Airy | Aerial Drone View | Long Exposure | Bokeh Shallow DOF | Lifestyle Candid | Product Clean Mockup | Food Editorial

ILUSTRASI — formatType: Ilustrasi Full Layar | Isolated Background
- visualStyle Ilustrasi: Bebas (Tanpa Gaya Khusus) | 3D Glassmorphism | Cyber-UI Dark Neon | Isometrik Data & Cloud | Modern Flat 2.0 (Soft Gradient) | Hand-drawn Doodle | Memphis Pattern | Retro Vintage Badge | Halftone Pop Art | Batik Motif Nusantara | Mandala Ornament | Tribal Ornament Flat | Floral Botanical Flat

VECTOR — formatType: Flat Vector | Sticker Pack | Icon Set
- visualStyle Vector: Line Art | WPAP | Flat Design | Siluet | Karikatur Vektor | Anime / Kartun Vektor | Flat Pattern | Op Art Geometris Abstrak | Minimalis Tradisional | Isometrik Flat Infografis | Cut Out Gaya Naif | Ikon Siluet Minimalis | Ikon Logo Flat | Badge & Sale | Banner Template | Frame Template | Background Gradient | Layout Kartu Ucapan | Elemen Infografis | 3D Glassmorphism | Cyber-UI Dark Neon | Isometrik Data & Cloud | Modern Flat 2.0 (Soft Gradient) | Hand-drawn Doodle | Memphis Pattern | Retro Vintage Badge | Gradient Mesh Abstract | Low Poly | Monoline Icon | Duotone | Halftone Pop Art | Stained Glass Mosaic | Batik Motif Nusantara | Mandala Ornament | Art Deco Geometric | Bauhaus Shapes | Swiss Minimal | Tribal Ornament Flat | Floral Botanical Flat
`;

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[stockpulse]`, ...a);

async function readHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.days)) return { lastUpdated: '', days: [] };
    return data;
  } catch {
    log('history.json belum ada / rusak — inisialisasi struktur kosong.');
    return { lastUpdated: '', days: [] };
  }
}

async function writeHistory(data) {
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Sinyal mentah: Google Trends RSS (US + ID), 15 topik teratas
// ---------------------------------------------------------------------------
async function fetchTrendsRSS(geo) {
  const url = `https://trends.google.com/trending/rss?geo=${geo}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (StockPulse AI Trend Radar)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const titles = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)]
      .map((m) => m[1].trim().replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
      .filter(Boolean)
      .slice(0, 15);
    log(`Google Trends RSS ${geo}: ${titles.length} topik.`);
    return titles;
  } catch (e) {
    log(`Peringatan: RSS Trends ${geo} gagal (${e.message}) — lanjut tanpa sinyal ini.`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Panggilan Gemini (dengan retry + backoff untuk 429/5xx)
// ---------------------------------------------------------------------------
function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('\n').trim();
}

async function callGemini(prompt, { useSearch = false, jsonMode = false } = {}) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  if (jsonMode) body.generationConfig = { responseMimeType: 'application/json' };

  let lastErr = null;
  // Coba tiap model secara berurutan. Error 404 (model tidak tersedia untuk
  // key ini) langsung pindah ke model berikutnya; error 429/5xx di-retry
  // pada model yang sama dengan backoff.
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${geminiUrl(model)}?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          const err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        const text = extractText(data);
        if (!text) throw new Error('Respons Gemini kosong (tanpa teks).');
        if (model !== MODEL) log(`Model ${MODEL} tidak tersedia, memakai fallback ${model}.`);
        return text;
      } catch (e) {
        lastErr = e;
        const is404 = e.status === 404 || /404|not found|no longer available/i.test(e.message);
        if (is404) {
          log(`Model ${model} tidak tersedia untuk key ini (${e.message}) — coba model berikutnya.`);
          break; // pindah ke model berikutnya, jangan retry model yang sama
        }
        const retryable = /429|500|502|503|504|overloaded|timeout|fetch failed/i.test(e.message);
        log(`Gemini (${model}) percobaan ${attempt}/3 gagal: ${e.message}`);
        if (!retryable || attempt === 3) break;
        await sleep(5000 * attempt); // backoff 5s, 10s
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Validasi output Agent 05
// ---------------------------------------------------------------------------
function parseJsonLoose(text) {
  let t = text.trim();
  // Buang pagar markdown ```json ... ``` bila ada
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  // Ambil objek JSON pertama...terakhir bila ada teks pengantar
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function validateDayOutput(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return ['Output bukan objek JSON.'];
  if (!Array.isArray(obj.agentLogs) || obj.agentLogs.length < 5) {
    problems.push('agentLogs harus array berisi 5 ringkasan agen.');
  }
  if (!obj.platformInsights?.adobeStock || !obj.platformInsights?.vecteezy || !obj.platformInsights?.dreamstime) {
    problems.push('platformInsights harus berisi adobeStock, vecteezy, dan dreamstime.');
  }
  if (!Array.isArray(obj.ideas)) return [...problems, 'ideas harus array.'];
  if (obj.ideas.length < MIN_IDEAS) {
    problems.push(`ideas hanya ${obj.ideas.length}, minimal ${MIN_IDEAS}.`);
  }
  const perCat = { Video: 0, Foto: 0, Ilustrasi: 0, Vector: 0 };
  for (const idea of obj.ideas) {
    if (perCat[idea?.category] !== undefined) perCat[idea.category]++;
    const missing = ['id', 'title', 'category', 'formatType', 'visualStyle', 'platforms', 'demandScore', 'growthPercent', 'competitionLevel', 'seasonalWindow', 'productionPrompt', 'seoTitle', 'keywords', 'agentLogs']
      .filter((f) => idea?.[f] === undefined || idea?.[f] === null || idea?.[f] === '');
    if (missing.length) problems.push(`Ide ${idea?.id || '(tanpa id)'} kekurangan field: ${missing.join(', ')}.`);
    if (idea?.category === 'Video' && !idea?.videoMeta) {
      problems.push(`Ide Video ${idea?.id || ''} wajib punya videoMeta.`);
    }
    if (!Array.isArray(idea?.keywords) || idea.keywords.length < 10) {
      problems.push(`Ide ${idea?.id || ''} keywords kurang dari 10 (target 15).`);
    }
  }
  for (const [cat, n] of Object.entries(perCat)) {
    if (n < MIN_PER_CATEGORY) problems.push(`Kategori ${cat} hanya ${n} ide, minimal ${MIN_PER_CATEGORY}.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  if (!GEMINI_API_KEY) {
    console.error('[stockpulse] ERROR: GEMINI_API_KEY belum diset. Isi secrets.GEMINI_API_KEY di repo (GitHub Actions) atau export GEMINI_API_KEY untuk jalan lokal.');
    process.exit(1);
  }

  const today = jakartaNow();
  log(`Riset tren untuk ${today.fullLabel} (${today.iso})`);
  if (THEME) log(`Tema khusus: "${THEME}"`);

  // --- Riwayat & pembanding kemarin ---
  const history = await readHistory();
  const todayIdx = history.days.findIndex((d) => d.date === today.iso);
  const prevDay = todayIdx >= 0 ? history.days[todayIdx + 1] : history.days[0];
  const prevSummary = prevDay
    ? `Data kemarin (${prevDay.fullLabel}): ${prevDay.ideas.length} ide. Judul + demandScore kemarin:\n` +
      prevDay.ideas.map((i) => `- ${i.title} (${i.category}, demand ${i.demandScore}, growth ${i.growthPercent})`).join('\n')
    : 'Belum ada data kemarin (hari pertama).';

  // --- Sinyal mentah Google Trends ---
  const [trendsUS, trendsID] = await Promise.all([fetchTrendsRSS('US'), fetchTrendsRSS('ID')]);
  const trendsBlock = [
    'SINYAL MENTAH GOOGLE TRENDS HARI INI:',
    `US (15 teratas): ${trendsUS.length ? trendsUS.join(' | ') : '(tidak tersedia)'}`,
    `ID (15 teratas): ${trendsID.length ? trendsID.join(' | ') : '(tidak tersedia)'}`,
  ].join('\n');

  const themeClause = THEME
    ? `FOKUS KHUSUS (permintaan user): niche/tema "${THEME}". Prioritaskan peluang di tema ini, tapi tetap isi minimal 3 ide per kategori.`
    : 'Fokus umum: tren desain & komersial global + musiman terdekat.';

  const eventsBlock = `EVENT MUSIMAN TERDEKAT (dari hari ini):\n${upcomingEvents(today.iso)}`;

  // ================================================================
  // AGENT 01 — Peak-Hour Buyer Search Radar (Google Search Grounding)
  // ================================================================
  log('Agent 01 — Peak-Hour Buyer Search Radar...');
  const agent01 = await callGemini(
    `Kamu adalah Agent 01 — Peak-Hour Buyer Search Radar untuk StockPulse AI, radar tren aset mikrostock.

KONTEKS WAKTU: Hari ini ${today.fullLabel}. Jam sibuk buyer internasional adalah 21:00–01:00 WIB (malam AS & Eropa). Riset ini dijalankan pukul 22:00 WIB, tepat di puncak.
${themeClause}
${eventsBlock}
${trendsBlock}

TUGAS (gunakan Google Search untuk memverifikasi tren terbaru):
1. Analisis lonjakan pencarian visual buyer internasional (agensi, kreator, brand) pada jam sibuk ini.
2. Identifikasi 10–14 tema pencarian yang sedang naik (desain, komersial, musiman, teknologi, gaya hidup) dengan bukti pencarian nyata.
3. Untuk tiap tema, sebutkan: kata kunci pencarian buyer, kenapa naik sekarang, dan platform mikrostock yang paling relevan (Adobe Stock / Vecteezy / Dreamstime).
4. Soroti secara khusus peluang musiman dengan lead time 45–90 hari (Natal 2026, Tahun Baru 2027, Imlek 2027 = Tahun KAMBING API, Ramadan 2027).
5. Tulis dalam Bahasa Indonesia, ringkas tapi spesifik, dengan angka/estimasi bila ada. Jangan mengarang statistik resmi — bedakan fakta terverifikasi vs estimasi.

Output: laporan analisis Agent 01 (teks biasa).`,
    { useSearch: true },
  );
  log('Agent 01 selesai.');

  // ================================================================
  // AGENT 02 — 3-Platform Insight Auditor (Google Search Grounding)
  // ================================================================
  log('Agent 02 — 3-Platform Insight Auditor...');
  const agent02 = await callGemini(
    `Kamu adalah Agent 02 — 3-Platform Insight Auditor untuk StockPulse AI.

TERIMA OUTPUT AGENT 01 BERIKUT, lalu bedah supply vs demand gap per platform:
---
${agent01}
---

TUGAS (gunakan Google Search untuk memverifikasi kondisi tiap platform):
1. ADOBE STOCK — kebutuhan korporat / iklan komersial / AI-ready: tema apa yang paling dicari buyer korporat & agensi? Sebutkan 4–6 peluang dengan alasan demand & perkiraan kompetisi.
2. VECTEEZY — aset vektor, template grafis, sticker, ikon: tema vektor apa yang velocity unduhannya naik? Sebutkan 4–6 peluang (sticker pack, icon set, template, pattern).
3. DREAMSTIME — editorial, gaya hidup global, tema musiman: tema editorial/gaya hidup apa yang dicari media & buyer global? Sebutkan 4–6 peluang.
4. Untuk tiap peluang: skor demand awal (1–100), level kompetisi (Low/Medium/High), dan alasan insight 1–2 kalimat.
5. Tulis dalam Bahasa Indonesia. Bedakan fakta terverifikasi vs estimasi.

Output: laporan audit per platform (teks biasa).`,
    { useSearch: true },
  );
  log('Agent 02 selesai.');

  // ================================================================
  // AGENT 03 — Format & Visual Style Classifier
  // ================================================================
  log('Agent 03 — Format & Visual Style Classifier...');
  const agent03 = await callGemini(
    `Kamu adalah Agent 03 — Format & Visual Style Classifier untuk StockPulse AI.

TERIMA OUTPUT AGENT 02 BERIKUT, lalu petakan setiap peluang ke taksonomi resmi:
---
${agent02}
---

${TAXONOMY}

TUGAS:
1. Untuk setiap peluang dari Agent 02, tetapkan SATU kategori (Video/Foto/Ilustrasi/Vector), SATU formatType, dan SATU visualStyle — SEMUANYA harus dari taksonomi di atas, tanpa mengarang gaya baru.
2. Untuk Video, tentukan juga videoMeta: ratio (16:9 Horizontal / 9:16 Vertikal), camera (Diam / Static / Pan / Zoom in / Drone / Orbit), loop (Looping Mulus / Klip Biasa). Video vertikal 9:16 cocok untuk Reels/TikTok; 16:9 untuk komersial/web.
3. Pastikan distribusi seimbang: minimal 3 peluang untuk SETIAP kategori (Video, Foto, Ilustrasi, Vector), total minimal 12.
4. Tulis dalam Bahasa Indonesia, dalam bentuk daftar terstruktur: [Kategori] formatType — visualStyle — (videoMeta bila Video) — tema singkat.

Output: daftar klasifikasi (teks biasa).`,
  );
  log('Agent 03 selesai.');

  // ================================================================
  // AGENT 04 — Seasonal Lead-Time & Demand Scorer
  // ================================================================
  log('Agent 04 — Seasonal Lead-Time & Demand Scorer...');
  const agent04 = await callGemini(
    `Kamu adalah Agent 04 — Seasonal Lead-Time & Demand Scorer untuk StockPulse AI.

TERIMA OUTPUT AGENT 03 BERIKUT:
---
${agent03}
---

${eventsBlock}
DATA PEMBANDING KEMARIN:
${prevSummary}

TUGAS:
1. Untuk setiap peluang terklasifikasi, hitung: demandScore (1–100), competitionLevel (Low/Medium/High), dan seasonalWindow (jendela produksi optimal — event apa, tanggal event, dan batas akhir produksi ideal 45–90 hari sebelum event; bila bukan musiman, tulis "Evergreen — tanpa batas musiman").
2. Hitung growthPercent per peluang vs data kemarin (format "+34%" atau "-12%"): bandingkan dengan ide bertema paling mirip kemarin; bila tidak ada yang mirip, bandingkan dengan rata-rata demandScore kemarin.
3. Hitung dayOverDayGrowth keseluruhan hari ini (rata-rata pertumbuhan demand vs kemarin, format "+28.4%").
4. Beri alasan skor 1 kalimat per peluang (demand driver + supply gap).
5. Tulis dalam Bahasa Indonesia, daftar terstruktur.

Output: daftar skor (teks biasa).`,
  );
  log('Agent 04 selesai.');

  // ================================================================
  // AGENT 05 — Fable 5.2 JSON Synthesizer (JSON mode, tanpa search)
  // ================================================================
  log('Agent 05 — Fable 5.2 JSON Synthesizer...');
  const synthContext = [
    `Hari ini: ${today.fullLabel} (${today.iso}).`,
    `Agent 01:\n${agent01}`,
    `Agent 02:\n${agent02}`,
    `Agent 03:\n${agent03}`,
    `Agent 04:\n${agent04}`,
    `Data kemarin (untuk growthPercent):\n${prevSummary}`,
    eventsBlock,
    themeClause,
  ].join('\n\n');

  const synthPrompt = `Kamu adalah Agent 05 — Fable 5.2 JSON Synthesizer untuk StockPulse AI. Tugasmu: meracik SEMUA analisis agen sebelumnya menjadi SATU objek JSON yang 100% valid, tanpa teks lain di luar JSON.

KONTEKS:
${synthContext}

${TAXONOMY}

ATURAN WAJIB:
- Hasilkan MINIMAL 12 ide (minimal 3 untuk SETIAP kategori: Video, Foto, Ilustrasi, Vector). Lebih banyak (14–16) lebih baik bila analisis mendukung.
- Setiap ide WAJIB berisi field berikut (tanpa field tambahan di luar daftar ini, kecuali videoMeta khusus Video):
  id (format: "v-YYYYMMDD-01" untuk Video, "f-..." Foto, "i-..." Ilustrasi, "x-..." Vector; nomor urut per kategori),
  title (judul ide singkat, Bahasa Indonesia),
  category ("Video" | "Foto" | "Ilustrasi" | "Vector"),
  formatType (HARUS dari taksonomi),
  visualStyle (HARUS dari taksonomi),
  videoMeta (HANYA untuk Video: {"ratio": "16:9 Horizontal" atau "9:16 Vertikal", "camera": "Diam / Static" | "Pan" | "Zoom in" | "Drone" | "Orbit", "loop": "Looping Mulus" atau "Klip Biasa"}),
  platforms ({"adobeStock": {"score": 1-100, "reason": "alasan singkat"}, "vecteezy": {...}, "dreamstime": {...}} — skor platform terkuat = platform yang paling cocok),
  demandScore (1-100, konsisten dengan Agent 04),
  growthPercent (string, contoh "+38%" atau "-12%", konsisten dengan Agent 04),
  competitionLevel ("Low" | "Medium" | "High"),
  seasonalWindow (string, contoh "Imlek 2027 (6 Feb 2027) — produksi hingga 15 Des 2026" atau "Evergreen — tanpa batas musiman"),
  productionPrompt (prompt detail Bahasa Inggris, siap pakai untuk generator AI/desain, spesifik: subjek, komposisi, warna, pencahayaan, rasio, tanpa teks/logo bila relevan),
  seoTitle (judul komersial Bahasa Inggris, deskriptif, siap upload ke Adobe Stock),
  keywords (array TEPAT 15 kata kunci mikrostock Bahasa Inggris, lowercase, diurutkan dari yang paling dicari buyer),
  agentLogs (string ringkas 1-2 kalimat: temuan agen paling relevan untuk ide ini, contoh "Agent 01 menangkap ... Agent 02 mengonfirmasi ...").
- agentLogs (level hari): array TEPAT 5 string, masing-masing diawali "[Agent 01 • Peak Search Radar] ", "[Agent 02 • Insight Auditor] ", "[Agent 03 • Format Classifier] ", "[Agent 04 • Lead-Time Predictor] ", "[Agent 05 • Fable 5.2 Synthesizer] ", berisi ringkasan temuan hari ini.
- platformInsights: {"adobeStock": {"name": "Adobe Stock", "topSearch": "query buyer teratas dalam tanda kutip", "demandScore": 1-100, "supplyGap": "contoh: Tinggi (84%)", "insight": "1-2 kalimat"}, "vecteezy": {...}, "dreamstime": {...}}.
- dayOverDayGrowth (string, contoh "+28.4%"), totalQueriesAnalyzed (string angka dengan pemisah ribuan, contoh "48,920"), confidence (string persen, contoh "96.8%").
- Imlek 2027 adalah Tahun KAMBING API (Fire Goat) — JANGAN PERNAH memakai kata "horse"/"kuda" untuk Imlek 2027.
- Bahasa: title & agentLogs Bahasa Indonesia; productionPrompt, seoTitle, keywords Bahasa Inggris.
- Output HANYA JSON valid (responseMimeType application/json sudah aktif). Jangan tambahkan markdown fence atau penjelasan.

STRUKTUR JSON:
{"agentLogs": ["...x5"], "platformInsights": {"adobeStock": {...}, "vecteezy": {...}, "dreamstime": {...}}, "dayOverDayGrowth": "+28.4%", "totalQueriesAnalyzed": "48,920", "confidence": "96.8%", "ideas": [{...}]}`;

  let dayOutput = null;
  let lastProblems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = attempt === 1
      ? await callGemini(synthPrompt, { jsonMode: true })
      : await callGemini(
          `${synthPrompt}\n\nPERBAIKAN (percobaan sebelumnya bermasalah):\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nPerbaiki SEMUA masalah di atas dan keluarkan JSON yang sudah benar.`,
          { jsonMode: true },
        );
    try {
      const parsed = parseJsonLoose(raw);
      const problems = validateDayOutput(parsed);
      if (problems.length === 0) {
        dayOutput = parsed;
        break;
      }
      lastProblems = problems;
      log(`Validasi Agent 05 percobaan ${attempt} gagal: ${problems.slice(0, 5).join(' | ')}`);
    } catch (e) {
      lastProblems = [`JSON tidak bisa di-parse: ${e.message}`];
      log(`Parse JSON Agent 05 percobaan ${attempt} gagal: ${e.message}`);
    }
  }
  if (!dayOutput) {
    console.error('[stockpulse] ERROR: Agent 05 gagal menghasilkan JSON valid setelah 2 percobaan:', lastProblems.join(' | '));
    console.error('[stockpulse] history.json TIDAK diubah. Cek log di atas dan jalankan ulang workflow.');
    process.exit(1);
  }
  log(`Agent 05 selesai: ${dayOutput.ideas.length} ide valid.`);

  // --- Susun snapshot hari ini & simpan ---
  const daySnapshot = {
    date: today.iso,
    dateLabel: today.dateLabel,
    fullLabel: today.fullLabel,
    lastUpdated: today.lastUpdated,
    dayOverDayGrowth: dayOutput.dayOverDayGrowth,
    peakWindow: '21:00–01:00 WIB',
    totalQueriesAnalyzed: dayOutput.totalQueriesAnalyzed,
    confidence: dayOutput.confidence,
    platformInsights: dayOutput.platformInsights,
    agentLogs: dayOutput.agentLogs,
    ideas: dayOutput.ideas,
  };

  if (todayIdx >= 0) {
    history.days[todayIdx] = daySnapshot; // timpa data hari ini
    log('Data hari ini sudah ada — ditimpa dengan hasil riset terbaru.');
  } else {
    history.days.unshift(daySnapshot);
  }
  history.days = history.days.slice(0, MAX_DAYS);
  history.lastUpdated = today.lastUpdated;
  await writeHistory(history);

  log(`Selesai. ${dayOutput.ideas.length} ide disimpan ke public/data/history.json (${history.days.length} hari tersimpan).`);
}

main().catch((e) => {
  console.error('[stockpulse] FATAL:', e.message);
  process.exit(1);
});
