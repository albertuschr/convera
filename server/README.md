# Convera Server

Backend Convera: Fastify + TypeScript + PostgreSQL. Mencakup fondasi (database), autentikasi/sesi/role, dan penyimpanan kredensial Meta & webhook di sisi server.

## Menjalankan (development)

```powershell
cd server
copy .env.example .env          # lalu isi DATABASE_URL dan ENCRYPTION_KEY
npm install
npm run gen:key                 # tempel hasilnya ke ENCRYPTION_KEY di .env
docker compose up -d            # Postgres lokal (atau pakai Postgres sendiri)
npm run migrate
npm run dev                     # http://localhost:3000
```

Frontend: di `.env` root project isi `VITE_API_BASE_URL=http://localhost:3000` dan `VITE_BACKEND_ENABLED=true`, lalu `npm run dev`. Layar login/daftar akan muncul; akun pertama otomatis menjadi **Owner** workspace.

Tes (butuh Postgres; database tes harus bernama mengandung `test` karena semua tabelnya dihapus):

```powershell
$env:TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/convera_test"
npm test
```

Production: `npm run build`, `npm run migrate:prod`, `npm start`. Simpan `ENCRYPTION_KEY` di secret manager (kehilangan key = token tersimpan tak bisa dibuka), set `NODE_ENV=production`, `TRUST_PROXY=true` bila di belakang proxy, dan `REGISTRATION_OPEN=false` setelah akun owner dibuat.

## Endpoint

| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | `/api/v1/auth/register` · `login` · `logout` | publik | Sesi lewat cookie HttpOnly |
| GET | `/api/v1/auth/session` | login | Pulihkan sesi + daftar workspace & role |
| PATCH | `/api/v1/me/profile` | login | Nama/telepon; email & password wajib `currentPassword` |
| GET/POST | `/api/v1/workspaces` | login | Daftar / buat workspace |
| GET/POST/DELETE | `/api/v1/workspaces/:id/members` | owner | Kelola anggota & role (`owner`/`cs`/`agency`) |
| GET | `/api/v1/workspaces/:id/integrations` | anggota | Ringkasan tersamar (tanpa token/secret) |
| PUT/DELETE | `.../integrations/meta` | owner | Simpan/putus Dataset ID + access token (terenkripsi) |
| POST | `.../integrations/meta/test` | owner, cs | Tes koneksi Meta dari server |
| POST | `/api/v1/workspaces/:id/meta/events` | owner, cs | Kirim event ke Conversions API (idempoten per `event_id`) |
| PUT/DELETE | `.../integrations/webhook` | owner | URL, event, secret dibuat server (tampil sekali) |
| POST | `.../integrations/webhook/test` | owner, cs | Kirim webhook tes bertanda tangan HMAC |
| GET/POST/DELETE | `.../api-keys` | owner | API key (hanya hash tersimpan; key tampil sekali) |
| GET | `.../audit-logs` | owner | 100 aksi terakhir |

Role: **owner** penuh · **cs** kelola lead/event dan menjalankan tes · **agency** hanya lihat. Bukan anggota workspace → `404` (tidak membocorkan keberadaan).

## Keputusan keamanan

- **Sesi**: token acak 256-bit; di database hanya hash SHA-256. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` + prefix `__Host-` di production. Batas absolut 30 hari, idle 7 hari. Ganti password mencabut semua sesi lain.
- **Password**: scrypt (N=2^15) + salt; login memakai waktu proses yang sama baik email ada maupun tidak, dan pesan error yang sama.
- **Token Meta & secret webhook**: AES-256-GCM, dengan ID workspace sebagai AAD sehingga ciphertext tidak bisa dipindah antar baris. Tidak pernah dikembalikan ke browser (hanya versi tersamar), tidak masuk audit log. Token dikirim ke Graph lewat header `Authorization`, bukan query string.
- **CSRF**: semua request pengubah data wajib `Origin` yang ada di `CORS_ORIGINS`; hanya `application/json` yang diterima; cookie `SameSite=Lax`.
- **SSRF webhook**: hanya `https`, tanpa kredensial di URL, alamat hasil DNS diperiksa saat koneksi (menahan DNS rebinding), blok jaringan privat/loopback/link-local/metadata cloud, redirect tidak diikuti, respons tidak dibaca.
- **PII event**: `ph`/`em` wajib hash SHA-256; field tak dikenal ditolak.
- **Rate limit**: 300/menit global per IP, login 15/menit, register 5/jam, endpoint yang memicu panggilan keluar 30/menit.

## Belum dikerjakan (sengaja)

- Tabel `leads`, `events`, `rules` sudah ada di skema, tetapi endpoint CRUD-nya belum (dashboard masih memakai data sampel).
- Event yang gagal belum di-retry otomatis (butuh worker queue). Saat ini kirim ulang = kirim ulang manual dengan `event_id` yang sama.
- Autentikasi API key untuk endpoint ingest (key sudah bisa dibuat/dicabut, belum dipakai untuk autentikasi).
- Reset password / verifikasi email / undangan via email (butuh provider email), 2FA, dan penguncian akun setelah banyak percobaan gagal.
- Versi Graph API default `v19.0` (mengikuti kode frontend lama) → cek versi yang masih didukung Meta lalu ubah `META_GRAPH_VERSION`.
