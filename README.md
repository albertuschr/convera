# Convera - React (Vite)

Convera adalah dashboard operasional untuk bisnis yang menjalankan iklan
Click-to-WhatsApp. Aplikasi ini membantu mencatat lead dari iklan, menandai
konversi, mengirim event ke Meta Conversions API, memantau performa kampanye,
dan menghubungkan webhook atau integrasi lain.

## Menjalankan

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # hasil di dist/
```

## Fitur yang sudah aktif

- Form onboarding dan koneksi Meta/WhatsApp tersimpan di browser.
- Validasi Dataset ID, access token, URL webhook, penerima laporan, dan
  password.
- Tes koneksi Meta dan pengiriman event Conversions API. Mode live dapat
  diaktifkan dengan `VITE_LIVE_API=true`.
- Payload event memakai `event_id`, batas atribusi tujuh hari, nilai transaksi,
  dan hashing SHA-256 untuk nomor telepon/email.
- Leads, konversi, log event, aturan otomatis, notifikasi, filter, bulk action,
  tema, workspace, dan pengaturan tersimpan di `localStorage`.
- Ekspor CSV/JSON dan dialog cetak untuk laporan/invoice.
- Tes webhook HTTPS dengan tanda tangan HMAC-SHA256.
- API key dibuat secara acak dan dapat dicabut.
- **Profil saya** sekarang membuka panel nyata: nama, email, nomor telepon,
  validasi perubahan password, dan perubahan profil dipersistenkan ke
  `localStorage`.

## Fitur yang masih simulasi atau memerlukan backend

Beberapa fitur tidak dapat menjadi layanan produksi hanya dari aplikasi React
yang berjalan di browser:

- **Login, sesi, dan autentikasi password**: belum ada server pengguna; data
  profil/password hanya berlaku di browser ini.
- **Undangan tim dan pengiriman email/WhatsApp terjadwal**: jadwal hanya
  disimpan sebagai konfigurasi, belum ada worker atau provider pengirim.
- **Pembayaran dan upgrade paket**: checkout menampilkan alur UI, belum
  terhubung payment gateway.
- **Penerimaan chat WhatsApp dan ingest lead otomatis**: perlu webhook backend
  yang menerima callback Meta/WhatsApp.
- **Aturan otomatis**: konfigurasi dan simulasi pencatatan tersedia, tetapi
  eksekusi produksi perlu worker/backend.
- **Mode default Meta dan webhook**: default aman adalah demo/validasi lokal.
  Pengiriman sungguhan membutuhkan kredensial valid, CORS/backend proxy, dan
  konfigurasi Meta yang benar.

Jangan menaruh access token Meta produksi di frontend. Untuk deployment nyata,
pindahkan pengiriman Meta, webhook, autentikasi, scheduler, dan pembayaran ke
backend.

## Persiapan integrasi backend

Frontend sudah dipisahkan menjadi beberapa lapisan agar backend dapat
ditambahkan tanpa mengubah komponen UI:

- `src/Logic.js` menangani state dan event UI.
- `src/services/` berisi adapter integrasi dan utilitas. `api.js` adalah HTTP
  client terpusat dengan timeout, JSON parsing, credentials cookie, dan error
  yang konsisten.
- `backend.js` berisi endpoint contract frontend. Saat ini profile memakai
  `PATCH /api/v1/me/profile`; endpoint lain sudah didaftarkan sebagai kontrak
  awal untuk session, workspace, leads, events, dan reports.
- `storage.js` tetap menjadi fallback demo sampai backend diaktifkan.
- `config.js` membaca konfigurasi environment sehingga URL dan mode tidak
  tersebar di komponen.

Salin `.env.example` ke `.env` saat backend sudah tersedia:

```env
VITE_API_BASE_URL=http://localhost:3000
VITE_BACKEND_ENABLED=true
VITE_REQUEST_TIMEOUT_MS=10000
```

Backend yang disarankan:

1. Gunakan cookie HttpOnly untuk session, bukan token rahasia di localStorage.
2. Kembalikan JSON dengan bentuk `{ data, message? }` atau sesuaikan adapter di
   `backend.js`.
3. Kembalikan status HTTP yang benar (`401`, `403`, `422`, `500`) agar UI dapat
   menampilkan error dengan tepat.
4. Validasi ulang semua data di server; validasi frontend hanya untuk UX.
5. Simpan access token Meta dan secret webhook hanya di server.
6. Tambahkan endpoint webhook Meta untuk menerima lead dan status WhatsApp,
   serta worker untuk scheduler dan aturan otomatis.

Kontrak endpoint awal:

| Method | Endpoint | Tujuan |
|---|---|---|
| GET | `/api/v1/auth/session` | Memulihkan sesi pengguna |
| PATCH | `/api/v1/me/profile` | Menyimpan profil pengguna |
| GET/POST | `/api/v1/workspaces` | Daftar dan pembuatan workspace |
| GET/POST | `/api/v1/leads` | Lead dari WhatsApp/iklan |
| GET/POST | `/api/v1/events` | Event konversi dan status pengiriman |
| GET/POST | `/api/v1/reports` | Laporan dan jadwal pengiriman |

## Daftar pekerjaan yang belum dilanjutkan

- [ ] Backend authentication, session, role Owner/CS/Agency, dan permission.
- [ ] Database untuk workspace, user, leads, events, rules, API keys, dan audit
  log.
- [ ] Sinkronisasi data dashboard dari API; saat ini banyak metrik masih data
  contoh yang berada di `Logic.js`.
- [ ] Webhook Meta/WhatsApp untuk ingest chat, lead, delivery, dan status
  koneksi.
- [ ] Server-side Meta Conversions API dan rotasi/penyimpanan access token.
- [ ] Worker queue untuk aturan otomatis, retry event, retensi data, dan
  laporan terjadwal.
- [ ] Email/WhatsApp provider untuk undangan tim, notifikasi, dan laporan.
- [ ] Payment gateway, subscription, invoice, dan pembatasan fitur per paket.
- [ ] Google Sheets, n8n, form order, dan integrasi pihak ketiga yang aman.
- [ ] Testing end-to-end, monitoring, rate limiting, CSRF/CORS policy, dan
  audit keamanan sebelum production.

## Struktur

- `src/Template.jsx` - markup desain hasil konversi.
- `src/Logic.js` - state, handler, dan data dashboard.
- `src/App.jsx` - host React dan pemulihan state.
- `src/ProfilePanel.jsx` - form profil akun yang tersimpan.
- `src/services/config.js` - konfigurasi environment terpusat.
- `src/services/api.js` - HTTP client backend terpusat.
- `src/services/backend.js` - endpoint contract/adapter backend.
- `src/services/` - storage, validasi, kriptografi, Meta CAPI, webhook, dan
  exporter.
- `public/fonts/` - font lokal tanpa CDN.

## Opsi tampilan

Ubah props di `src/main.jsx`: `startScreen` (`app`/`onboarding`), `accent`
(`orange`/`indigo`), `statusStyle` (`brand`/`semantic`), dan `dark`
(`true`/`false`).

## Mode live Meta

Salin `.env.example` menjadi `.env` lalu set:

```env
VITE_LIVE_API=true
```

Tanpa flag tersebut, tes koneksi dan pengiriman event memakai mode demo setelah
validasi lokal. `VITE_BACKEND_ENABLED` tetap `false` sampai backend siap.
`window.convera.reset()` dapat dipanggil dari console untuk menghapus data lokal
dan memuat ulang aplikasi.
