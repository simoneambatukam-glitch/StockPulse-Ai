# StockPulse AI — 60–90 Day Predictive Microstock Trend Radar

Radar tren aset mikrostock **prediktif 2–3 bulan ke depan** untuk **Adobe Stock, Vecteezy, dan Dreamstime** — **100% tanpa API key, tanpa biaya, tanpa rahasia di GitHub Secrets.**

Setiap hari pukul **22:00 WIB** (jam sibuk buyer internasional), GitHub Actions menjalankan mesin prediktif Node.js yang menghitung aset apa yang sedang diborong buyer **60–90 hari sebelum musim/kampanye tiba**, lalu menyimpan hasilnya sebagai **database JSON statis** (`public/data/history.json`). Frontend tinggal membaca JSON itu, jadi situs bisa di-deploy ke **GitHub Pages** atau **Vercel** tanpa backend sama sekali.

> Versi 2.0 ini adalah penulisan ulang total dari versi lama yang memakai Gemini API (kuota gratisnya habis dan sering 404 karena model deprecated). Versi baru tidak memanggil AI atau API apa pun — semua skor dihitung algoritmik dari perilaku buyer, jadi riset harian **tidak akan pernah mati gara-gara kuota**.

## Cara kerja mesin prediktif

Mesin (`scripts/predict-trends.mjs`, Node.js murni, tanpa dependency) bekerja dalam 5 agen berurutan:

1. **Agen 01 — Kurva Lead-Time (Gaussian).** Buyer mikrostock memborong aset 45–90 hari *sebelum* event. Setiap event di kalender dinilai dengan kurva lonceng yang puncaknya **65 hari sebelum hari-H**: tema yang tepat berada di jendela 2–3 bulan ke depan mendapat skor permintaan tertinggi (88–99/100). Ada variasi dinamika harian (`growthPercent` vs kemarin) supaya tren terasa hidup setiap hari.
2. **Agen 02 — Perilaku Buyer 3 Platform.** Skor dan alasan spesifik per platform: **Adobe Stock** (kebutuhan agensi iklan komersial, copy space, video 4K looping, foto autentik), **Vecteezy** (kebutuhan desainer grafis: flat vector, sticker pack, icon set, banner template, badge & sale), **Dreamstime** (kebutuhan media editorial, blog musiman, isolated background, tema budaya lokal/global).
3. **Agen 03 — Pemetaan Format Ketat.** Setiap hari menghasilkan **30 ide aset pemenang: 8 Video, 8 Foto, 7 Ilustrasi, 7 Vector**, dipetakan ketat ke taksonomi (17 format Video, 3 format + 14 gaya Foto, 2 format + 13 gaya Ilustrasi, 3 format + 39 gaya Vector) — tanpa format di luar taksonomi.
4. **Agen 04 — Kompetisi & Jendela Produksi.** Menentukan tingkat kompetisi (`Low`/`Medium`/`High`), `daysUntilPeak` ("68 Hari Menuju Puncak Buyer"), dan rekomendasi deadline upload kontributor.
5. **Agen 05 — Sintesis Prompt & SEO.** Menyusun prompt produksi Inggris yang detail (parameter kamera untuk Video/Foto, *clean vector paths / isolated* untuk Vector/Ilustrasi), judul komersial Inggris, dan **tepat 15 keyword** mikrostock per ide, diurutkan dari volume buyer tertinggi.

**Kalender komersial 12 bulan** (36 event, 3 per bulan) mencakup seluruh siklus belanja global & Nusantara — Imlek, Valentine, Ramadan, Lebaran, 17 Agustus, Halloween, Black Friday/11.11, Natal, dan seterusnya — dan **berputar otomatis** ke tahun berikutnya saat melewati Desember. Event yang tanggal aslinya bergeser tiap tahun (Imlek, Ramadan, Lebaran) memakai tanggal tetap sebagai pendekatan (dicatat di komentar kode).

**Deterministik:** semua angka memakai PRNG `mulberry32` yang di-seed dari tanggal (WIB), jadi tanggal yang sama selalu menghasilkan output yang sama — aman di-run ulang tanpa duplikasi hari.

## Struktur proyek

```
stockpulse-ai/
├── .github/
│   └── workflows/
│       ├── daily-trend-radar.yml   # cron 22:00 WIB + manual dispatch
│       └── deploy-pages.yml        # deploy GitHub Pages (jangan diubah)
├── scripts/
│   └── predict-trends.mjs          # mesin prediktif (Node.js, tanpa dependency)
├── public/
│   ├── index.html                  # SPA frontend (baca data/history.json)
│   └── data/
│       └── history.json            # database statis, maks 30 hari
├── package.json
└── README.md
```

## Jalankan lokal

```bash
# Butuh Node.js >= 20, tanpa install dependency apa pun
node scripts/predict-trends.mjs

# Lalu sajikan folder public/ dengan server statis apa saja, contoh:
npx serve public
# atau:
python3 -m http.server --directory public 8000
```

Buka `http://localhost:8000`. Run pertama mengisi `history.json` dengan **hari ini + 3 hari sebelumnya** (demo instan); run harian berikutnya hanya menambah hari baru (maks 30 hari).

## Deploy ke GitHub Pages

1. Buat repo publik di GitHub (misal `StockPulse-Ai`), branch `main`.
2. Push semua file repo ini ke `main`.
3. Paste kedua file workflow (`.github/workflows/daily-trend-radar.yml` dan `.github/workflows/deploy-pages.yml`) ke repo — Muse **tidak bisa** push file workflow, jadi file ini harus di-paste manual.
4. Di repo: **Settings → Pages → Source: GitHub Actions**.
5. Situs live di `https://<username>.github.io/StockPulse-Ai/`.

## Trigger manual

- **Dari GitHub:** tab **Actions → Daily Trend Radar → Run workflow**. Selalu trigger run **baru** — jangan pakai "Re-run jobs" pada run lama, karena itu memakai commit lama.
- **Dari frontend:** tombol **"Update Asset Hari Ini"** me-refresh data terbaru (dengan animasi 5 agen). Kolom PAT opsional memicu `workflow_dispatch` via API GitHub — PAT disimpan hanya di browser kamu (localStorage), butuh scope `repo` + `workflow`.

## Tidak butuh secret apa pun

Tidak ada API key, tidak ada token, tidak ada GitHub Secrets. Satu-satunya yang opsional adalah PAT pribadi kamu untuk tombol trigger manual di frontend — itu pun hanya tersimpan di browser kamu sendiri.
