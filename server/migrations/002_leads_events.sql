-- Fase 1: data lead, event, dan performa iklan untuk dashboard.

-- Lead = satu kontak WhatsApp per workspace. clicked_at = waktu klik iklan CTWA (awal batas atribusi 7 hari).
ALTER TABLE leads
  ADD COLUMN first_message text NOT NULL DEFAULT '',
  ADD COLUMN ad_headline   text,
  ADD COLUMN ad_body       text,
  ADD COLUMN clicked_at    timestamptz;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN ('new', 'lead', 'checkout', 'purchase', 'lost'));
CREATE UNIQUE INDEX leads_ws_phone_uq ON leads (workspace_id, phone) WHERE phone <> '';

-- Status event: pending -> sent | failed; expired = lewat 7 hari sejak klik, tidak dikirim.
-- duplicates = berapa kali event_id yang sama datang lagi setelah terkirim (dilewati, tidak dikirim ulang).
ALTER TABLE events DROP CONSTRAINT events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check CHECK (status IN ('pending', 'sent', 'failed', 'expired'));
ALTER TABLE events
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN event_time timestamptz,
  ADD COLUMN duplicates integer NOT NULL DEFAULT 0;
CREATE INDEX events_lead_idx ON events (lead_id);

-- Riwayat setiap percobaan kirim ke Meta (tab "Riwayat retry" di Log).
CREATE TABLE event_attempts (
  id          bigserial PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  http_status integer,
  message     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_attempts_event_idx ON event_attempts (event_id, id);

-- Spend & klik harian per iklan. Nanti diisi sinkronisasi Ad Account; sementara lewat seed/demo.
CREATE TABLE ad_insights (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date         date NOT NULL,
  campaign     text NOT NULL,
  ad_set       text NOT NULL,
  ad           text NOT NULL,
  spend        numeric(14,2) NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, date, campaign, ad_set, ad)
);
