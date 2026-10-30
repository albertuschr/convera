-- Skema awal Convera. gen_random_uuid() bawaan Postgres 13+ (tanpa extension).

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  name                text NOT NULL,
  phone               text NOT NULL DEFAULT '',
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  disabled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Role per workspace: owner (penuh), cs (kelola lead & event), agency (hanya lihat).
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'cs', 'agency')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Token sesi acak disimpan sebagai hash SHA-256; token asli hanya ada di cookie HttpOnly.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Kredensial integrasi per workspace. Token Meta dan secret webhook dienkripsi (AES-256-GCM).
CREATE TABLE workspace_integrations (
  workspace_id        uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  meta_dataset_id     text,
  meta_token_enc      text,
  meta_token_saved_at timestamptz,
  webhook_url         text,
  webhook_events      text[] NOT NULL DEFAULT '{}',
  webhook_secret_enc  text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL DEFAULT '',
  phone        text NOT NULL DEFAULT '',
  ctwa_clid    text,
  campaign     text,
  ad_set       text,
  ad           text,
  status       text NOT NULL DEFAULT 'new',
  value        numeric(14,2) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_ws_created_idx ON leads (workspace_id, created_at DESC);

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  event_id     text NOT NULL,
  event_name   text NOT NULL,
  value        numeric(14,2) NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'IDR',
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('api', 'manual', 'auto')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  payload      jsonb,
  response     jsonb,
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  UNIQUE (workspace_id, event_id)
);
CREATE INDEX events_ws_created_idx ON events (workspace_id, created_at DESC);

CREATE TABLE rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  keyword      text NOT NULL,
  event_name   text NOT NULL,
  value        numeric(14,2),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rules_ws_idx ON rules (workspace_id);

-- API key: hanya hash SHA-256 yang disimpan; key asli ditampilkan sekali saat dibuat.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     bytea NOT NULL UNIQUE,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_ws_idx ON api_keys (workspace_id);

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target       text,
  meta         jsonb NOT NULL DEFAULT '{}',
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_created_idx ON audit_logs (workspace_id, created_at DESC);
CREATE INDEX audit_user_idx ON audit_logs (user_id, created_at DESC);
