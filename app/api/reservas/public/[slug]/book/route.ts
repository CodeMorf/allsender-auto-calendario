import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { createNylasCalendarEvent, getNylasAvailability } from '@/lib/modules/reservas/nylas';
import { sendReservationConfirmationEmail } from '@/lib/modules/reservas/email';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function cleanText(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanId(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown) {
  const text = cleanText(value, 80);
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function publicUrl(slug: string) {
  const base = String(process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || 'https://auth.allsender.tech').replace(/\/$/, '');
  return `${base}/es/reservar/${encodeURIComponent(slug)}`;
}

function reminderAt(startAt: Date) {
  const candidate = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
  const now = new Date();
  if (candidate.getTime() <= now.getTime()) {
    return new Date(Math.max(now.getTime() + 15 * 60 * 1000, startAt.getTime() - 60 * 60 * 1000));
  }
  return candidate;
}

function serialize(row: Row, calendarError?: string | null) {
  return {
    id: Number(row.id || 0),
    customerName: String(row.customer_name || ''),
    customerPhone: String(row.customer_phone || ''),
    customerEmail: String(row.customer_email || ''),
    serviceId: row.service_id ? Number(row.service_id) : null,
    resourceId: row.resource_id ? Number(row.resource_id) : null,
    status: String(row.status || 'confirmed'),
    sourceChannel: String(row.source_channel || 'public_link'),
    startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    timezone: String(row.timezone || 'America/Santo_Domingo'),
    notes: String(row.notes || ''),
    nylasEventId: row.nylas_event_id ? String(row.nylas_event_id) : null,
    externalCalendarId: row.external_calendar_id ? String(row.external_calendar_id) : null,
    calendarError: calendarError || null,
  };
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
      SELECT id, name, duration_minutes
      FROM reservation_services
      WHERE team_id = ${teamId} AND id = ${serviceId} AND is_active = true
      LIMIT 1
    `).catch(() => null),
    db.execute(sql`
      SELECT id, name, resource_type, timezone
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
    link,
    service,
    resource,
    connection: rows(connectionResult)[0] || null,
  };
}


function roundUnixToFiveMinutes(value: number, direction: 'floor' | 'ceil') {
  const step = 5 * 60;
  return direction === 'ceil' ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
}

function localTimeForOpenHours(date: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone || 'America/Santo_Domingo',
    }).format(date);
  } catch {
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }
}

function localWeekdayForOpenHours(date: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: timezone || 'America/Santo_Domingo',
    }).format(date).toLowerCase();
    const map: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    return map[parts.slice(0, 3)] ?? date.getUTCDay();
  } catch {
    return date.getUTCDay();
  }
}

async function isNylasSlotStillAvailable(ctx: any, startAt: Date, endAt: Date, timezone: string) {
  const connection = ctx?.connection;
  if (!connection?.grant_id || !connection?.account_email) return null as boolean | null;

  try {
    const durationMinutes = Math.max(5, Math.round((endAt.getTime() - startAt.getTime()) / 60000));
    const startTime = roundUnixToFiveMinutes(Math.floor(startAt.getTime() / 1000), 'floor');
    const endTime = roundUnixToFiveMinutes(Math.floor(endAt.getTime() / 1000), 'ceil');
    const weekday = localWeekdayForOpenHours(startAt, timezone);
    const availability = await getNylasAvailability({
      participantEmail: String(connection.account_email),
      calendarId: String(connection.calendar_id || 'primary'),
      startTime,
      endTime,
      durationMinutes,
      intervalMinutes: durationMinutes,
      timezone,
      openHours: [
        {
          days: [weekday],
          start: localTimeForOpenHours(startAt, timezone),
          end: localTimeForOpenHours(endAt, timezone),
          timezone,
          exdates: [],
        },
      ],
      bufferBefore: 0,
      bufferAfter: 0,
    });

    const targetStart = roundUnixToFiveMinutes(Math.floor(startAt.getTime() / 1000), 'floor');
    return Boolean((availability.data?.time_slots || []).some((slot: any) => Number(slot.start_time || 0) === targetStart));
  } catch (error: any) {
    console.warn('[reservas:public:book:availability-check]', error?.message || error);
    return null;
  }
}

async function hasConflict(teamId: number, resourceId: number, startAt: Date, endAt: Date) {
  const result = await db.execute(sql`
    SELECT id
    FROM reservation_bookings
    WHERE team_id = ${teamId}
      AND resource_id = ${resourceId}
      AND status NOT IN ('cancelled', 'canceled')
      AND start_at IS NOT NULL
      AND end_at IS NOT NULL
      AND NOT (end_at <= ${startAt.toISOString()}::timestamptz OR start_at >= ${endAt.toISOString()}::timestamptz)
    LIMIT 1
  `).catch(() => null);
  return rows(result).length > 0;
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  let createdBookingId: number | null = null;
  try {
    const { slug } = await context.params;
    const body = await request.json().catch(() => ({}));
    const serviceId = cleanId(body.serviceId ?? body.service_id);
    const resourceId = cleanId(body.resourceId ?? body.resource_id);
    const startAt = validDate(body.startAt ?? body.start_at);
    const endAt = validDate(body.endAt ?? body.end_at);
    const customerName = cleanText(body.customerName ?? body.customer_name, 180);
    const customerEmail = cleanText(body.customerEmail ?? body.customer_email, 220);
    const customerPhone = cleanText(body.customerPhone ?? body.customer_phone, 80);

    if (!serviceId || !resourceId) return NextResponse.json({ error: 'Selecciona servicio y recurso.' }, { status: 400 });
    if (!startAt || !endAt || endAt <= startAt) return NextResponse.json({ error: 'Selecciona una hora válida.' }, { status: 400 });
    if (!customerName) return NextResponse.json({ error: 'El nombre es obligatorio.' }, { status: 400 });

    const ctx = await getContext(slug, serviceId, resourceId);
    if (!ctx) return NextResponse.json({ error: 'Link, servicio o recurso no disponible.' }, { status: 404 });

    const timezone = String(ctx.resource.timezone || 'America/Santo_Domingo');
    const conflict = await hasConflict(ctx.teamId, resourceId, startAt, endAt);
    if (conflict) return NextResponse.json({ error: 'Ese horario acaba de ocuparse. Elige otro horario.' }, { status: 409 });

    // Anti-choque final: justo antes de insertar, confirmamos que Nylas todavía ve libre el horario.
    // Si otra persona creó un evento directamente en Google Calendar después de cargar horarios, se bloquea aquí.
    const nylasAvailable = await isNylasSlotStillAvailable(ctx, startAt, endAt, timezone);
    if (nylasAvailable === false) {
      return NextResponse.json({ error: 'Ese horario ya no está disponible en el calendario conectado. Elige otro horario.' }, { status: 409 });
    }

    const insertResult = await db.execute(sql`
      WITH conflict AS (
        SELECT id
        FROM reservation_bookings
        WHERE team_id = ${ctx.teamId}
          AND resource_id = ${resourceId}
          AND status NOT IN ('cancelled', 'canceled')
          AND start_at IS NOT NULL
          AND end_at IS NOT NULL
          AND NOT (end_at <= ${startAt.toISOString()}::timestamptz OR start_at >= ${endAt.toISOString()}::timestamptz)
        LIMIT 1
      )
      INSERT INTO reservation_bookings (
        team_id, service_id, resource_id, customer_name, customer_phone, customer_email,
        status, source_channel, source_provider, created_by_ai, requires_human_approval,
        start_at, end_at, timezone, notes, metadata, updated_at
      )
      SELECT
        ${ctx.teamId},
        ${serviceId},
        ${resourceId},
        ${customerName},
        ${customerPhone || null},
        ${customerEmail || null},
        'confirmed',
        'public_link',
        'allsender_public_booking',
        false,
        false,
        ${startAt.toISOString()}::timestamptz,
        ${endAt.toISOString()}::timestamptz,
        ${timezone},
        ${cleanText(body.notes, 2000) || null},
        ${JSON.stringify({ public_slug: slug, public_url: publicUrl(slug), email_confirmation_sent: false })}::jsonb,
        now()
      WHERE NOT EXISTS (SELECT 1 FROM conflict)
      RETURNING id, customer_name, customer_phone, customer_email, service_id, resource_id,
                status, source_channel, start_at, end_at, timezone, notes, nylas_event_id,
                external_calendar_id
    `);

    const booking = rows(insertResult)[0] || {};
    if (!booking?.id) {
      return NextResponse.json({ error: 'Ese horario acaba de ocuparse. Elige otro horario.' }, { status: 409 });
    }
    createdBookingId = Number(booking.id || 0) || null;
    let calendarError: string | null = null;
    let finalRow = booking;

    const connection = ctx.connection;
    if (connection?.grant_id) {
      try {
        const eventTitle = `${String(ctx.service.name || 'Reserva')} - ${customerName}`;
        const event = await createNylasCalendarEvent({
          grantId: String(connection.grant_id),
          calendarId: String(connection.calendar_id || 'primary'),
          title: eventTitle,
          description: [
            `Reserva creada desde AllSender Reservas IA.`,
            `Servicio: ${String(ctx.service.name || '')}`,
            `Recurso: ${String(ctx.resource.name || '')}`,
            customerPhone ? `Teléfono: ${customerPhone}` : '',
            customerEmail ? `Email: ${customerEmail}` : '',
            cleanText(body.notes, 2000) ? `Nota: ${cleanText(body.notes, 2000)}` : '',
          ].filter(Boolean).join('\n'),
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          timezone,
          customerEmail: customerEmail || null,
          customerName,
          metadata: {
            allsender_booking_id: String(createdBookingId || ''),
            allsender_team_id: String(ctx.teamId),
            allsender_source: 'public_link',
          },
        });
        const eventId = String(event?.data?.id || event?.id || '');
        if (eventId) {
          const updateResult = await db.execute(sql`
            UPDATE reservation_bookings
            SET nylas_event_id = ${eventId},
                external_calendar_id = ${String(connection.calendar_id || 'primary')},
                metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ nylas_event_created: true, nylas_error: null })}::jsonb,
                updated_at = now()
            WHERE team_id = ${ctx.teamId} AND id = ${createdBookingId}
            RETURNING id, customer_name, customer_phone, customer_email, service_id, resource_id,
                      status, source_channel, start_at, end_at, timezone, notes, nylas_event_id,
                      external_calendar_id
          `);
          finalRow = rows(updateResult)[0] || booking;
        }
      } catch (error: any) {
        console.error('[reservas:public:book:nylas]', error);
        calendarError = error?.message || 'No se pudo crear el evento en calendario externo.';
        await db.execute(sql`
          UPDATE reservation_bookings
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ nylas_event_created: false, nylas_error: calendarError })}::jsonb,
              updated_at = now()
          WHERE team_id = ${ctx.teamId} AND id = ${createdBookingId}
        `).catch(() => null);
      }
    } else {
      calendarError = 'No hay conexión Nylas activa; reserva guardada solo en AllSender.';
    }

    let emailWarning: string | null = null;
    if (customerEmail) {
      const emailResult = await sendReservationConfirmationEmail({
        to: customerEmail,
        customerName,
        serviceName: String(ctx.service.name || 'Reserva'),
        resourceName: String(ctx.resource.name || 'Recurso'),
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timezone,
        publicUrl: publicUrl(slug),
        calendarSynced: Boolean(finalRow?.nylas_event_id),
      });

      if (emailResult.ok) {
        await db.execute(sql`
          UPDATE reservation_bookings
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ email_confirmation_sent: true, email_confirmation_error: null })}::jsonb,
              updated_at = now()
          WHERE team_id = ${ctx.teamId} AND id = ${createdBookingId}
        `).catch(() => null);
      } else {
        emailWarning = emailResult.error;
        await db.execute(sql`
          UPDATE reservation_bookings
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ email_confirmation_sent: false, email_confirmation_error: emailResult.error })}::jsonb,
              updated_at = now()
          WHERE team_id = ${ctx.teamId} AND id = ${createdBookingId}
        `).catch(() => null);
      }

      await db.execute(sql`
        INSERT INTO reservation_reminders (team_id, booking_id, channel, status, scheduled_at, metadata, updated_at)
        VALUES (
          ${ctx.teamId},
          ${createdBookingId},
          'email',
          'pending',
          ${reminderAt(startAt).toISOString()}::timestamptz,
          ${JSON.stringify({ kind: 'booking_reminder', customer_email: customerEmail, public_slug: slug })}::jsonb,
          now()
        )
      `).catch(() => null);
    }

    const warning = [calendarError, emailWarning ? `Email: ${emailWarning}` : null].filter(Boolean).join(' | ') || null;

    return NextResponse.json({
      ok: true,
      booking: serialize(finalRow, calendarError),
      warning,
      emailSent: Boolean(customerEmail && !emailWarning),
    });
  } catch (error: any) {
    console.error('[reservas:public:book]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo confirmar la reserva.' }, { status: 500 });
  }
}
