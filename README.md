# StockPulse AI — Multi-Agent Microstock Trend Radar

Riset tren aset mikrostock harian yang **otomatis**, untuk **Adobe Stock, Vecteezy, dan Dreamstime** — tanpa server berbayar.

Setiap hari pukul **22:00 WIB** (jam sibuk buyer internasional), 5 agen AI berurutan menganalisis tren lewat **Gemini 2.5 Flash** (dengan **Google Search Grounding**), lalu hasilnya disimpan sebagai **database JSON statis** (`public/data/history.json`). Frontend-nya tinggal membaca JSON itu, jadi bisa di-deploy ke **Vercel** atau **GitHub Pages** tanpa backend sama sekali.

## Arsitektur 5 Agen (Sequential Chaining)

| Agen | Nama | Tugas | Search Grounding |
|------|------|-------|------------------|
| 01 | Peak-Hour Buyer Search Radar | Menangkap lonjakan pencarian buyer internasional di jam sibuk 21:00–01:00 WIB | ✅ |
| 02 | 3-Platform Insight Auditor | Membedah supply vs demand gap per platform (Adobe / Vecteezy / Dreamstime) | ✅ |
| 03 | Format & Visual Style Classifier | Memetakan peluang ke taksonomi resmi (Video / Foto / Ilustrasi / Vector) | — |
| 04 | Seasonal Lead-Time & Demand Scorer | Skor demand 1–100, kompetisi, jendela produksi 45–90 hari sebelum event | — |
| 05 | Fable 5.2 JSON Synthesizer | Meracik semua analisis jadi JSON valid (mode `application/json`) | — |

Sebelum agen berjalan, script mengambil **sinyal mentah Google Trends RSS** (US + ID, 15 topik teratas) sebagai konteks. Output tiap hari: **minimal 12 ide aset pemenang** (minimal 3 per kategori), lengkap dengan production prompt, SEO title, 15 keyword, skor platform, dan log ke-5 agen.

## Struktur Proyek

```
stockpulse-ai/
├── .github/
│   └── workflows/
│       └── daily-trend-radar.yml   # cron 15:00 UTC / 22:00 WIB + manual dispatch
├── scripts/
│   └── run-agents.mjs              # mesin riset 5 agen (Node.js, tanpa dependency)
├── public/
│   ├── index.html                  # SPA dashboard (Tailwind CDN, fetch data/history.json)
│   └── data/
│       └── history.json            # database JSON statis (max 30 hari)
├── package.json
└── README.md
```

## Setup (sekali saja)

### 1. API Key Gemini (wajib untuk workflow)

Workflow GitHub Actions butuh secret `GEMINI_API_KEY`:

1. Buka repo di GitHub → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `GEMINI_API_KEY`, Value: API key Gemini gratis dari [Google AI Studio](https://aistudio.google.com/apikey).
3. Save. Tanpa secret ini workflow gagal dengan pesan yang jelas (tidak merusak `history.json`).

> Key ini **hanya** dipakai di GitHub Actions (server-side). Tidak pernah masuk ke kode frontend atau repo.

### 2. Jalankan riset pertama

- **Otomatis:** workflow berjalan sendiri setiap hari 15:00 UTC / 22:00 WIB.
- **Manual dari GitHub:** tab **Actions → Daily Trend Radar → Run workflow** (opsional isi `theme` untuk niche khusus).
- **Manual dari frontend:** tombol **"Update Asset Hari Ini"** → isi GitHub Personal Access Token (PAT) + owner/repo → **Trigger Workflow & Pantau 5 Agen**. Frontend akan memantau status run-nya secara live dan me-refresh data begitu selesai.
  - PAT butuh scope `repo` (repo privat) atau `public_repo` + `workflow` (repo publik). PAT hanya tersimpan di browser kamu (localStorage), tidak dikirim ke mana pun selain api.github.com.
- **Lokal:** `export GEMINI_API_KEY=...` lalu `npm run update-trends`.

## Deploy Frontend

### Vercel (paling mudah)
1. Import repo ke Vercel.
2. Set **Root Directory** ke `public`.
3. Deploy. Setiap kali workflow meng-commit `history.json` baru, Vercel redeploy otomatis (atau aktifkan webhook GitHub).

### GitHub Pages
1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Tambahkan workflow deploy standar untuk situs statis (folder `public/`), atau serve lewat Vercel saja. Isi `public/data/history.json` tetap ter-commit di repo sehingga selalu bisa dibaca publik.

## Skema Data (`public/data/history.json`)

```json
{
  "lastUpdated": "2026-11-14T22:00:00+07:00",
  "days": [
    {
      "date": "2026-11-14",
      "dateLabel": "14 November 2026",
      "fullLabel": "Sabtu, 14 November 2026",
      "lastUpdated": "2026-11-14T22:00:00+07:00",
      "dayOverDayGrowth": "+28.4%",
      "peakWindow": "21:00–01:00 WIB",
      "totalQueriesAnalyzed": "48,920",
      "confidence": "96.8%",
      "platformInsights": {
        "adobeStock":  { "name": "Adobe Stock", "topSearch": "\"...\"", "demandScore": 97, "supplyGap": "Tinggi (84%)", "insight": "..." },
        "vecteezy":    { "..." },
        "dreamstime":  { "..." }
      },
      "agentLogs": ["[Agent 01 • Peak Search Radar] ...", "... (5 entri)"],
      "ideas": [
        {
          "id": "v-20261114-01",
          "title": "Kambing Api Imlek Melompat di Atas Awan Emas",
          "category": "Video",
          "formatType": "Musiman (Natal, Lebaran, Imlek)",
          "visualStyle": "Product Reveal Sinematik",
          "videoMeta": { "ratio": "9:16 Vertikal", "camera": "Orbit", "loop": "Looping Mulus" },
          "platforms": {
            "adobeStock": { "score": 98, "reason": "..." },
            "vecteezy":   { "score": 91, "reason": "..." },
            "dreamstime": { "score": 87, "reason": "..." }
          },
          "demandScore": 97,
          "growthPercent": "+38%",
          "competitionLevel": "Low",
          "seasonalWindow": "Imlek 2027 (6 Feb 2027) — produksi hingga 15 Des 2026",
          "productionPrompt": "Cinematic slow zoom-in shot of ...",
          "seoTitle": "Luxury Red and Gold Festive Podium ...",
          "keywords": ["lunar new year", "... (tepat 15)"],
          "agentLogs": "Agent 01 menangkap ... Agent 02 mengonfirmasi ..."
        }
      ]
    }
  ]
}
```

- `days[0]` selalu hari terbaru; bila riset hari yang sama dijalankan ulang, datanya ditimpa.
- Maksimal **30 hari** riwayat (file tetap ringan).
- `videoMeta` hanya ada pada ide Video.
- `agentLogs` level hari = array 5 string (satu per agen, untuk panel 5 Agen). `agentLogs` level ide = ringkasan 1–2 kalimat (untuk kartu tren).

## Fitur Frontend

- **Header + tanggal aktif** (format Indonesia) + badge **"Auto-Sync 22:00 WIB"**.
- **Tab riwayat harian** — lihat riset hari ini maupun arsip hari kemarin dari `history.json`.
- **Tombol "Update Asset Hari Ini"** — refetch data terbaru + modal GitHub PAT untuk trigger workflow + indikator progres 5 agen live.
- **Panel 5 Agen AI** + grafik distribusi jam sibuk buyer global (puncak 21:00–01:00 WIB).
- **Filter lengkap:** Platform (Adobe Stock / Vecteezy / Dreamstime), Kategori (Video / Foto / Ilustrasi / Vector), plus sub-filter dinamis — Gaya/Tipe Format, Gaya Visual, dan khusus Video: Rasio, Gerak Kamera, Tipe Looping.
- **Kartu tren** — skor demand, pertumbuhan vs kemarin, badge platform terkuat, kategori + gaya visual.
- **Modal "Lihat Prompt & Keyword"** — salin 1-klik untuk Production Prompt, SEO Title, dan 15 Priority Keywords; **Export CSV** dan **Export JSON** di header.

## Catatan Penting

- **Imlek 2027 = Tahun Kambing Api (Fire Goat), 6 Februari 2027.** Jangan pernah memakai kata "horse"/"kuda" untuk Imlek 2027 — baik di prompt agen, data, maupun keyword.
- **Shutterstock tidak termasuk** dalam radar ini (sesuai cakupan proyek: Adobe Stock, Vecteezy, Dreamstime). Perlu diingat juga: Shutterstock tidak menerima konten AI dari kontributor.
- **Kuota Gemini gratis** — 1x jalan per hari (5 panggilan berurutan) jauh di bawah batas free tier. Bila API mengembalikan 429/5xx, script retry otomatis (3x, backoff 5–10 detik).
- Bila Agent 05 gagal menghasilkan JSON valid setelah 2 percobaan, workflow gagal dengan jelas dan `history.json` **tidak** diubah — data kemarin tetap tampil.
- **Jangan pernah commit file `.env`** atau API key ke repo (sudah ada di `.gitignore`).

## Pengembangan Lokal

```bash
npm run update-trends   # butuh GEMINI_API_KEY di environment
# lalu serve folder public/:
npx serve public         # atau: python3 -m http.server --directory public 8903
```

## Lisensi

MIT.
