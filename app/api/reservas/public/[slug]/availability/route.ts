import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getNylasAvailability } from '@/lib/modules/reservas/nylas';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

type OpenHour = { days: number[]; start: string; end: string; timezone: string; exdates: string[] };

type Slot = { startAt: string; endAt: string; label: string; source: string };

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function intParam(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanDate(value: string | null) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function addDays(date: string, days: number) {
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

function roundUnixToFiveMinutes(value: number, direction: 'floor' | 'ceil') {
  const step = 5 * 60;
  return direction === 'ceil' ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
}

function dateWithOffset(date: string, time: string, timezone: string) {
  const offset = timezone === 'America/Santo_Domingo' ? '-04:00' : '';
  return new Date(`${date}T${time.length === 5 ? `${time}:00` : time}${offset}`);
}

function formatTime(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('es', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone || 'America/Santo_Domingo',
  }).format(new Date(iso));
}

function localWeekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function slotOverlaps(aStart: Date, aEnd: Date, busy: Array<{ start: Date; end: Date }>) {
  return busy.some((item) => aStart < item.end && aEnd > item.start);
}

function buildInternalSlots({
  date,
  openHours,
  durationMinutes,
  intervalMinutes,
  timezone,
  busy,
}: {
  date: string;
  openHours: OpenHour[];
  durationMinutes: number;
  intervalMinutes: number;
  timezone: string;
  busy: Array<{ start: Date; end: Date }>;
}) {
  const slots: Slot[] = [];
  for (const hour of openHours) {
    const start = dateWithOffset(date, hour.start, timezone);
    const end = dateWithOffset(date, hour.end, timezone);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;

    for (let cursor = new Date(start); cursor.getTime() + durationMinutes * 60000 <= end.getTime(); cursor = new Date(cursor.getTime() + intervalMinutes * 60000)) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);
      if (slotStart.getTime() <= Date.now() + 5 * 60 * 1000) continue;
      if (slotOverlaps(slotStart, slotEnd, busy)) continue;
      slots.push({
        startAt: slotStart.toISOString(),
        endAt: slotEnd.toISOString(),
        label: formatTime(slotStart.toISOString(), timezone),
        source: 'internal',
      });
    }
  }
  return slots.slice(0, 40);
}

async function getContext(slug: string, serviceId: number, resourceId: number) {
  const linkResult = await db.execute(sql`
    SELECT id, team_id, title
    FROM reservation_public_links
    WHERE slug = ${slug} AND is_active = true
    LIMIT 1
  `).catch(() => null);
  const link = rows(linkResult)[0];
  if (!link?.team_id) return null;
  const teamId = Number(link.team_id);

  const [serviceResult, resourceResult, connectionResult] = await Promise.all([
    db.execute(sql`
      SELECT id, name, duration_minutes, buffer_before_minutes, buffer_after_minutes
      FROM reservation_services
      WHERE team_id = ${teamId} AND id = ${serviceId} AND is_active = true
      LIMIT 1
    `).catch(() => null),
    db.execute(sql`
      SELECT id, name, timezone
      FROM reservation_resources
      WHERE team_id = ${teamId} AND id = ${resourceId} AND is_active = true
      LIMIT 1
    `).catch(() => null),
    db.execute(sql`
      SELECT id, provider, grant_id, account_email, calendar_id, calendar_name, status
      FROM reservation_calendar_connections
      WHERE team_id = ${teamId} AND status = 'connected' AND grant_id IS NOT NULL
      ORDER BY CASE WHEN resource_id = ${resourceId} THEN 0 ELSE 1 END, updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `).catch(() => null),
  ]);

  const service = rows(serviceResult)[0];
  const resource = rows(resourceResult)[0];
  if (!service?.id || !resource?.id) return null;

  return {
    teamId,
    service,
    resource,
    connection: rows(connectionResult)[0] || null,
  };
}

async function getOpenHours(teamId: number, serviceId: number, resourceId: number, date: string, timezone: string) {
  const weekday = localWeekday(date);
  const rulesResult = await db.execute(sql`
    SELECT start_time::text AS start_time, end_time::text AS end_time, timezone
    FROM reservation_availability_rules
    WHERE team_id = ${teamId}
      AND is_active = true
      AND weekday = ${weekday}
      AND (service_id IS NULL OR service_id = ${serviceId})
      AND (resource_id IS NULL OR resource_id = ${resourceId})
    ORDER BY
      CASE WHEN service_id = ${serviceId} THEN 0 ELSE 1 END,
      CASE WHEN resource_id = ${resourceId} THEN 0 ELSE 1 END,
      start_time ASC
  `).catch(() => null);

  const rules = rows(rulesResult);
  if (rules.length) {
    return rules.map((rule) => ({
      days: [weekday],
      start: String(rule.start_time || '09:00').slice(0, 5),
      end: String(rule.end_time || '17:00').slice(0, 5),
      timezone: String(rule.timezone || timezone),
      exdates: [],
    })) as OpenHour[];
  }

  if ([0, 6].includes(weekday)) return [];
  return [{ days: [weekday], start: '09:00', end: '17:00', timezone, exdates: [] }] as OpenHour[];
}

async function getBusy(teamId: number, resourceId: number, start: Date, end: Date) {
  const result = await db.execute(sql`
    SELECT start_at, end_at
    FROM reservation_bookings
    WHERE team_id = ${teamId}
      AND (${resourceId}::bigint IS NULL OR resource_id = ${resourceId})
      AND status NOT IN ('cancelled', 'canceled')
      AND start_at IS NOT NULL
      AND end_at IS NOT NULL
      AND NOT (end_at <= ${start.toISOString()}::timestamptz OR start_at >= ${end.toISOString()}::timestamptz)
  `).catch(() => null);

  return rows(result)
    .map((row) => ({ start: new Date(row.start_at), end: new Date(row.end_at) }))
    .filter((item) => Number.isFinite(item.start.getTime()) && Number.isFinite(item.end.getTime()));
}

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const serviceId = intParam(request.nextUrl.searchParams.get('serviceId'));
    const resourceId = intParam(request.nextUrl.searchParams.get('resourceId'));
    const date = cleanDate(request.nextUrl.searchParams.get('date'));
    if (!serviceId || !resourceId || !date) {
      return NextResponse.json({ error: 'Faltan servicio, recurso o fecha.' }, { status: 400 });
    }

    const ctx = await getContext(slug, serviceId, resourceId);
    if (!ctx) return NextResponse.json({ error: 'Link, servicio o recurso no disponible.' }, { status: 404 });

    const timezone = String(ctx.resource.timezone || 'America/Santo_Domingo');
    const durationMinutes = Math.max(5, Number(ctx.service.duration_minutes || 30));
    const bufferBefore = Math.max(0, Number(ctx.service.buffer_before_minutes || 0));
    const bufferAfter = Math.max(0, Number(ctx.service.buffer_after_minutes || 0));
    const openHours = await getOpenHours(ctx.teamId, serviceId, resourceId, date, timezone);
    if (!openHours.length) return NextResponse.json({ ok: true, slots: [], source: 'closed', warning: 'Este día no tiene horarios de atención configurados.' });

    const dayStart = dateWithOffset(date, '00:00', timezone);
    // Nylas exige que start_time y end_time caigan en múltiplos de 5 minutos.
    // Usar 23:59 provoca invalid_request; cerramos el rango en la medianoche del día siguiente.
    const dayEnd = dateWithOffset(addDays(date, 1), '00:00', timezone);
    const busy = await getBusy(ctx.teamId, resourceId, dayStart, dayEnd);

    const fallbackSlots = buildInternalSlots({ date, openHours, durationMinutes, intervalMinutes: 30, timezone, busy });
    const connection = ctx.connection;
    if (!connection?.grant_id || !connection?.account_email) {
      return NextResponse.json({ ok: true, slots: fallbackSlots, source: 'internal', warning: 'Nylas no está conectado; horarios calculados con disponibilidad interna.' });
    }

    try {
      const startTime = roundUnixToFiveMinutes(Math.floor(dayStart.getTime() / 1000), 'floor');
      const endTime = roundUnixToFiveMinutes(Math.floor(dayEnd.getTime() / 1000), 'ceil');
      const availability = await getNylasAvailability({
        participantEmail: String(connection.account_email),
        calendarId: String(connection.calendar_id || 'primary'),
        startTime,
        endTime,
        durationMinutes,
        intervalMinutes: 30,
        timezone,
        openHours,
        bufferBefore,
        bufferAfter,
      });

      const slots = (availability.data?.time_slots || [])
        .map((slot) => {
          const startAt = new Date(Number(slot.start_time || 0) * 1000);
          const endAt = new Date(Number(slot.end_time || 0) * 1000);
          if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) return null;
          if (startAt.getTime() <= Date.now() + 5 * 60 * 1000) return null;
          if (slotOverlaps(startAt, endAt, busy)) return null;
          return {
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            label: formatTime(startAt.toISOString(), timezone),
            source: 'nylas',
          } as Slot;
        })
        .filter(Boolean) as Slot[];

      return NextResponse.json({ ok: true, slots: slots.slice(0, 40), source: 'nylas' });
    } catch (error: any) {
      console.error('[reservas:public:availability:nylas]', error);
      return NextResponse.json({ ok: true, slots: fallbackSlots, source: 'internal', warning: `Nylas no respondió disponibilidad; usando horario interno. ${error?.message || ''}` });
    }
  } catch (error: any) {
    console.error('[reservas:public:availability]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo consultar disponibilidad.' }, { status: 500 });
  }
}
