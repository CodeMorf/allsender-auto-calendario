import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { sendReservationReminderEmail } from '@/lib/modules/reservas/email';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function clean(value: unknown) {
  return String(value ?? '').trim();
}

function getCronToken() {
  return clean(process.env.RESERVAS_REMINDERS_CRON_TOKEN) || clean(process.env.CRON_SECRET) || clean(process.env.CHAT_ARCHIVE_CRON_SECRET);
}

function authorized(request: NextRequest) {
  const expected = getCronToken();
  if (!expected) return true;
  const fromQuery = clean(request.nextUrl.searchParams.get('token'));
  const fromHeader = clean(request.headers.get('x-cron-token')) || clean(request.headers.get('authorization')).replace(/^Bearer\s+/i, '');
  return fromQuery === expected || fromHeader === expected;
}

function publicUrlFromMetadata(row: Row) {
  const slug = clean(row.metadata?.public_slug || row.public_slug);
  if (!slug) return null;
  const base = clean(process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || 'https://auth.allsender.tech').replace(/\/$/, '');
  return `${base}/es/reservar/${encodeURIComponent(slug)}`;
}

async function markReminder(id: number, status: 'sent' | 'failed', error?: string | null, extra?: Record<string, unknown>) {
  await db.execute(sql`
    UPDATE reservation_reminders
    SET status = ${status},
        sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END,
        last_error = ${error || null},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(extra || {})}::jsonb,
        updated_at = now()
    WHERE id = ${id}
  `).catch(() => null);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get('limit') || 20)));

  const result = await db.execute(sql`
    SELECT rem.id AS reminder_id,
           rem.team_id,
           rem.booking_id,
           rem.channel,
           rem.status AS reminder_status,
           rem.scheduled_at,
           rem.metadata AS reminder_metadata,
           b.customer_name,
           b.customer_email,
           b.start_at,
           b.end_at,
           b.timezone,
           b.status AS booking_status,
           b.nylas_event_id,
           b.metadata,
           COALESCE(s.name, '') AS service_name,
           COALESCE(r.name, '') AS resource_name
    FROM reservation_reminders rem
    INNER JOIN reservation_bookings b ON b.id = rem.booking_id AND b.team_id = rem.team_id
    LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
    LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
    WHERE rem.status = 'pending'
      AND rem.channel = 'email'
      AND rem.scheduled_at <= now()
      AND b.status NOT IN ('cancelled', 'canceled')
      AND b.customer_email IS NOT NULL
      AND b.start_at IS NOT NULL
      AND b.end_at IS NOT NULL
      AND b.start_at > now()
    ORDER BY rem.scheduled_at ASC
    LIMIT ${limit}
  `).catch((error) => {
    console.error('[reservas:cron:reminders:select]', error);
    return null;
  });

  const pending = rows(result);
  const processed: Array<{ id: number; bookingId: number; status: string; error?: string }> = [];

  for (const item of pending) {
    const reminderId = Number(item.reminder_id || 0);
    const bookingId = Number(item.booking_id || 0);
    if (!reminderId || !bookingId) continue;

    const sent = await sendReservationReminderEmail({
      to: clean(item.customer_email),
      customerName: clean(item.customer_name) || 'cliente',
      serviceName: clean(item.service_name) || 'Reserva',
      resourceName: clean(item.resource_name) || 'Equipo',
      startAt: new Date(item.start_at).toISOString(),
      endAt: new Date(item.end_at).toISOString(),
      timezone: clean(item.timezone) || 'America/Santo_Domingo',
      publicUrl: publicUrlFromMetadata(item),
      calendarSynced: Boolean(item.nylas_event_id),
    });

    if (sent.ok) {
      await markReminder(reminderId, 'sent', null, { sent_by: 'reservas_cron', sent_at: new Date().toISOString() });
      processed.push({ id: reminderId, bookingId, status: 'sent' });
    } else {
      await markReminder(reminderId, 'failed', sent.error, { failed_by: 'reservas_cron', failed_at: new Date().toISOString() });
      processed.push({ id: reminderId, bookingId, status: 'failed', error: sent.error });
    }
  }

  return NextResponse.json({ ok: true, pending: pending.length, processed });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
