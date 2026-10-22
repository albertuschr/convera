# Convera – React (Vite)

Hasil konversi otomatis dari artifact desain "Convera" (dashboard + onboarding) ke proyek React.

## Menjalankan
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # hasil di dist/
```

## Struktur
- `src/Template.jsx` – seluruh markup desain asli (dikonversi dari template `sc-if`/`sc-for`/`{{ }}` menjadi JSX)
- `src/Logic.js` – logika asli desain: state, handler, data, tema terang/gelap (apa adanya)
- `src/dc.jsx` – pengganti runtime kecil (base class `DCLogic`, helper `I`, `S`, `L`)
- `src/App.jsx` – komponen host yang menghubungkan logika dengan template
- `src/styles.css` – font-face + aturan hover/focus dari desain
- `public/fonts/` – font JetBrains Mono & Plus Jakarta Sans (di-embed, tanpa CDN)

## Opsi tampilan
Ubah props di `src/main.jsx`: `startScreen` (`app`/`onboarding`), `accent` (`orange`/`indigo`),
`statusStyle` (`brand`/`semantic`), `dark` (`true`/`false`).

## Catatan
Elemen `<image-slot>` (placeholder screenshot di panduan token) adalah web component dari runtime
desain dan tidak disertakan; ia tampil kosong.

## Logika yang ditambahkan (`src/services/`)
Semua tombol dari desain asli tetap dipakai; handler yang tadinya hanya menampilkan toast kini menjalankan logika nyata.

| Fitur | Logika |
|---|---|
| Semua data (form, lead, event, aturan, API key, tema, halaman terakhir) | Disimpan otomatis di `localStorage` dan dipulihkan saat dibuka lagi (`storage.js`). Reset: `window.convera.reset()` di console |
| Tes koneksi Meta (onboarding, Koneksi, ganti token) | Validasi Dataset ID (15–16 digit) dan token; mode live memanggil Graph API (`capi.js`) |
| Event percobaan & Tandai konversi | Membangun payload Conversions API: nomor HP dinormalisasi lalu di-hash SHA-256, `event_id` unik, cek batas 7 hari dan `value` wajib; status Mengirim → Terkirim/Gagal tercatat di tabel Konversi |
| Webhook keluar | URL wajib https, secret `whsec_…` dibuat acak, tes mengirim POST bertanda tangan HMAC-SHA256 (`X-Convera-Signature`) dan melaporkan hasil sebenarnya (`webhook.js`) |
| API key | Dibuat dengan `crypto.getRandomValues`, hanya ditampilkan sekali, bisa dicabut |
| Laporan | PDF lewat dialog cetak browser (Simpan sebagai PDF), CSV, jadwal kirim divalidasi (email/nomor HP sesuai kanal) |
| Pengaturan | Validasi nama bisnis, ganti password (min. 8 karakter, huruf+angka, harus cocok), retensi data, ekspor semua data ke JSON |
| Privasi | Hapus kontak berdasarkan nomor (lead dan event terkait ikut hilang), permintaan hapus workspace tercatat |
| Aturan otomatis, filter/pencarian Leads, bulk action, ekspor CSV, notifikasi, tim, checkout | Logika bawaan desain, kini ikut tersimpan |

## Mode demo vs live
Default adalah **mode demo**: format Dataset ID/token divalidasi dan event "terkirim" tanpa menghubungi Meta.
Salin `.env.example` menjadi `.env` dan set `VITE_LIVE_API=true` untuk memanggil Graph API sungguhan.
Untuk produksi, panggilan ke Meta sebaiknya lewat backend agar access token tidak berada di browser.

## Batasan
Tanpa backend, hal berikut hanya berlaku di browser ini: login/password sebenarnya, undangan tim lewat email,
pembayaran, pengiriman laporan terjadwal, dan penerimaan chat WhatsApp. Struktur `services/` disiapkan agar
mudah diganti dengan pemanggilan API server.
