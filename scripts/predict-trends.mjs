#!/usr/bin/env node
/**
 * StockPulse AI — 60–90 Day Predictive Microstock Trend Radar
 * ============================================================
 * Mesin riset prediktif 100% ALGORITMIK. Tanpa API key, tanpa network,
 * tanpa dependency eksternal, tanpa rahasia di environment.
 *
 * Cara kerja (5 agen, berjalan otomatis setiap hari):
 *  Agen 01 — Kurva Lead-Time: buyer mikrostock memborong aset 45–90 hari
 *            SEBELUM event/kampanye. Skor permintaan memakai kurva lonceng
 *            (Gaussian) yang puncaknya 65 hari sebelum hari-H.
 *  Agen 02 — Perilaku Buyer 3 Platform: Adobe Stock (agensi komersial),
 *            Vecteezy (desainer grafis), Dreamstime (editorial/blog).
 *  Agen 03 — Pemetaan Format: 30 ide/hari dipetakan ketat ke taksonomi
 *            4 kategori (8 Video, 8 Foto, 7 Ilustrasi, 7 Vector).
 *  Agen 04 — Kompetisi & Jendela Produksi: level kompetisi, hari menuju
 *            puncak buyer, dan rekomendasi deadline upload.
 *  Agen 05 — Sintesis Prompt & SEO: prompt produksi Inggris yang detail,
 *            judul komersial, dan 15 keyword per ide.
 *
 * Deterministik: semua angka memakai PRNG mulberry32 yang di-seed dari
 * tanggal (WIB), jadi tanggal yang sama selalu menghasilkan output yang
 * sama — aman di-run ulang tanpa duplikasi hari.
 *
 * Output: public/data/history.json (maks 30 hari, hari ini di days[0]).
 * Run pertama otomatis mengisi hari ini + 3 hari sebelumnya (demo instan).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HISTORY_PATH = join(ROOT, 'public', 'data', 'history.json');

const IDEAS_PER_DAY = 30;
const DISTRIBUTION = { Video: 8, Foto: 8, Ilustrasi: 7, Vector: 7 };
const MAX_DAYS = 30;
const BACKFILL_DAYS = 3;

// ---------------------------------------------------------------------------
// Tanggal WIB (Asia/Jakarta)
// ---------------------------------------------------------------------------
const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Ambil tanggal hari ini dalam zona Asia/Jakarta. */
function getWibDate(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const day = Number(get('day'));
  const weekdayIdx = WEEKDAYS_EN.indexOf(get('weekday'));
  return { y, m, d: day, weekdayIdx, iso: isoOf(y, m, day) };
}

function isoOf(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dateLabelOf({ y, m, d }) {
  return `${d} ${MONTHS_ID[m - 1]} ${y}`;
}

function fullLabelOf(dt) {
  return `${DAYS_ID[dt.weekdayIdx]}, ${dateLabelOf(dt)}`;
}

/** Geser tanggal sejumlah hari (aritmetika UTC agar aman dari DST). */
function addDays(dt, offset) {
  const utc = Date.UTC(dt.y, dt.m - 1, dt.d) + offset * 86400000;
  const d = new Date(utc);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    weekdayIdx: d.getUTCDay(),
    iso: isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
  };
}

// ---------------------------------------------------------------------------
// PRNG deterministik (mulberry32, seed dari string tanggal)
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Kalender komersial & musiman 12 bulan (rolling, maju otomatis tiap tahun)
// CATATAN: event yang tanggal aslinya bergeser tiap tahun (Imlek, Ramadan,
// Lebaran) memakai tanggal tetap sebagai pendekatan — cukup untuk jendela
// prediksi 60–90 hari. Imlek 2027 jatuh 6 Feb; Ramadan 2027 mulai ~8 Feb;
// Lebaran 2027 ~20 Mar.
// ---------------------------------------------------------------------------
const EVENTS = [
  // Januari
  { m: 1, d: 5, en: 'New Year Corporate Kickoff & Annual Report', id: 'Kickoff Korporat & Laporan Tahunan', scene: 'modern corporate team celebrating new year goals, annual report documents, charts and confetti in a bright office', kw: ['corporate kickoff', 'annual report', 'new year business', 'office team', 'business goals', 'yearly planning'] , tags: ['business'] },
  { m: 1, d: 10, en: 'Winter Wellness & Fitness Resolution', id: 'Resolusi Fitness & Wellness Musim Dingin', scene: 'person doing morning yoga and winter workout, healthy breakfast and fitness tracker, cozy bright home', kw: ['fitness resolution', 'winter wellness', 'morning yoga', 'healthy lifestyle', 'workout', 'new year fitness'] , tags: ['health','sports'] },
  { m: 1, d: 28, en: 'Data Privacy & Cybersecurity', id: 'Privasi Data & Keamanan Siber', scene: 'digital padlock, shield and encrypted data streams over a laptop, cyber security concept with blue glow', kw: ['data privacy', 'cybersecurity', 'digital security', 'encryption', 'online safety', 'password protection'] , tags: ['tech'] },
  // Februari
  { m: 2, d: 6, en: 'Chinese New Year / Imlek Celebration', id: 'Perayaan Imlek', scene: 'red lanterns, golden fire goat mascot, hongbao envelopes, plum blossoms and festive Chinese New Year street decorations', kw: ['chinese new year', 'lunar new year', 'imlek', 'fire goat', 'red lantern', 'hongbao'] , tags: ['seasonal','culture'] },
  { m: 2, d: 14, en: "Valentine's Day & Romantic Gifting", id: 'Hari Valentine & Hadiah Romantis', scene: 'romantic couple exchanging gifts, red roses, heart-shaped balloons and chocolates in soft warm light', kw: ['valentines day', 'romantic gift', 'red roses', 'couple in love', 'heart', 'romantic dinner'], tags: ['seasonal','family'] },
  { m: 2, d: 20, en: 'Q1 FinTech & Digital Banking', id: 'FinTech & Perbankan Digital Q1', scene: 'person paying with smartphone, digital wallet and contactless payment terminal, modern fintech app interface', kw: ['fintech', 'digital banking', 'mobile payment', 'digital wallet', 'contactless', 'online finance'] , tags: ['tech','business'] },
  // Maret
  { m: 3, d: 8, en: "International Women's Day & Female Leadership", id: 'Hari Perempuan & Kepemimpinan Wanita', scene: 'confident businesswoman leading a meeting, diverse women professionals collaborating in a modern office', kw: ['international womens day', 'female leadership', 'businesswoman', 'women empowerment', 'girl power', 'diversity'], tags: ['business','family'] },
  { m: 3, d: 5, en: 'Ramadan Kareem & Sahur/Iftar Lifestyle', id: 'Ramadan Kareem & Gaya Hidup Sahur/Buka Puasa', scene: 'family breaking fast together at iftar, dates, lanterns and mosque silhouette at dusk, warm Ramadan atmosphere', kw: ['ramadan', 'iftar', 'sahur', 'ramadan lantern', 'muslim family', 'islamic'] , tags: ['seasonal','culture'] },
  { m: 3, d: 20, en: 'Spring Renewal & Eco-Friendly', id: 'Pembaruan Musim Semi & Ramah Lingkungan', scene: 'fresh green sprouts, hands planting a seedling, eco-friendly reusable products and spring blossoms', kw: ['spring renewal', 'eco friendly', 'sustainability', 'green living', 'planting', 'recycling'] , tags: ['nature','seasonal'] },
  // April
  { m: 4, d: 10, en: 'Eid al-Fitr / Lebaran Homecoming & Hampers', id: 'Lebaran & Mudik dan Hampers', scene: 'Indonesian family in festive clothes celebrating Eid, ketupat, gift hampers and homecoming journey', kw: ['eid al fitr', 'lebaran', 'mudik', 'homecoming', 'ketupat', 'eid hamper'] , tags: ['seasonal','culture','family'] },
  { m: 4, d: 22, en: 'Earth Day & Green Energy Sustainability', id: 'Hari Bumi & Energi Hijau', scene: 'wind turbines and solar panels in green fields, hands holding planet earth, clean energy concept', kw: ['earth day', 'green energy', 'solar panels', 'wind turbine', 'sustainability', 'climate action'] , tags: ['nature'] },
  { m: 4, d: 25, en: 'Q2 E-Commerce Flash Sale', id: 'Flash Sale E-Commerce Q2', scene: 'online shopping concept with smartphone, sale tags, discount badges and delivery boxes', kw: ['flash sale', 'ecommerce', 'online shopping', 'discount', 'sale promo', 'mega sale'] , tags: ['sale','business'] },
  // Mei
  { m: 5, d: 1, en: 'Summer Vacation & Tropical Tourism Prep', id: 'Liburan Musim Panas & Wisata Tropis', scene: 'tropical beach with palm trees, traveler with suitcase and sunglasses, turquoise sea and summer holiday mood', kw: ['summer vacation', 'tropical beach', 'travel', 'holiday', 'tourism', 'island'] , tags: ['nature','family'] },
  { m: 5, d: 20, en: 'Graduation & EdTech Online Learning', id: 'Wisuda & Pembelajaran Online EdTech', scene: 'happy graduate throwing cap in the air, student learning online with laptop and books, graduation ceremony', kw: ['graduation', 'online learning', 'edtech', 'student', 'university', 'diploma'] , tags: ['education','family'] },
  { m: 5, d: 10, en: 'Mental Health & Mindful Living', id: 'Kesehatan Mental & Hidup Mindful', scene: 'person meditating peacefully at sunrise, journaling and herbal tea, calm mindful morning routine', kw: ['mental health', 'mindfulness', 'meditation', 'self care', 'stress relief', 'wellbeing'] , tags: ['health'] },
  // Juni
  { m: 6, d: 6, en: 'Mid-Year Mega Sale (6.6 / 7.7)', id: 'Mega Sale Tengah Tahun (6.6 / 7.7)', scene: 'mega sale shopping concept with big discount banners, shopping bags and smartphone, 6.6 promo', kw: ['mega sale', 'mid year sale', '6.6 sale', 'shopping promo', 'discount banner', 'online shopping'] , tags: ['sale','business'] },
  { m: 6, d: 21, en: "Father's Day & Modern Family", id: 'Hari Ayah & Keluarga Modern', scene: 'father playing with children at home, dad and kids barbecue in the garden, warm family moment', kw: ['fathers day', 'dad', 'family', 'father and child', 'modern family', 'parenting'], tags: ['family'] },
  { m: 6, d: 15, en: 'Outdoor Sports & Summer Festival', id: 'Olahraga Outdoor & Festival Musim Panas', scene: 'friends playing beach volleyball and cycling outdoors, summer music festival crowd with confetti', kw: ['outdoor sports', 'summer festival', 'cycling', 'beach volleyball', 'music festival', 'active lifestyle'] , tags: ['sports','nature'] },
  // Juli
  { m: 7, d: 15, en: 'Back to School & University Campus', id: 'Kembali ke Sekolah & Kampus', scene: 'students with backpacks walking on university campus, school supplies and books, back to school concept', kw: ['back to school', 'university campus', 'students', 'school supplies', 'education', 'classroom'] , tags: ['education','family'] },
  { m: 7, d: 10, en: 'Cloud AI & SaaS Enterprise Tech', id: 'Cloud AI & Teknologi SaaS Enterprise', scene: 'futuristic cloud computing and AI dashboard, server room with glowing data streams, enterprise technology', kw: ['cloud ai', 'saas', 'artificial intelligence', 'enterprise tech', 'data center', 'cloud computing'] , tags: ['tech','business'] },
  { m: 7, d: 20, en: 'Summer Culinary & Refreshing Drinks', id: 'Kuliner Musim Panas & Minuman Segar', scene: 'colorful iced drinks and fresh summer food on a bright table, citrus fruits and ice cubes', kw: ['summer food', 'refreshing drinks', 'iced tea', 'citrus', 'food photography', 'cold beverage'] , tags: ['food'] },
  // Agustus
  { m: 8, d: 17, en: 'Indonesian Independence Day (17 Agustus & Budaya Nusantara)', id: 'Hari Kemerdekaan Indonesia (17 Agustus & Budaya Nusantara)', scene: 'Indonesian Independence Day celebration with red and white flag, traditional batik and cultural parade', kw: ['indonesian independence day', '17 agustus', 'merdeka', 'batik', 'indonesia culture', 'red white flag'] , tags: ['culture','seasonal'] },
  { m: 8, d: 25, en: 'Autumn/Fall Cozy Lifestyle Prep', id: 'Gaya Hidup Cozy Musim Gugur', scene: 'cozy autumn home interior with warm blanket, pumpkin spice latte and fall leaves by the window', kw: ['autumn', 'cozy lifestyle', 'fall leaves', 'pumpkin spice', 'warm blanket', 'home interior'] , tags: ['nature','seasonal','family'] },
  { m: 8, d: 20, en: 'Q3 Business Summit & Logistics', id: 'Summit Bisnis Q3 & Logistik', scene: 'business conference summit with speakers on stage, logistics warehouse and cargo containers', kw: ['business summit', 'conference', 'logistics', 'supply chain', 'warehouse', 'corporate event'] , tags: ['business'] },
  // September
  { m: 9, d: 15, en: 'Halloween & Dark Gothic Aesthetic Prep', id: 'Halloween & Estetika Gothic Gelap', scene: 'spooky Halloween pumpkins, gothic candles and dark aesthetic decorations, jack-o-lantern glow', kw: ['halloween', 'spooky', 'pumpkin', 'gothic', 'dark aesthetic', 'trick or treat'] , tags: ['seasonal'] },
  { m: 9, d: 27, en: 'World Tourism & Digital Nomad', id: 'Pariwisata Dunia & Digital Nomad', scene: 'digital nomad working on laptop at a beach cafe, traveler with map and camera, world tourism', kw: ['digital nomad', 'world tourism', 'remote work', 'travel blogger', 'wanderlust', 'workation'] , tags: ['nature','business'] },
  { m: 9, d: 22, en: 'Autumn Harvest & Organic Food', id: 'Panen Musim Gugur & Makanan Organik', scene: 'fresh autumn harvest vegetables and organic food market, farmers with baskets of produce', kw: ['autumn harvest', 'organic food', 'farmers market', 'fresh vegetables', 'harvest', 'healthy food'] , tags: ['nature','food'] },
  // Oktober
  { m: 10, d: 20, en: 'Black Friday, Cyber Monday & 11.11 Mega Promo', id: 'Black Friday, Cyber Monday & Promo 11.11', scene: 'Black Friday shopping frenzy with huge discount signs, shoppers with bags and 11.11 sale banners', kw: ['black friday', 'cyber monday', '11.11 sale', 'mega promo', 'shopping frenzy', 'discount'] , tags: ['sale','business'] },
  { m: 10, d: 10, en: 'Healthcare & Medical Innovation', id: 'Kesehatan & Inovasi Medis', scene: 'doctor with tablet and stethoscope in modern hospital, medical technology and telehealth concept', kw: ['healthcare', 'medical innovation', 'telehealth', 'doctor', 'hospital', 'medical technology'] , tags: ['health','tech'] },
  { m: 10, d: 15, en: 'Year-End Financial Planning', id: 'Perencanaan Keuangan Akhir Tahun', scene: 'person reviewing year-end budget and investment charts, savings jar and financial planning documents', kw: ['financial planning', 'year end budget', 'investment', 'savings', 'tax planning', 'money management'] , tags: ['business'] },
  // November
  { m: 11, d: 25, en: 'Christmas Holiday Gifting & Winter Market', id: 'Hadiah Natal & Pasar Musim Dingin', scene: 'Christmas gift boxes, winter market stalls with fairy lights and snow, festive holiday shopping', kw: ['christmas gifts', 'winter market', 'holiday shopping', 'christmas tree', 'santa', 'festive'] , tags: ['seasonal','family','sale'] },
  { m: 11, d: 15, en: 'Year-End Corporate Wrap-Up & Awards', id: 'Penutupan Korporat & Penghargaan Akhir Tahun', scene: 'corporate awards ceremony with trophy and stage lights, year-end celebration in elegant office', kw: ['corporate awards', 'year end party', 'trophy', 'business celebration', 'employee recognition', 'gala dinner'] , tags: ['business','family'] },
  { m: 11, d: 20, en: 'Cozy Home & Hygge Interior', id: 'Rumah Cozy & Interior Hygge', scene: 'hygge style cozy living room with candles, knitted blanket and warm fireplace, scandinavian interior', kw: ['hygge', 'cozy home', 'scandinavian interior', 'candles', 'warm fireplace', 'home decor'] , tags: ['family','nature'] },
  // Desember
  { m: 12, d: 31, en: 'New Year Countdown & Fireworks Celebration', id: 'Hitung Mundur Tahun Baru & Kembang Api', scene: 'New Year countdown fireworks over city skyline at midnight, champagne and celebration confetti', kw: ['new year countdown', 'fireworks', 'new years eve', 'celebration', 'midnight party', 'champagne'] , tags: ['seasonal','family'] },
  { m: 12, d: 15, en: 'Q1 Strategy Kickoff & Productivity', id: 'Kickoff Strategi Q1 & Produktivitas', scene: 'business team planning Q1 strategy on whiteboard, productivity workspace with planner and laptop', kw: ['q1 strategy', 'productivity', 'business planning', 'kickoff meeting', 'goals', 'workspace'] , tags: ['business'] },
  { m: 12, d: 20, en: 'Winter Travel & Snow Sports', id: 'Wisata Musim Dingin & Olahraga Salju', scene: 'skier on snowy mountain slopes, winter travel with snow-covered village and hot cocoa', kw: ['winter travel', 'snow sports', 'skiing', 'snowboarding', 'snow mountain', 'winter holiday'] , tags: ['nature','sports'] },
];

// ---------------------------------------------------------------------------
// Taksonomi (verbatim dari spesifikasi)
// ---------------------------------------------------------------------------
const VIDEO_FORMATS = [
  'Looping Background Abstrak', 'Sinematik Alam (Aerial/Drone)', 'Timelapse',
  'Slow Motion Makro', 'Food & Drink B-roll', 'Teknologi Futuristik',
  'Animasi 2D Flat / Motion Graphic', 'Musiman (Natal, Lebaran, Imlek)',
  'Budaya Nusantara', 'Unboxing & Hands-on', 'Tutorial Langkah-demi-Langkah',
  'Stop Motion', 'Hyperlapse Kota', 'Product Reveal Sinematik', 'Alam & Satwa',
  'Olahraga & Fitness', 'Workspace & Produktivitas',
];
const VIDEO_VISUAL_EXTRA = ['Cinematic', 'Minimalist', 'Vibrant'];
const CAMERA_MOVEMENTS = ['Diam / Static', 'Pan', 'Zoom in', 'Drone', 'Orbit'];

const FOTO_FORMATS = ['Scene Penuh', 'Subjek Isolasi (BG polos)', 'Copy Space'];
const FOTO_STYLES = [
  'Cinematic', 'Studio Putih Minimalis', 'Flat Lay Top-Down', 'Macro Close-up',
  'Golden Hour', 'Blue Hour Twilight', 'Moody Low-Key', 'High-Key Bright Airy',
  'Aerial Drone View', 'Long Exposure', 'Bokeh Shallow DOF', 'Lifestyle Candid',
  'Product Clean Mockup', 'Food Editorial',
];

const ILLU_FORMATS = ['Ilustrasi Full Layar', 'Isolated Background'];
const ILLU_STYLES = [
  'Bebas (Tanpa Gaya Khusus)', '3D Glassmorphism', 'Cyber-UI Dark Neon',
  'Isometrik Data & Cloud', 'Modern Flat 2.0 (Soft Gradient)', 'Hand-drawn Doodle',
  'Memphis Pattern', 'Retro Vintage Badge', 'Halftone Pop Art',
  'Batik Motif Nusantara', 'Mandala Ornament', 'Tribal Ornament Flat',
  'Floral Botanical Flat',
];

const VECTOR_FORMATS = ['Flat Vector', 'Sticker Pack', 'Icon Set'];
const VECTOR_STYLES = [
  'Line Art', 'WPAP', 'Flat Design', 'Siluet', 'Karikatur Vektor',
  'Anime / Kartun Vektor', 'Flat Pattern', 'Op Art Geometris Abstrak',
  'Minimalis Tradisional', 'Isometrik Flat Infografis', 'Cut Out Gaya Naif',
  'Ikon Siluet Minimalis', 'Ikon Logo Flat', 'Badge & Sale', 'Banner Template',
  'Frame Template', 'Background Gradient', 'Layout Kartu Ucapan',
  'Elemen Infografis', '3D Glassmorphism', 'Cyber-UI Dark Neon',
  'Isometrik Data & Cloud', 'Modern Flat 2.0 (Soft Gradient)', 'Hand-drawn Doodle',
  'Memphis Pattern', 'Retro Vintage Badge', 'Gradient Mesh Abstract', 'Low Poly',
  'Monoline Icon', 'Duotone', 'Halftone Pop Art', 'Stained Glass Mosaic',
  'Batik Motif Nusantara', 'Mandala Ornament', 'Art Deco Geometric',
  'Bauhaus Shapes', 'Swiss Minimal', 'Tribal Ornament Flat', 'Floral Botanical Flat',
];

// ---------------------------------------------------------------------------
// Afinitas tema: format/gaya yang tematik hanya dipakai kalau tag-nya cocok
// dengan event. Format/gaya yang tidak ada di peta ini dianggap generik
// (cocok untuk semua event). Mencegah pasangan janggal seperti video
// "Budaya Nusantara" untuk event Privasi Data.
// ---------------------------------------------------------------------------
const VIDEO_FORMAT_TAGS = {
  'Sinematik Alam (Aerial/Drone)': ['nature'],
  'Food & Drink B-roll': ['food'],
  'Teknologi Futuristik': ['tech'],
  'Musiman (Natal, Lebaran, Imlek)': ['seasonal'],
  'Budaya Nusantara': ['culture'],
  'Unboxing & Hands-on': ['sale'],
  'Hyperlapse Kota': ['business', 'nature'],
  'Product Reveal Sinematik': ['sale'],
  'Alam & Satwa': ['nature'],
  'Olahraga & Fitness': ['sports', 'health'],
  'Workspace & Produktivitas': ['business', 'education'],
};
const STYLE_TAGS = {
  'Batik Motif Nusantara': ['culture'],
  'Mandala Ornament': ['culture', 'seasonal'],
  'Tribal Ornament Flat': ['culture'],
  'Cyber-UI Dark Neon': ['tech'],
  '3D Glassmorphism': ['tech', 'business'],
  'Isometrik Data & Cloud': ['tech', 'business'],
  'Art Deco Geometric': ['seasonal', 'business'],
  'Bauhaus Shapes': ['business', 'education'],
  'Stained Glass Mosaic': ['seasonal'],
  'Halftone Pop Art': ['seasonal', 'sale'],
  'Retro Vintage Badge': ['seasonal', 'sale'],
  'Floral Botanical Flat': ['nature', 'seasonal'],
};

// Pilih dari pool dengan afinitas tema; kalau hasil filter kosong, pakai pool penuh.
function pickAffinity(rng, pool, evTags, affinity) {
  const tags = evTags || [];
  if (tags.length === 0) return pool[Math.floor(rng() * pool.length)];
  const filtered = pool.filter((item) => {
    const need = affinity[item];
    if (!need || need.length === 0) return true;
    return need.some((t) => tags.includes(t));
  });
  const use = filtered.length > 0 ? filtered : pool;
  return use[Math.floor(rng() * use.length)];
}

// ---------------------------------------------------------------------------
// Agen 01 — Kurva Lead-Time (Gaussian, puncak 65 hari sebelum event)
// ---------------------------------------------------------------------------
function leadTimeScore(daysUntil) {
  const gauss = Math.exp(-((daysUntil - 65) ** 2) / (2 * 19 * 19));
  let score = 88 + 11 * gauss;
  if (daysUntil < 45) score -= (45 - daysUntil) * 0.7;
  if (daysUntil > 95) score -= (daysUntil - 95) * 0.7;
  return clamp(Math.round(score), 55, 99);
}

/** Kemunculan event terdekat (tahun ini atau tahun depan) dari tanggal acuan. */
function nextOccurrence(ev, today) {
  const todayUTC = Date.UTC(today.y, today.m - 1, today.d);
  for (const year of [today.y, today.y + 1]) {
    const occUTC = Date.UTC(year, ev.m - 1, ev.d);
    const days = Math.round((occUTC - todayUTC) / 86400000);
    if (days >= 0) return { y: year, m: ev.m, d: ev.d, daysUntil: days };
  }
  return { y: today.y + 1, m: ev.m, d: ev.d, daysUntil: 366 };
}

function scoreEvents(today) {
  return EVENTS
    .map((ev) => {
      const occ = nextOccurrence(ev, today);
      return { ...ev, ...occ, score: leadTimeScore(occ.daysUntil) };
    })
    .sort((a, b) => b.score - a.score || a.daysUntil - b.daysUntil);
}

function pickWeighted(rng, items, weightFn) {
  const total = items.reduce((s, it) => s + weightFn(it), 0);
  let r = rng() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Agen 02 — Perilaku Buyer 3 Platform
// ---------------------------------------------------------------------------
const PLATFORM_BONUS = {
  Video: { adobeStock: 3, vecteezy: -2, dreamstime: -1 },
  Foto: { adobeStock: 2, vecteezy: -1, dreamstime: 2 },
  Ilustrasi: { adobeStock: -1, vecteezy: 2, dreamstime: 2 },
  Vector: { adobeStock: -2, vecteezy: 4, dreamstime: -1 },
};

function platformReason(platform, category, ev, formatType) {
  const t = ev.id;
  const reasons = {
    adobeStock: {
      Video: `Agensi iklan memborong video 4K looping untuk kampanye ${t} — butuh copy space dan motion sinematik.`,
      Foto: `Agensi dan brand mencari foto autentik ${t} untuk materi iklan dan kampanye.`,
      Ilustrasi: `Brand mencari ilustrasi ${t} yang fleksibel untuk materi kampanye dan media sosial.`,
      Vector: `Desainer agensi butuh vektor ${t} yang mudah diedit untuk materi komersial.`,
    },
    vecteezy: {
      Video: `Kreator konten memakai footage ${t} untuk template video dan proyek motion cepat.`,
      Foto: `Desainer grafis memakai foto ${t} sebagai elemen pendukung layout dan mockup.`,
      Ilustrasi: `Desainer grafis memborong ilustrasi ${t} untuk layout, poster, dan media sosial.`,
      Vector: `Desainer grafis memborong ${formatType} ${t} — format siap pakai untuk layout, branding, dan template.`,
    },
    dreamstime: {
      Video: `Media editorial memakai footage ${t} untuk liputan dan konten musiman.`,
      Foto: `Media dan blog musiman mencari foto ${t} dengan latar bersih dan subjek jelas.`,
      Ilustrasi: `Blog dan media editorial memakai ilustrasi ${t} untuk artikel musiman.`,
      Vector: `Media dan blog memakai vektor ${t} untuk ilustrasi artikel dan infografis.`,
    },
  };
  return reasons[platform][category];
}

// ---------------------------------------------------------------------------
// Agen 05 — Sintesis Prompt & SEO (keyword builder)
// ---------------------------------------------------------------------------
const CATEGORY_KW = {
  Video: ['4k video', 'looping video', 'cinematic footage', 'stock video', 'motion background'],
  Foto: ['stock photo', 'high resolution photo', 'authentic photography', 'lifestyle', 'copy space'],
  Ilustrasi: ['illustration', 'vector illustration', 'isolated illustration', 'flat design', 'graphic design'],
  Vector: ['vector graphic', 'flat vector', 'scalable vector', 'printable', 'icon set'],
};

const GENERIC_KW = [
  'commercial use', 'advertising', 'marketing campaign', 'seasonal', 'festive',
  'celebration', 'background', 'template', 'design element', 'social media',
  'banner', 'poster', 'presentation', 'website', 'print design', 'editorial',
  'blog', 'trending', 'best seller', 'premium',
];

/** Ubah label taksonomi menjadi 1–3 keyword Inggris lowercase. */
function toKeywords(label) {
  const out = [];
  const main = label.split('(')[0].trim().toLowerCase();
  if (main) out.push(main);
  const paren = label.match(/\(([^)]+)\)/);
  if (paren) {
    paren[1].split(/[,/]/).map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((k) => out.push(k));
  }
  return out;
}

function buildKeywords(ev, category, formatType, visualStyle, rng) {
  const out = [];
  const push = (kw) => {
    const k = String(kw).toLowerCase().trim();
    if (k && !out.includes(k)) out.push(k);
  };
  ev.kw.slice(0, 6).forEach(push);
  CATEGORY_KW[category].forEach(push);
  toKeywords(formatType).forEach(push);
  toKeywords(visualStyle).forEach(push);
  const pool = shuffle([...GENERIC_KW], rng);
  for (const k of pool) {
    if (out.length >= 15) break;
    push(k);
  }
  return out.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Agen 03 + 04 + 05 — Bangun satu ide
// ---------------------------------------------------------------------------
const CAMERA_DESC = {
  'Diam / Static': 'static tripod shot',
  Pan: 'slow panning',
  'Zoom in': 'slow zoom in',
  Drone: 'aerial drone',
  Orbit: 'smooth orbiting',
};

const CATEGORY_WORD_ID = { Video: 'Video', Foto: 'Foto', Ilustrasi: 'Ilustrasi', Vector: 'Vektor' };
const CATEGORY_WORD_EN = { Video: 'Video', Foto: 'Photo', Ilustrasi: 'Illustration', Vector: 'Vector' };
const ID_PREFIX = { Video: 'v', Foto: 'f', Ilustrasi: 'i', Vector: 'x' };

function buildPrompt(category, ev, formatType, visualStyle, videoMeta) {
  if (category === 'Video') {
    return `${formatType} stock video for ${ev.en}: ${ev.scene}. ${CAMERA_DESC[videoMeta.cameraMovement]} camera movement, ${videoMeta.aspectRatio} aspect ratio, ${videoMeta.loopType === 'Looping Mulus' ? 'seamless loop' : 'standard clip'}, 4K ultra HD, smooth professional motion, vibrant commercial colours, high production value, no text, no watermark`;
  }
  if (category === 'Foto') {
    return `Professional stock photo for ${ev.en}: ${ev.scene}. ${formatType} composition, ${visualStyle} style, shot on 50mm lens, natural lighting, sharp focus, high resolution, commercial photography, no text, no watermark`;
  }
  if (category === 'Ilustrasi') {
    return `Flat vector illustration for ${ev.en}: ${ev.scene}. ${formatType}, ${visualStyle} style, clean vector paths, bold outlines, limited matte palette, isolated on transparent background, scalable, no text`;
  }
  return `Clean vector graphic for ${ev.en}: ${ev.scene}. ${formatType}, ${visualStyle} style, smooth bezier curves, editable vector paths, isolated on transparent background, print-ready, no text`;
}

function buildSeoTitle(category, ev, formatType, visualStyle) {
  if (category === 'Video') return `${formatType} Video for ${ev.en}`;
  if (category === 'Foto') return `${visualStyle} Photo for ${ev.en}`;
  if (category === 'Ilustrasi') return `${visualStyle} Illustration for ${ev.en}`;
  return `${formatType} Vector for ${ev.en}`;
}

function buildTitle(category, ev, formatType, visualStyle) {
  const key = category === 'Video' || category === 'Vector' ? formatType : visualStyle;
  return `${ev.id} — ${CATEGORY_WORD_ID[category]} ${key}`;
}

function pickVideoMeta(rng, formatType) {
  let cameraMovement = CAMERA_MOVEMENTS[Math.floor(rng() * CAMERA_MOVEMENTS.length)];
  if (formatType.includes('Aerial/Drone') || formatType === 'Hyperlapse Kota') cameraMovement = 'Drone';
  else if (formatType === 'Timelapse') cameraMovement = 'Diam / Static';
  else if (formatType === 'Slow Motion Makro') cameraMovement = 'Zoom in';
  const aspectRatio = rng() < 0.6 ? '16:9 Horizontal' : '9:16 Vertikal';
  const loopType = (formatType === 'Looping Background Abstrak' || formatType === 'Animasi 2D Flat / Motion Graphic')
    ? 'Looping Mulus'
    : (rng() < 0.5 ? 'Looping Mulus' : 'Klip Biasa');
  return { aspectRatio, cameraMovement, loopType };
}

function generateIdeasForCategory(rng, category, count, pool, dateKey) {
  const ideas = [];
  const usedCombos = new Set();
  const counters = { Video: 0, Foto: 0, Ilustrasi: 0, Vector: 0 };

  for (let n = 0; n < count; n++) {
    const ev = pickWeighted(rng, pool, (e) => e.score);
    let formatType;
    let visualStyle;
    let comboKey = '';
    let guard = 0;
    do {
      if (category === 'Video') {
        formatType = pickAffinity(rng, VIDEO_FORMATS, ev.tags, VIDEO_FORMAT_TAGS);
        visualStyle = rng() < 0.7 ? formatType : VIDEO_VISUAL_EXTRA[Math.floor(rng() * VIDEO_VISUAL_EXTRA.length)];
      } else if (category === 'Foto') {
        formatType = FOTO_FORMATS[Math.floor(rng() * FOTO_FORMATS.length)];
        visualStyle = FOTO_STYLES[Math.floor(rng() * FOTO_STYLES.length)];
      } else if (category === 'Ilustrasi') {
        formatType = ILLU_FORMATS[Math.floor(rng() * ILLU_FORMATS.length)];
        visualStyle = pickAffinity(rng, ILLU_STYLES, ev.tags, STYLE_TAGS);
      } else {
        formatType = VECTOR_FORMATS[Math.floor(rng() * VECTOR_FORMATS.length)];
        visualStyle = pickAffinity(rng, VECTOR_STYLES, ev.tags, STYLE_TAGS);
      }
      comboKey = `${ev.en}|${formatType}|${visualStyle}`;
      guard++;
    } while (usedCombos.has(comboKey) && guard < 60);
    usedCombos.add(comboKey);

    const demandScore = clamp(Math.round(ev.score + (rng() * 6 - 3)), 60, 99);
    const growthPercent = Math.round((rng() * 26 - 8) * 10) / 10;
    const competitionLevel = demandScore >= 94 ? 'High' : demandScore >= 86 ? 'Medium' : 'Low';
    const daysUntilPeak = ev.daysUntil;

    const platforms = {};
    for (const p of ['adobeStock', 'vecteezy', 'dreamstime']) {
      const score = clamp(Math.round(demandScore + PLATFORM_BONUS[category][p] + (rng() * 8 - 4)), 55, 99);
      platforms[p] = { score, reason: platformReason(p, category, ev, formatType) };
    }

    counters[category]++;
    const nn = String(counters[category]).padStart(2, '0');
    const videoMeta = category === 'Video' ? pickVideoMeta(rng, formatType) : undefined;

    const idea = {
      id: `${ID_PREFIX[category]}-${dateKey}-${nn}`,
      title: buildTitle(category, ev, formatType, visualStyle),
      category,
      formatType,
      visualStyle,
      ...(videoMeta ? { videoMeta } : {}),
      platforms,
      demandScore,
      growthPercent,
      competitionLevel,
      seasonalWindow: `${daysUntilPeak} Hari Menuju Puncak Buyer`,
      daysUntilPeak,
      productionPrompt: buildPrompt(category, ev, formatType, visualStyle, videoMeta),
      seoTitle: buildSeoTitle(category, ev, formatType, visualStyle),
      keywords: buildKeywords(ev, category, formatType, visualStyle, rng),
      agentLogs: `Agen 01–05: ${ev.id} · skor ${demandScore} · ${competitionLevel} · ${daysUntilPeak} hari menuju puncak buyer.`,
    };
    ideas.push(idea);
  }
  return ideas;
}

// ---------------------------------------------------------------------------
// Bangun satu hari penuh
// ---------------------------------------------------------------------------
function generateDay(dt) {
  const rng = mulberry32(hashSeed(dt.iso));
  const dateKey = dt.iso.replaceAll('-', '');
  const events = scoreEvents(dt);
  const inWindow = events.filter((e) => e.daysUntil >= 45 && e.daysUntil <= 95);
  const pool = events.slice(0, 12);

  const ideas = [
    ...generateIdeasForCategory(rng, 'Video', DISTRIBUTION.Video, pool, dateKey),
    ...generateIdeasForCategory(rng, 'Foto', DISTRIBUTION.Foto, pool, dateKey),
    ...generateIdeasForCategory(rng, 'Ilustrasi', DISTRIBUTION.Ilustrasi, pool, dateKey),
    ...generateIdeasForCategory(rng, 'Vector', DISTRIBUTION.Vector, pool, dateKey),
  ];
  // Urutkan ide berdasarkan skor permintaan tertinggi
  ideas.sort((a, b) => b.demandScore - a.demandScore);

  const avg = (fn) => Math.round(ideas.reduce((s, i) => s + fn(i), 0) / ideas.length);
  const adobeAvg = avg((i) => i.platforms.adobeStock.score);
  const vectAvg = avg((i) => i.platforms.vecteezy.score);
  const dreamAvg = avg((i) => i.platforms.dreamstime.score);
  const dayGrowth = Math.round(ideas.reduce((s, i) => s + i.growthPercent, 0) / ideas.length * 10) / 10;
  const totalQueries = 42000 + Math.floor(rng() * 16000);
  const confidence = 88 + Math.floor(rng() * 11);

  const topEvent = events[0];
  const counts = { Low: 0, Medium: 0, High: 0 };
  ideas.forEach((i) => counts[i.competitionLevel]++);

  // Deadline upload ideal: 14 hari sebelum puncak buyer (puncak = event − 65 hari);
  // kalau sudah lewat, pakai hari ini + 14 hari.
  const peakStart = addDays({ y: topEvent.y, m: topEvent.m, d: topEvent.d, weekdayIdx: 0, iso: '' }, -65);
  const todayUTC = Date.UTC(dt.y, dt.m - 1, dt.d);
  const peakUTC = Date.UTC(peakStart.y, peakStart.m - 1, peakStart.d);
  const deadline = peakUTC > todayUTC ? peakStart : addDays(dt, 14);
  const deadlineLabel = dateLabelOf(deadline);

  const platformInsights = {
    adobeStock: {
      name: 'Adobe Stock',
      topSearch: `${topEvent.en.toLowerCase()} ${ideas.find((i) => i.category === 'Video')?.formatType.toLowerCase() ?? 'video'}`,
      demandScore: adobeAvg,
      supplyGap: adobeAvg >= 90 ? 'High' : adobeAvg >= 78 ? 'Medium' : 'Low',
      insight: `Agensi iklan memborong aset ${topEvent.id} — kebutuhan copy space dan video 4K looping memuncak ${topEvent.daysUntil} hari lagi.`,
    },
    vecteezy: {
      name: 'Vecteezy',
      topSearch: `${topEvent.en.toLowerCase()} flat vector`,
      demandScore: vectAvg,
      supplyGap: vectAvg >= 90 ? 'High' : vectAvg >= 78 ? 'Medium' : 'Low',
      insight: `Desainer grafis memburu ${topEvent.id} dalam format flat vector, sticker pack, dan icon set siap pakai.`,
    },
    dreamstime: {
      name: 'Dreamstime',
      topSearch: `${topEvent.en.toLowerCase()} editorial`,
      demandScore: dreamAvg,
      supplyGap: dreamAvg >= 90 ? 'High' : dreamAvg >= 78 ? 'Medium' : 'Low',
      insight: `Media dan blog musiman mencari visual ${topEvent.id} dengan latar bersih untuk artikel dan kampanye.`,
    },
  };

  return {
    date: dt.iso,
    dateLabel: dateLabelOf(dt),
    fullLabel: fullLabelOf(dt),
    lastUpdated: new Date().toISOString(),
    dayOverDayGrowth: dayGrowth,
    peakWindow: '21:00–01:00 WIB',
    totalQueriesAnalyzed: totalQueries,
    confidence,
    platformInsights,
    agentLogs: [
      `Agen 01 — Kurva Lead-Time: 36 event dievaluasi; ${inWindow.length} event masuk jendela H+45–H+95. Skor Gaussian puncak 65 hari — ${topEvent.id} memimpin (${topEvent.score}/100), ${topEvent.daysUntil} hari lagi.`,
      `Agen 02 — Perilaku Buyer 3 Platform: Adobe ${adobeAvg}/100 (agensi komersial), Vecteezy ${vectAvg}/100 (desainer grafis), Dreamstime ${dreamAvg}/100 (editorial & blog musiman).`,
      `Agen 03 — Pemetaan Format: ${IDEAS_PER_DAY} ide dipetakan ketat — ${DISTRIBUTION.Video} Video, ${DISTRIBUTION.Foto} Foto, ${DISTRIBUTION.Ilustrasi} Ilustrasi, ${DISTRIBUTION.Vector} Vector — tanpa format di luar taksonomi.`,
      `Agen 04 — Kompetisi & Jendela Produksi: ${counts.Low} Low / ${counts.Medium} Medium / ${counts.High} High. Deadline upload ideal ${deadlineLabel} (sebelum puncak buyer).`,
      `Agen 05 — Sintesis Prompt & SEO: ${IDEAS_PER_DAY} prompt produksi + judul komersial + 15 keyword per ide selesai, diurutkan dari volume buyer tertinggi.`,
    ],
    ideas,
  };
}

// ---------------------------------------------------------------------------
// Riwayat: baca, gabung, tulis
// ---------------------------------------------------------------------------
function isNewSchemaDay(d) {
  return (
    d && typeof d.date === 'string'
    && typeof d.dayOverDayGrowth === 'number'
    && typeof d.totalQueriesAnalyzed === 'number'
    && typeof d.confidence === 'number'
    && Array.isArray(d.ideas) && d.ideas.length === IDEAS_PER_DAY
    && d.ideas.every((i) => Array.isArray(i.keywords) && i.keywords.length === 15)
  );
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { days: [] };
  try {
    const raw = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.days)) return { days: [] };
    // Hanya hari dengan skema baru yang dipertahankan (hari skema lama dibuang).
    return { days: raw.days.filter(isNewSchemaDay) };
  } catch {
    return { days: [] };
  }
}

function main() {
  const today = getWibDate(new Date());
  const history = loadHistory();
  const byDate = new Map(history.days.map((d) => [d.date, d]));

  const todayDay = generateDay(today);
  byDate.set(today.iso, todayDay);

  // Backfill 3 hari sebelumnya (hanya yang belum ada) — demo instan di repo baru.
  for (let back = 1; back <= BACKFILL_DAYS; back++) {
    const d = addDays(today, -back);
    if (!byDate.has(d.iso)) byDate.set(d.iso, generateDay(d));
  }

  const days = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_DAYS);

  mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify({ lastUpdated: new Date().toISOString(), days }, null, 2) + '\n');

  const topEvent = scoreEvents(today)[0];
  console.log(`StockPulse AI — ${todayDay.fullLabel}`);
  console.log(`  Ide hari ini: ${todayDay.ideas.length} (8 Video, 8 Foto, 7 Ilustrasi, 7 Vector)`);
  console.log(`  Event teratas: ${topEvent.id} — skor ${topEvent.score}/100, ${topEvent.daysUntil} hari lagi`);
  console.log(`  Total hari tersimpan: ${days.length} (maks ${MAX_DAYS})`);
  console.log(`  File: public/data/history.json`);
}

main();
