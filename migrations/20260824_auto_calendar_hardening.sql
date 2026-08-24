BEGIN;

ALTER TABLE reservation_bookings
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200);

CREATE UNIQUE INDEX IF NOT EXISTS reservation_bookings_team_idempotency_idx
  ON reservation_bookings (team_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
