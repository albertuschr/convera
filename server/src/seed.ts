// Isi workspace dengan data demo 30 hari (lead, event, spend iklan) untuk presentasi.
// Pakai: npm run seed -- <email-owner> [--reset]
// --reset menghapus lead, event, dan data iklan workspace itu saja sebelum mengisi ulang.
import { createPool } from './db.js';
import { hashPhone } from './lib/events.js';

const ADS: [campaign: string, adSet: string, ad: string, headline: string, body: string, dailySpend: number, weight: number][] = [
  ['Promo Oktober', 'Jaksel 18–34', 'Promo Kopi Susu 2.0', 'Kopi Susu 2.0 — beli 2 gratis 1', 'Khusus pesan via WhatsApp sampai akhir bulan. Klik & chat sekarang!', 62000, 9],
  ['Promo Oktober', 'Jaksel 18–34', 'Kopi Susu Foto Produk', 'Kopi susu segar tiap pagi', 'Pesan lewat WhatsApp, diantar ke kantor.', 17000, 2],
  ['Promo Oktober', 'Retarget 30 hari', 'Diskon Ojol 20%', 'Hemat 20% pesan langsung', 'Lebih murah dari aplikasi ojol. Chat admin untuk kode diskon.', 25000, 4],
  ['Hampers Korporat', 'Pekerja kantor', 'Paket Bundling Hampers', 'Hampers kopi untuk kantor', 'Mulai Rp 350.000/box, gratis kartu ucapan & ongkir Jabodetabek.', 47000, 6],
  ['Menu Baru', 'Interest kopi', 'Carousel Menu Baru', '5 menu baru musim hujan', 'Aren Latte, Hojicha, sampai Pandan Coffee. Tanya stok via chat.', 33000, 4],
  ['Awareness', 'Ulang tahun bulan ini', 'Kopi Gratis Ulang Tahun', 'Ulang tahun? Kopi gratis!', 'Tunjukkan KTP di outlet, berlaku 7 hari.', 15000, 2],
];
const FIRST = ['Andi', 'Siti', 'Budi', 'Dewi', 'Rizky', 'Nur', 'Fajar', 'Putri', 'Hendra', 'Maya', 'Agus', 'Lina', 'Yusuf', 'Rina', 'Bayu', 'Wulan', 'Teguh', 'Sari', 'Dimas', 'Ayu', 'Eko', 'Indah', 'Galih', 'Tika'];
const LAST = ['Pratama', 'Rahmawati', 'Santoso', 'Lestari', 'Hidayat', 'Aini', 'Nugroho', 'Wijaya', 'Sari', 'Salim', 'Marlina', 'Maulana', 'Kartika', 'Saputra', 'Prasetyo', 'Wulandari'];
const MSG = ['Kak, promonya masih ada?', 'Mau pesan buat kantor, bisa invoice PT?', 'Ada menu non-kopi?', 'Bisa kirim ke Tebet hari ini?', 'Kode diskonnya apa kak?', 'Isi hampers yang 350rb apa aja?', 'Buka jam berapa ya?', 'Saya mau 2 Aren Latte ya', 'Jadi pesan 1 liter ya kak', 'Sudah transfer ya kak', 'Halo kak, mau tanya'];
const PRICE = [64000, 89000, 120000, 215000, 350000, 450000, 700000, 1250000, 3500000];

// PRNG deterministik agar hasil seed sama setiap kali dijalankan.
let seed = 20261030;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const DAY = 86_400_000;

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed demo tidak boleh dijalankan di production');
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith('--'))?.toLowerCase();
  if (!email) throw new Error('Pakai: npm run seed -- <email-owner> [--reset]');
  const db = createPool(process.env.DATABASE_URL!);
  try {
    const ws = (await db.query<{ workspace_id: string; user_id: string; name: string }>(
      `SELECT m.workspace_id, m.user_id, w.name FROM users u JOIN memberships m ON m.user_id = u.id JOIN workspaces w ON w.id = m.workspace_id
        WHERE lower(u.email) = $1 AND m.role = 'owner' AND w.deleted_at IS NULL ORDER BY m.created_at LIMIT 1`, [email])).rows[0];
    if (!ws) throw new Error(`Tidak ada workspace milik ${email} (role owner)`);
    const existing = Number((await db.query('SELECT count(*) FROM leads WHERE workspace_id = $1', [ws.workspace_id])).rows[0].count);
    if (existing && !args.includes('--reset')) throw new Error(`Workspace "${ws.name}" sudah berisi ${existing} lead. Tambahkan --reset untuk menghapus dan mengisi ulang.`);

    const c = await db.connect();
    try {
      await c.query('BEGIN');
      if (existing) {
        await c.query('DELETE FROM events WHERE workspace_id = $1', [ws.workspace_id]);
        await c.query('DELETE FROM leads WHERE workspace_id = $1', [ws.workspace_id]);
        await c.query('DELETE FROM ad_insights WHERE workspace_id = $1', [ws.workspace_id]);
      }
      const now = Date.now();
      const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) + 'T00:00:00+07:00').getTime();
      let leads = 0, events = 0, n = 0;
      for (let d = 29; d >= 0; d--) {
        const dayStart = today - d * DAY;
        const date = new Date(dayStart + 7 * 3600_000).toISOString().slice(0, 10);
        for (const [campaign, adSet, ad, , , dailySpend, weight] of ADS) {
          const spend = Math.round(dailySpend * (0.8 + rnd() * 0.4) / 100) * 100;
          await c.query('INSERT INTO ad_insights (workspace_id, date, campaign, ad_set, ad, spend, clicks) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [ws.workspace_id, date, campaign, adSet, ad, spend, Math.round(spend / 950 * (0.8 + rnd() * 0.4) + weight)]);
        }
        // 3–7 chat per hari; ±10% organik (tanpa iklan).
        const perDay = 3 + Math.floor(rnd() * 5);
        for (let k = 0; k < perDay; k++) {
          const clicked = dayStart + (8 + rnd() * 13) * 3600_000;
          if (clicked > now) continue;
          const organic = rnd() < 0.1;
          const total = ADS.reduce((a, x) => a + x[6], 0);
          let r = rnd() * total, A = ADS[0]!;
          for (const x of ADS) { r -= x[6]; if (r <= 0) { A = x; break; } }
          const roll = rnd();
          const status = roll < 0.22 ? 'new' : roll < 0.48 ? 'lead' : roll < 0.68 ? 'checkout' : roll < 0.9 ? 'purchase' : 'lost';
          const value = status === 'purchase' || status === 'checkout' ? (A[2] === 'Paket Bundling Hampers' ? pick([350000, 700000, 3500000]) : pick(PRICE.slice(0, 6))) : 0;
          const phone = '62812' + String(10000000 + n++ * 7919 % 89999999).padStart(8, '0');
          const clid = organic ? null : 'AR' + Math.floor(rnd() * 1e16).toString(36) + Math.floor(rnd() * 1e16).toString(36);
          const lead = (await c.query<{ id: string }>(
            `INSERT INTO leads (workspace_id, name, phone, first_message, ctwa_clid, campaign, ad_set, ad, ad_headline, ad_body, status, value, clicked_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13 / 1000.0),to_timestamp($14 / 1000.0),to_timestamp($14 / 1000.0)) RETURNING id`,
            [ws.workspace_id, pick(FIRST) + ' ' + pick(LAST), phone, pick(MSG), clid, organic ? null : A[0], organic ? null : A[1], organic ? null : A[2],
              organic ? null : A[3], organic ? null : A[4], status, value, organic ? null : clicked, clicked + 60_000])).rows[0]!;
          leads++;
          if (organic) continue;
          // Event mengikuti perjalanan lead: LeadSubmitted → InitiateCheckout → Purchase.
          const steps: [string, number][] = [];
          if (['lead', 'checkout', 'purchase'].includes(status)) steps.push(['LeadSubmitted', 0]);
          if (['checkout', 'purchase'].includes(status)) steps.push(['InitiateCheckout', value]);
          if (status === 'purchase') steps.push(['Purchase', value]);
          // Sebagian checkout lama baru ditandai Purchase setelah lewat 7 hari → contoh event kedaluwarsa.
          const lateMark = status === 'checkout' && d >= 9 && rnd() < 0.3;
          if (lateMark) steps.push(['Purchase', value]);
          let t = clicked + 15 * 60_000;
          for (const [i, [name, val]] of steps.entries()) {
            t = lateMark && i === steps.length - 1 ? clicked + 8 * DAY : t + (20 + rnd() * 240) * 60_000;
            if (t > now) break;
            const late = t - clicked > 7 * DAY;
            const s = rnd();
            const st = late ? 'expired' : s < 0.05 ? 'failed' : 'sent';
            const source = pick(['manual', 'manual', 'api', 'auto']);
            const eventId = `demo_${leads}_${name}`;
            const payload = { data: [{ event_name: name, event_time: Math.floor(t / 1000), event_id: eventId, action_source: 'business_messaging', messaging_channel: 'whatsapp',
              user_data: { ctwa_clid: clid, ph: [hashPhone(phone)] }, ...(val ? { custom_data: { value: val, currency: 'IDR' } } : {}) }] };
            const resp = st === 'sent' ? { events_received: 1, fbtrace_id: 'demo' } : st === 'failed' ? { error: { message: 'Invalid parameter', code: 100 } } : null;
            const err = st === 'failed' ? 'Invalid parameter' : st === 'expired' ? 'Lewat batas 7 hari sejak klik iklan' : null;
            const ev = (await c.query<{ id: string }>(
              `INSERT INTO events (workspace_id, lead_id, event_id, event_name, value, source, status, payload, response, error, attempts, created_by, event_time, duplicates, created_at, sent_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13 / 1000.0),$14,to_timestamp($13 / 1000.0),$15) RETURNING id`,
              [ws.workspace_id, lead.id, eventId, name, val, source, st, JSON.stringify(payload), resp && JSON.stringify(resp), err, st === 'expired' ? 0 : 1,
                source === 'manual' ? ws.user_id : null, t, source === 'api' && rnd() < 0.15 ? 1 : 0, st === 'sent' ? new Date(t + 3000) : null])).rows[0]!;
            if (st !== 'expired') await c.query('INSERT INTO event_attempts (event_id, http_status, message, created_at) VALUES ($1,$2,$3,to_timestamp($4 / 1000.0))',
              [ev.id, st === 'sent' ? 200 : 400, st === 'sent' ? 'Diterima Meta · events_received: 1' : 'Invalid parameter', t + 3000]);
            events++;
          }
        }
      }
      await c.query('COMMIT');
      console.log(`Seed selesai untuk workspace "${ws.name}": ${leads} lead, ${events} event, ${30 * ADS.length} baris spend iklan.`);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
