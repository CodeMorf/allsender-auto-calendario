import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { sendReservationConfirmationEmail, sendReservationStatusEmail } from '@/lib/modules/reservas/email';
import { createNylasCalendarEvent, deleteNylasCalendarEvent, updateNylasCalendarEvent } from '@/lib/modules/reservas/nylas';

export type ReservationServiceOption = {
  id: number;
  name: string;
  durationMinutes: number;
  priceAmount?: number | null;
  currency?: string | null;
};

export type ReservationResourceOption = {
  id: number;
  name: string;
  timezone: string;
};

export type ReservationTimeFormat = '12h' | '24h';

export type ReservationSlot = {
  startAt: string;
  endAt: string;
  label: string;
  source: 'internal';
};

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function num(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clean(value: unknown, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function jsonMerge(value: Record<string, unknown>) {
  return JSON.stringify(value || {});
}

function reminderAt(startAt: Date) {
  const candidate = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
  const now = new Date();
  if (candidate.getTime() <= now.getTime()) {
    return new Date(Math.max(now.getTime() + 15 * 60 * 1000, startAt.getTime() - 60 * 60 * 1000));
  }
  return candidate;
}

async function createOrReplaceEmailReminder(teamId: number, bookingId: number, startAt: Date, customerEmail?: string | null, metadata?: Record<string, unknown>) {
  const email = clean(customerEmail, 220).toLowerCase();
  if (!email || !email.includes('@')) return;

  await db.execute(sql`
    UPDATE reservation_reminders
    SET status = 'cancelled',
        metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ cancelled_by: 'reservation_updated' })}::jsonb,
        updated_at = NOW()
    WHERE team_id = ${teamId}
      AND booking_id = ${bookingId}
      AND channel = 'email'
      AND status = 'pending'
  `).catch(() => null);

  await db.execute(sql`
    INSERT INTO reservation_reminders (team_id, booking_id, channel, status, scheduled_at, metadata, updated_at)
    VALUES (
      ${teamId},
      ${bookingId},
      'email',
      'pending',
      ${reminderAt(startAt).toISOString()}::timestamptz,
      ${jsonMerge({ kind: 'booking_reminder', customer_email: email, ...(metadata || {}) })}::jsonb,
      NOW()
    )
  `).catch(() => null);
}

async function cancelPendingReminders(teamId: number, bookingId: number, reason = 'reservation_cancelled') {
  await db.execute(sql`
    UPDATE reservation_reminders
    SET status = 'cancelled',
        metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ cancelled_by: reason })}::jsonb,
        updated_at = NOW()
    WHERE team_id = ${teamId}
      AND booking_id = ${bookingId}
      AND status = 'pending'
  `).catch(() => null);
}

async function getCalendarConnection(teamId: number, resourceId?: number | null) {
  const result = await db.execute(sql`
    SELECT id, provider, grant_id, account_email, calendar_id, calendar_name, status
    FROM reservation_calendar_connections
    WHERE team_id = ${teamId}
      AND status = 'connected'
      AND grant_id IS NOT NULL
    ORDER BY CASE WHEN ${resourceId || null}::bigint IS NOT NULL AND resource_id = ${resourceId || null} THEN 0 ELSE 1 END,
             updated_at DESC NULLS LAST,
             created_at DESC
    LIMIT 1
  `).catch(() => null);
  return rows(result)[0] || null;
}

function eventDescription(input: { serviceName?: string; resourceName?: string; phone?: string | null; email?: string | null; notes?: string | null }) {
  return [
    'Reserva creada desde AllSender Auto Cita IA.',
    input.serviceName ? `Servicio: ${input.serviceName}` : '',
    input.resourceName ? `Especialista/Recurso: ${input.resourceName}` : '',
    input.phone ? `Teléfono: ${input.phone}` : '',
    input.email ? `Email: ${input.email}` : '',
    input.notes ? `Nota: ${input.notes}` : '',
  ].filter(Boolean).join('\n');
}

async function syncCreateNylasEventForBooking(teamId: number, booking: Row) {
  const bookingId = Number(booking?.id || 0);
  if (!bookingId || !booking?.start_at || !booking?.end_at) return { row: booking, error: null as string | null };

  const connection = await getCalendarConnection(teamId, booking.resource_id ? Number(booking.resource_id) : null);
  if (!connection?.grant_id) {
    const message = 'No hay calendario conectado para crear evento externo.';
    await db.execute(sql`
      UPDATE reservation_bookings
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ nylas_event_created: false, nylas_error: message })}::jsonb,
          updated_at = NOW()
      WHERE team_id = ${teamId} AND id = ${bookingId}
    `).catch(() => null);
    return { row: booking, error: message };
  }

  try {
    const event = await createNylasCalendarEvent({
      grantId: String(connection.grant_id),
      calendarId: String(connection.calendar_id || 'primary'),
      title: `${clean(booking.service_name || 'Reserva', 180)} - ${clean(booking.customer_name || 'Cliente', 180)}`,
      description: eventDescription({
        serviceName: clean(booking.service_name, 180),
        resourceName: clean(booking.resource_name, 180),
        phone: clean(booking.customer_phone, 80),
        email: clean(booking.customer_email, 220),
        notes: clean(booking.notes, 1200),
      }),
      startAt: new Date(booking.start_at).toISOString(),
      endAt: new Date(booking.end_at).toISOString(),
      timezone: clean(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo', 80),
      customerEmail: clean(booking.customer_email, 220) || null,
      customerName: clean(booking.customer_name, 180),
      metadata: {
        allsender_booking_id: bookingId,
        allsender_team_id: teamId,
        allsender_source: clean(booking.source_channel || 'inbox', 80),
        auto_cita_ia: true,
      },
    });
    const eventId = String((event as any)?.data?.id || (event as any)?.id || '');
    if (!eventId) return { row: booking, error: null };

    const updated = await db.execute(sql`
      UPDATE reservation_bookings
      SET nylas_event_id = ${eventId},
          external_calendar_id = ${String(connection.calendar_id || 'primary')},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ nylas_event_created: true, nylas_error: null })}::jsonb,
          updated_at = NOW()
      WHERE team_id = ${teamId} AND id = ${bookingId}
      RETURNING *
    `);
    return { row: rows(updated)[0] || booking, error: null };
  } catch (error: any) {
    const message = error?.message || 'No se pudo crear evento externo.';
    await db.execute(sql`
      UPDATE reservation_bookings
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ nylas_event_created: false, nylas_error: message })}::jsonb,
          updated_at = NOW()
      WHERE team_id = ${teamId} AND id = ${bookingId}
    `).catch(() => null);
    return { row: booking, error: message };
  }
}

async function getBookingWithDetails(teamId: number, bookingId: number) {
  const result = await db.execute(sql`
    SELECT b.*, COALESCE(s.name, '') AS service_name, COALESCE(s.duration_minutes, 30) AS service_duration_minutes,
           COALESCE(r.name, '') AS resource_name, COALESCE(r.timezone, b.timezone, 'America/Santo_Domingo') AS resource_timezone
    FROM reservation_bookings b
    LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
    LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
    WHERE b.team_id = ${teamId} AND b.id = ${bookingId}
    LIMIT 1
  `).catch(() => null);
  return rows(result)[0] || null;
}

function normalize(value: unknown) {
  return clean(value, 500)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function normalizeTimeFormat(value: unknown): ReservationTimeFormat {
  const text = clean(value, 20).toLowerCase();
  return ['24h', '24', 'h24', 'military'].includes(text) ? '24h' : '12h';
}

function localTimeParts(iso: string | Date, timezone: string) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Santo_Domingo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}

function commercialClock(hour: number, minute: number, timeFormat: ReservationTimeFormat = '12h') {
  if (timeFormat === '24h') return `${pad(hour)}:${pad(minute)}`;
  const displayHour = hour % 12 || 12;
  const suffix = hour < 12 ? 'a. m.' : 'p. m.';
  return `${displayHour}:${pad(minute)} ${suffix}`;
}


export function zonedDateTimeToUtcIso(date: string, time: string, timezone = 'America/Santo_Domingo') {
  const [year, month, day] = date.split('-').map((item) => Number(item));
  const [hour, minute, second = 0] = time.split(':').map((item) => Number(item));
  if (![year, month, day, hour, minute, second].every((item) => Number.isFinite(item))) {
    return new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`).toISOString();
  }

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'America/Santo_Domingo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcGuess));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value || '0');
    const renderedAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    const offset = renderedAsUtc - utcGuess;
    return new Date(utcGuess - offset).toISOString();
  } catch {
    return new Date(utcGuess).toISOString();
  }
}

function dateWithOffset(date: string, time: string, timezone: string) {
  const normalizedTime = time.length === 5 ? `${time}:00` : time;
  return new Date(zonedDateTimeToUtcIso(date, normalizedTime, timezone));
}

function localWeekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function formatTime(iso: string, timezone: string, timeFormat: ReservationTimeFormat = '12h') {
  const parts = localTimeParts(iso, timezone);
  if (!parts) return iso;
  return commercialClock(parts.hour, parts.minute, normalizeTimeFormat(timeFormat));
}

export function formatReservationDateTime(iso: string, timezone = 'America/Santo_Domingo', timeFormat: ReservationTimeFormat = '12h') {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'la fecha acordada';
  const resolvedTimezone = clean(timezone, 80) || 'America/Santo_Domingo';
  const parts = localTimeParts(date, resolvedTimezone);
  try {
    const dateText = new Intl.DateTimeFormat('es', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: resolvedTimezone,
    }).format(date);
    const timeText = parts ? commercialClock(parts.hour, parts.minute, normalizeTimeFormat(timeFormat)) : '';
    return timeText ? `${dateText} a las ${timeText}` : dateText;
  } catch {
    return parts ? commercialClock(parts.hour, parts.minute, normalizeTimeFormat(timeFormat)) : 'la fecha acordada';
  }
}

function slotOverlaps(aStart: Date, aEnd: Date, busy: Array<{ start: Date; end: Date }>) {
  return busy.some((item) => aStart < item.end && aEnd > item.start);
}

export async function listReservationServices(teamId: number): Promise<ReservationServiceOption[]> {
  const result = await db.execute(sql`
    SELECT id, name, duration_minutes, price_amount, currency
    FROM reservation_services
    WHERE team_id = ${teamId} AND is_active = true
    ORDER BY name ASC
    LIMIT 40
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    name: clean(row.name, 180),
    durationMinutes: num(row.duration_minutes, 30),
    priceAmount: row.price_amount === null || row.price_amount === undefined ? null : Number(row.price_amount),
    currency: clean(row.currency || 'USD', 12),
  })).filter((item) => item.id > 0 && item.name);
}

export async function listReservationResources(teamId: number): Promise<ReservationResourceOption[]> {
  const result = await db.execute(sql`
    SELECT id, name, timezone
    FROM reservation_resources
    WHERE team_id = ${teamId} AND is_active = true
    ORDER BY name ASC
    LIMIT 40
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    name: clean(row.name, 180),
    timezone: clean(row.timezone || 'America/Santo_Domingo', 80),
  })).filter((item) => item.id > 0 && item.name);
}

export function findServiceByText(text: string, services: ReservationServiceOption[]) {
  const normalized = normalize(text);
  if (!normalized) return null;
  let best: ReservationServiceOption | null = null;
  let bestScore = 0;

  for (const service of services) {
    const name = normalize(service.name);
    if (!name) continue;
    let score = 0;
    if (normalized.includes(name)) score = 10 + name.length;
    else {
      const words = name.split(/\s+/).filter((word) => word.length >= 4);
      score = words.reduce((acc, word) => acc + (normalized.includes(word) ? 2 : 0), 0);
    }
    if (score > bestScore) {
      bestScore = score;
      best = service;
    }
  }

  return bestScore >= 2 ? best : null;
}

export async function getDefaultReservationResource(teamId: number, serviceId?: number | null) {
  const result = await db.execute(sql`
    SELECT id, name, timezone
    FROM reservation_resources
    WHERE team_id = ${teamId} AND is_active = true
    ORDER BY id ASC
    LIMIT 1
  `).catch(() => null);
  const row = rows(result)[0];
  if (!row?.id) return null;
  return {
    id: num(row.id),
    name: clean(row.name, 180),
    timezone: clean(row.timezone || 'America/Santo_Domingo', 80),
  } as ReservationResourceOption;
}

async function getService(teamId: number, serviceId: number) {
  const result = await db.execute(sql`
    SELECT id, name, duration_minutes, buffer_before_minutes, buffer_after_minutes
    FROM reservation_services
    WHERE team_id = ${teamId} AND id = ${serviceId} AND is_active = true
    LIMIT 1
  `).catch(() => null);
  return rows(result)[0] || null;
}

async function getResource(teamId: number, resourceId: number) {
  const result = await db.execute(sql`
    SELECT id, name, timezone
    FROM reservation_resources
    WHERE team_id = ${teamId} AND id = ${resourceId} AND is_active = true
    LIMIT 1
  `).catch(() => null);
  return rows(result)[0] || null;
}

async function getOpenHours(teamId: number, serviceId: number, resourceId: number, date: string, timezone: string) {
  const weekday = localWeekday(date);
  const result = await db.execute(sql`
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

  const rules = rows(result);
  if (rules.length) {
    return rules.map((rule) => ({
      start: clean(rule.start_time || '09:00', 20).slice(0, 5),
      end: clean(rule.end_time || '17:00', 20).slice(0, 5),
      timezone: clean(rule.timezone || timezone, 80),
    }));
  }

  if ([0, 6].includes(weekday)) return [];
  return [{ start: '09:00', end: '17:00', timezone }];
}

async function getBusy(teamId: number, resourceId: number, date: string, timezone: string) {
  const dayStart = dateWithOffset(date, '00:00', timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const bookingResult = await db.execute(sql`
    SELECT start_at, end_at
    FROM reservation_bookings
    WHERE team_id = ${teamId}
      AND resource_id = ${resourceId}
      AND status NOT IN ('cancelled', 'canceled')
      AND start_at < ${dayEnd.toISOString()}::timestamptz
      AND end_at > ${dayStart.toISOString()}::timestamptz
  `).catch(() => null);

  const blocksTable = await db.execute(sql`SELECT to_regclass('public.reservation_unavailable_blocks') AS table_name`).catch(() => null);
  const hasBlocks = Boolean(rows(blocksTable)[0]?.table_name);
  const blockResult = hasBlocks
    ? await db.execute(sql`
        SELECT start_at, end_at
        FROM reservation_unavailable_blocks
        WHERE team_id = ${teamId}
          AND is_active = true
          AND (resource_id IS NULL OR resource_id = ${resourceId})
          AND start_at < ${dayEnd.toISOString()}::timestamptz
          AND end_at > ${dayStart.toISOString()}::timestamptz
      `).catch(() => null)
    : null;

  return [...rows(bookingResult), ...rows(blockResult)]
    .map((row) => ({ start: new Date(row.start_at), end: new Date(row.end_at) }))
    .filter((item) => Number.isFinite(item.start.getTime()) && Number.isFinite(item.end.getTime()));
}

export async function checkReservationAvailability(input: {
  teamId: number;
  serviceId: number;
  resourceId?: number | null;
  date: string;
  limit?: number;
  timeFormat?: ReservationTimeFormat;
}): Promise<{ ok: boolean; service?: ReservationServiceOption; resource?: ReservationResourceOption; slots: ReservationSlot[]; message?: string }> {
  const service = await getService(input.teamId, input.serviceId);
  if (!service?.id) return { ok: false, slots: [], message: 'Servicio no disponible.' };

  const defaultResource = input.resourceId ? null : await getDefaultReservationResource(input.teamId, Number(service.id));
  const resourceId = input.resourceId || defaultResource?.id || null;
  if (!resourceId) return { ok: false, slots: [], message: 'Configura un recurso para recibir reservas.' };

  const resource = await getResource(input.teamId, resourceId);
  if (!resource?.id) return { ok: false, slots: [], message: 'Recurso no disponible.' };

  const timezone = clean(resource.timezone || 'America/Santo_Domingo', 80);
  const duration = Math.max(5, num(service.duration_minutes, 30));
  const openHours = await getOpenHours(input.teamId, Number(service.id), Number(resource.id), input.date, timezone);
  const busy = await getBusy(input.teamId, Number(resource.id), input.date, timezone);
  const slots: ReservationSlot[] = [];

  for (const hour of openHours) {
    const start = dateWithOffset(input.date, hour.start, timezone);
    const end = dateWithOffset(input.date, hour.end, timezone);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;

    for (let cursor = new Date(start); cursor.getTime() + duration * 60000 <= end.getTime(); cursor = new Date(cursor.getTime() + 30 * 60000)) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(slotStart.getTime() + duration * 60000);
      if (slotStart.getTime() <= Date.now() + 5 * 60 * 1000) continue;
      if (slotOverlaps(slotStart, slotEnd, busy)) continue;
      slots.push({
        startAt: slotStart.toISOString(),
        endAt: slotEnd.toISOString(),
        label: formatTime(slotStart.toISOString(), timezone, input.timeFormat),
        source: 'internal',
      });
    }
  }

  return {
    ok: true,
    service: {
      id: Number(service.id),
      name: clean(service.name, 180),
      durationMinutes: duration,
      priceAmount: service.price_amount === null || service.price_amount === undefined ? null : Number(service.price_amount),
      currency: clean(service.currency || 'USD', 12),
    },
    resource: {
      id: Number(resource.id),
      name: clean(resource.name, 180),
      timezone,
    },
    slots: slots.slice(0, input.limit || 8),
  };
}

export async function createReservationBookingFromAi(input: {
  teamId: number;
  chatId: number;
  serviceId: number;
  resourceId?: number | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  startAt: string;
  timezone?: string | null;
  requireHumanApproval?: boolean;
  createCalendarEvent?: boolean;
  notes?: string | null;
  skipAvailabilityRecheck?: boolean;
  idempotencyKey?: string | null;
}) {
  const service = await getService(input.teamId, input.serviceId);
  if (!service?.id) return { ok: false, message: 'Servicio no disponible.' };
  const resource = input.resourceId ? await getResource(input.teamId, input.resourceId) : await getDefaultReservationResource(input.teamId, Number(service.id));
  if (!resource?.id) return { ok: false, message: 'Configura un recurso para recibir reservas.' };

  const timezone = clean(input.timezone || resource.timezone || 'America/Santo_Domingo', 80);
  const startDate = new Date(input.startAt);
  if (!Number.isFinite(startDate.getTime())) return { ok: false, message: 'Fecha no disponible.' };
  const duration = Math.max(5, num(service.duration_minutes, 30));
  const endDate = new Date(startDate.getTime() + duration * 60000);
  const idempotencyKey = clean(
    input.idempotencyKey || `auto_cita:${input.chatId}:${Number(service.id)}:${Number(resource.id)}:${startDate.toISOString()}`,
    200
  );

  // A retried webhook or duplicated confirmation must return the original
  // booking instead of creating a second appointment or sending a second
  // confirmation email.
  const existingResult = await db.execute(sql`
    SELECT *
    FROM reservation_bookings
    WHERE team_id = ${input.teamId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `).catch(() => null);
  const existing = rows(existingResult)[0];
  if (existing?.id) {
    return {
      ok: true,
      existing: true,
      calendarSynced: Boolean(existing.nylas_event_id),
      calendarError: null,
      booking: {
        id: Number(existing.id),
        status: clean(existing.status || 'confirmed', 40),
        startAt: existing.start_at ? new Date(existing.start_at).toISOString() : startDate.toISOString(),
        endAt: existing.end_at ? new Date(existing.end_at).toISOString() : endDate.toISOString(),
        serviceName: clean(service.name, 180),
        resourceName: clean(resource.name, 180),
        timezone,
        nylasEventId: existing.nylas_event_id ? String(existing.nylas_event_id) : null,
      },
    };
  }

  if (!input.skipAvailabilityRecheck) {
    const availability = await checkReservationAvailability({
      teamId: input.teamId,
      serviceId: Number(service.id),
      resourceId: Number(resource.id),
      date: input.startAt.slice(0, 10),
      limit: 96,
    });
    const slotIsOpen = availability.slots.some((slot) => Math.abs(new Date(slot.startAt).getTime() - startDate.getTime()) < 60_000);
    if (!slotIsOpen) return { ok: false, message: 'Ese horario está fuera de la disponibilidad configurada o fue marcado como no disponible.' };
  }

  const busy = await getBusy(input.teamId, Number(resource.id), input.startAt.slice(0, 10), timezone);
  if (slotOverlaps(startDate, endDate, busy)) return { ok: false, message: 'Ese horario ya no está disponible.' };

  const status = input.requireHumanApproval ? 'pending' : 'confirmed';
  const metadata = JSON.stringify({ source: 'auto_cita_ia', created_from_chat: true });

  const result = await db.execute(sql`
    INSERT INTO reservation_bookings (
      team_id, service_id, resource_id, chat_id, customer_name, customer_phone, customer_email,
      status, source_channel, created_by_ai, requires_human_approval,
      start_at, end_at, timezone, notes, metadata, idempotency_key, updated_at
    ) VALUES (
      ${input.teamId}, ${Number(service.id)}, ${Number(resource.id)}, ${input.chatId}, ${clean(input.customerName, 180)}, ${clean(input.customerPhone, 80) || null}, ${clean(input.customerEmail, 220) || null},
      ${status}, 'inbox', true, ${Boolean(input.requireHumanApproval)},
      ${startDate.toISOString()}::timestamptz, ${endDate.toISOString()}::timestamptz, ${timezone}, ${clean(input.notes, 1200) || null}, ${metadata}::jsonb, ${idempotencyKey}, NOW()
    )
    ON CONFLICT (team_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING *
  `);

  let bookingRow = rows(result)[0];
  const createdNow = Boolean(bookingRow?.id);
  if (!createdNow) {
    const duplicateResult = await db.execute(sql`
      SELECT *
      FROM reservation_bookings
      WHERE team_id = ${input.teamId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `).catch(() => null);
    bookingRow = rows(duplicateResult)[0];
    if (!bookingRow?.id) return { ok: false, message: 'No se pudo guardar la reserva de forma segura.' };
  }

  let booking: Row = { ...bookingRow, service_name: clean(service.name, 180), resource_name: clean(resource.name, 180), resource_timezone: timezone };
  if (!createdNow) {
    return {
      ok: true,
      existing: true,
      calendarSynced: Boolean(booking.nylas_event_id),
      calendarError: null,
      booking: {
        id: Number(booking.id),
        status: clean(booking.status || status, 40),
        startAt: booking.start_at ? new Date(booking.start_at).toISOString() : startDate.toISOString(),
        endAt: booking.end_at ? new Date(booking.end_at).toISOString() : endDate.toISOString(),
        serviceName: clean(service.name, 180),
        resourceName: clean(resource.name, 180),
        timezone,
        nylasEventId: booking.nylas_event_id ? String(booking.nylas_event_id) : null,
      },
    };
  }
  let calendarError: string | null = null;

  if (status === 'confirmed' && input.createCalendarEvent) {
    const sync = await syncCreateNylasEventForBooking(input.teamId, booking);
    booking = sync.row || booking;
    calendarError = sync.error;
  }

  if (clean(input.customerEmail, 220)) {
    const emailResult = await sendReservationConfirmationEmail({
      to: clean(input.customerEmail, 220),
      customerName: clean(input.customerName, 180),
      serviceName: clean(service.name, 180) || 'Reserva',
      resourceName: clean(resource.name, 180) || 'Agenda',
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      timezone,
      calendarSynced: Boolean(booking?.nylas_event_id),
    }).catch((error: any) => ({ ok: false as const, error: error?.message || 'No se pudo enviar email.' }));

    await db.execute(sql`
      UPDATE reservation_bookings
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge(emailResult.ok ? { email_confirmation_sent: true, email_confirmation_error: null } : { email_confirmation_sent: false, email_confirmation_error: emailResult.error })}::jsonb,
          updated_at = NOW()
      WHERE team_id = ${input.teamId} AND id = ${Number(booking?.id || 0)}
    `).catch(() => null);

    await createOrReplaceEmailReminder(input.teamId, Number(booking?.id || 0), startDate, clean(input.customerEmail, 220), { source: 'auto_cita_ia' });
  }

  return {
    ok: true,
    calendarSynced: Boolean(booking?.nylas_event_id),
    calendarError,
    booking: {
      id: Number(booking?.id || 0),
      status: clean(booking?.status || status, 40),
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      serviceName: clean(service.name, 180),
      resourceName: clean(resource.name, 180),
      timezone,
      nylasEventId: booking?.nylas_event_id ? String(booking.nylas_event_id) : null,
    },
  };
}

export async function findNextReservationBookingForChat(teamId: number, chatId: number) {
  const result = await db.execute(sql`
    SELECT b.id, b.service_id, b.resource_id, b.customer_name, b.customer_phone, b.customer_email,
           b.status, b.start_at, b.end_at, b.timezone,
           COALESCE(s.name, '') AS service_name,
           COALESCE(r.name, '') AS resource_name
    FROM reservation_bookings b
    LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
    LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
    WHERE b.team_id = ${teamId}
      AND b.chat_id = ${chatId}
      AND b.status NOT IN ('cancelled', 'canceled')
      AND b.start_at >= NOW() - interval '2 hours'
    ORDER BY b.start_at ASC
    LIMIT 1
  `).catch(() => null);
  return rows(result)[0] || null;
}

export async function cancelReservationBookingFromAi(teamId: number, bookingId: number, reason?: string | null) {
  const booking = await getBookingWithDetails(teamId, bookingId);
  if (!booking?.id) return { ok: false, message: 'No se encontró la reserva.' };

  const connection = await getCalendarConnection(teamId, booking.resource_id ? Number(booking.resource_id) : null);
  const calendarId = clean(booking.external_calendar_id || connection?.calendar_id || 'primary', 120);
  const grantId = clean(connection?.grant_id, 160);
  const eventId = clean(booking.nylas_event_id, 160);
  let nylasError: string | null = null;
  let nylasCancelled = false;

  if (grantId && eventId) {
    try {
      await deleteNylasCalendarEvent({ grantId, eventId, calendarId, notifyParticipants: Boolean(booking.customer_email) });
      nylasCancelled = true;
    } catch (error: any) {
      nylasError = error?.message || 'No se pudo cancelar el evento externo.';
    }
  }

  const result = await db.execute(sql`
    UPDATE reservation_bookings
    SET status = 'cancelled',
        cancellation_reason = ${clean(reason, 500) || 'Cancelada desde Auto Cita IA'},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ nylas_cancelled: nylasCancelled, nylas_error: nylasError })}::jsonb,
        updated_at = NOW()
    WHERE team_id = ${teamId} AND id = ${bookingId}
    RETURNING id, status
  `).catch(() => null);

  await cancelPendingReminders(teamId, bookingId);

  if (booking.customer_email) {
    await sendReservationStatusEmail({
      to: String(booking.customer_email),
      customerName: clean(booking.customer_name, 180),
      serviceName: clean(booking.service_name, 180) || 'Reserva',
      resourceName: clean(booking.resource_name, 180) || 'Agenda',
      startAt: booking.start_at ? new Date(booking.start_at).toISOString() : new Date().toISOString(),
      endAt: booking.end_at ? new Date(booking.end_at).toISOString() : new Date().toISOString(),
      timezone: clean(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo', 80),
      calendarSynced: Boolean(eventId),
      status: 'cancelled',
      reason: clean(reason, 500) || 'Cancelada desde Auto Cita IA',
    }).catch(() => null);
  }

  return { ok: Boolean(rows(result)[0]?.id), nylasCancelled, nylasError };
}

export async function rescheduleReservationBookingFromAi(input: {
  teamId: number;
  bookingId: number;
  serviceId: number;
  resourceId: number;
  startAt: string;
  timezone: string;
}) {
  const service = await getService(input.teamId, input.serviceId);
  if (!service?.id) return { ok: false, message: 'Servicio no disponible.' };
  const startDate = new Date(input.startAt);
  if (!Number.isFinite(startDate.getTime())) return { ok: false, message: 'Fecha no disponible.' };
  const endDate = new Date(startDate.getTime() + Math.max(5, num(service.duration_minutes, 30)) * 60000);
  const availability = await checkReservationAvailability({
    teamId: input.teamId,
    serviceId: input.serviceId,
    resourceId: input.resourceId,
    date: input.startAt.slice(0, 10),
    limit: 96,
  });
  const slotIsOpen = availability.slots.some((slot) => Math.abs(new Date(slot.startAt).getTime() - startDate.getTime()) < 60_000);
  if (!slotIsOpen) return { ok: false, message: 'Ese horario está fuera de la disponibilidad configurada o fue marcado como no disponible.' };
  const busy = await getBusy(input.teamId, input.resourceId, input.startAt.slice(0, 10), input.timezone);
  if (slotOverlaps(startDate, endDate, busy)) return { ok: false, message: 'Ese horario ya no está disponible.' };
  const booking = await getBookingWithDetails(input.teamId, input.bookingId);
  const connection = await getCalendarConnection(input.teamId, input.resourceId);
  const grantId = clean(connection?.grant_id, 160);
  const calendarId = clean(booking?.external_calendar_id || connection?.calendar_id || 'primary', 120);
  let nextEventId = clean(booking?.nylas_event_id, 160);
  let nylasError: string | null = null;

  if (grantId && nextEventId) {
    try {
      const event = await updateNylasCalendarEvent({
        grantId,
        eventId: nextEventId,
        calendarId,
        title: `${clean(booking?.service_name || service.name || 'Reserva', 180)} - ${clean(booking?.customer_name || 'Cliente', 180)}`,
        description: eventDescription({
          serviceName: clean(booking?.service_name || service.name, 180),
          resourceName: clean(booking?.resource_name, 180),
          phone: clean(booking?.customer_phone, 80),
          email: clean(booking?.customer_email, 220),
          notes: clean(booking?.notes, 1200),
        }),
        startAt: startDate.toISOString(),
        endAt: endDate.toISOString(),
        timezone: input.timezone,
        customerEmail: clean(booking?.customer_email, 220) || null,
        customerName: clean(booking?.customer_name, 180),
        metadata: { allsender_booking_id: input.bookingId, allsender_team_id: input.teamId, auto_cita_ia: true, allsender_rescheduled: true },
      });
      nextEventId = String((event as any)?.data?.id || (event as any)?.id || nextEventId);
    } catch (error: any) {
      nylasError = error?.message || 'No se pudo actualizar el evento externo.';
    }
  }

  await db.execute(sql`
    UPDATE reservation_bookings
    SET start_at = ${startDate.toISOString()}::timestamptz,
        end_at = ${endDate.toISOString()}::timestamptz,
        timezone = ${input.timezone},
        status = 'rescheduled',
        nylas_event_id = ${nextEventId || null},
        external_calendar_id = ${calendarId || null},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${jsonMerge({ nylas_rescheduled: !nylasError && Boolean(nextEventId), nylas_error: nylasError })}::jsonb,
        updated_at = NOW()
    WHERE team_id = ${input.teamId} AND id = ${input.bookingId}
  `);

  if (booking?.customer_email) {
    await sendReservationStatusEmail({
      to: String(booking.customer_email),
      customerName: clean(booking.customer_name, 180),
      serviceName: clean(booking.service_name || service.name, 180) || 'Reserva',
      resourceName: clean(booking.resource_name, 180) || 'Agenda',
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      timezone: input.timezone,
      calendarSynced: Boolean(nextEventId),
      status: 'rescheduled',
    }).catch(() => null);
    await createOrReplaceEmailReminder(input.teamId, input.bookingId, startDate, String(booking.customer_email), { source: 'auto_cita_ia_rescheduled' });
  }

  return { ok: true, startAt: startDate.toISOString(), endAt: endDate.toISOString(), nylasEventId: nextEventId || null, nylasError };
}
