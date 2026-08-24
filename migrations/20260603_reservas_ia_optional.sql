BEGIN;

-- AllSender Reservas IA
-- SQL opcional para Fase 2.
-- La Fase 1 visual NO depende de estas tablas; si no las importas, el módulo muestra estados vacíos seguros.
-- Regla SaaS: todo queda separado por team_id.

CREATE TABLE IF NOT EXISTS reservation_ai_settings (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT false,
  agent_name varchar(160) NOT NULL DEFAULT 'AllSender Reservas IA',
  require_human_approval boolean NOT NULL DEFAULT false,
  can_create_bookings boolean NOT NULL DEFAULT false,
  can_reschedule boolean NOT NULL DEFAULT false,
  can_cancel boolean NOT NULL DEFAULT false,
  can_create_calendar_events boolean NOT NULL DEFAULT false,
  allowed_channels jsonb NOT NULL DEFAULT '["WhatsApp","WebChat","Instagram","Messenger","Facebook"]'::jsonb,
  handoff_keywords text[] NOT NULL DEFAULT ARRAY['humano','asesor','agente','ayuda','queja','urgente'],
  instructions text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id)
);

CREATE TABLE IF NOT EXISTS reservation_services (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name varchar(180) NOT NULL,
  description text,
  category varchar(120),
  duration_minutes integer NOT NULL DEFAULT 30,
  price_amount numeric(12,2),
  currency varchar(10) NOT NULL DEFAULT 'USD',
  buffer_before_minutes integer NOT NULL DEFAULT 0,
  buffer_after_minutes integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_resources (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name varchar(180) NOT NULL,
  resource_type varchar(60) NOT NULL DEFAULT 'empleado',
  email varchar(180),
  phone varchar(80),
  capacity integer NOT NULL DEFAULT 1,
  timezone varchar(80) NOT NULL DEFAULT 'America/Santo_Domingo',
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_availability_rules (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  resource_id bigint REFERENCES reservation_resources(id) ON DELETE CASCADE,
  service_id bigint REFERENCES reservation_services(id) ON DELETE CASCADE,
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  timezone varchar(80) NOT NULL DEFAULT 'America/Santo_Domingo',
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_calendar_connections (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  resource_id bigint REFERENCES reservation_resources(id) ON DELETE SET NULL,
  provider varchar(80) NOT NULL DEFAULT 'nylas',
  provider_account_id varchar(180),
  grant_id varchar(180),
  account_email varchar(220),
  calendar_id varchar(220),
  calendar_name varchar(220),
  status varchar(40) NOT NULL DEFAULT 'disconnected',
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_mode varchar(40) NOT NULL DEFAULT 'read_write',
  last_sync_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, provider, grant_id)
);

CREATE TABLE IF NOT EXISTS reservation_bookings (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  service_id bigint REFERENCES reservation_services(id) ON DELETE SET NULL,
  resource_id bigint REFERENCES reservation_resources(id) ON DELETE SET NULL,
  chat_id integer REFERENCES chats(id) ON DELETE SET NULL,
  contact_id integer REFERENCES contacts(id) ON DELETE SET NULL,
  customer_name varchar(180),
  customer_phone varchar(80),
  customer_email varchar(220),
  status varchar(40) NOT NULL DEFAULT 'pending',
  source_channel varchar(80) NOT NULL DEFAULT 'inbox',
  source_provider varchar(80),
  created_by_ai boolean NOT NULL DEFAULT false,
  requires_human_approval boolean NOT NULL DEFAULT false,
  start_at timestamptz,
  end_at timestamptz,
  timezone varchar(80) NOT NULL DEFAULT 'America/Santo_Domingo',
  nylas_event_id varchar(220),
  external_calendar_id varchar(220),
  cancellation_reason text,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_public_links (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug varchar(120) NOT NULL UNIQUE,
  title varchar(180) NOT NULL DEFAULT 'Reserva tu cita',
  is_active boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_reminders (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  booking_id bigint NOT NULL REFERENCES reservation_bookings(id) ON DELETE CASCADE,
  channel varchar(80) NOT NULL DEFAULT 'whatsapp',
  status varchar(40) NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_sync_logs (
  id bigserial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  connection_id bigint REFERENCES reservation_calendar_connections(id) ON DELETE SET NULL,
  event_type varchar(80) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'received',
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservation_services_team_active
  ON reservation_services (team_id, is_active);

CREATE INDEX IF NOT EXISTS idx_reservation_resources_team_active
  ON reservation_resources (team_id, is_active);

CREATE INDEX IF NOT EXISTS idx_reservation_bookings_team_start
  ON reservation_bookings (team_id, start_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_bookings_chat
  ON reservation_bookings (team_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_reservation_bookings_status
  ON reservation_bookings (team_id, status);

CREATE INDEX IF NOT EXISTS idx_reservation_connections_team_status
  ON reservation_calendar_connections (team_id, status);

CREATE INDEX IF NOT EXISTS idx_reservation_sync_logs_team_time
  ON reservation_sync_logs (team_id, created_at DESC);

COMMIT;
