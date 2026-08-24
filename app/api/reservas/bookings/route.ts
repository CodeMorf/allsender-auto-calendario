import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';
import { createNylasCalendarEvent, deleteNylasCalendarEvent, updateNylasCalendarEvent } from '@/lib/modules/reservas/nylas';
import { sendReservationConfirmationEmail, sendReservationStatusEmail } from '@/lib/modules/reservas/email';
import { callEvolutionJson } from '@/lib/evolution/http';
import { sendMetaTextMessage } from '@/lib/meta/whatsapp';
import { sendZernioTextMessage, zernioConversationFromRemoteJid } from '@/lib/zernio/service';
import { formatReservationDateTime } from '@/lib/modules/reservas/availability';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

type BookingContext = {
  booking: Row;
  service: Row | null;
  resource: Row | null;
  connection: Row | null;
};

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

function minutesBetween(startAt: Date, endAt: Date, fallback = 30) {
  const diff = Math.round((endAt.getTime() - startAt.getTime()) / 60000);
  return Number.isFinite(diff) && diff > 0 ? diff : fallback;
}

function publicUrlFromMetadata(row: Row) {
  const slug = String(row.metadata?.public_slug || '').trim();
  if (!slug) return null;
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

async function createOrReplaceEmailReminder(teamId: number, bookingId: number, startAt: Date, customerEmail?: string | null, metadata?: Record<string, unknown>) {
  if (!customerEmail || !String(customerEmail).includes('@')) return;
  await db.execute(sql`
    UPDATE reservation_reminders
    SET status = 'cancelled',
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ cancelled_by: 'reservation_rescheduled_or_replaced' })}::jsonb,
        updated_at = now()
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
      ${JSON.stringify({ kind: 'booking_reminder', customer_email: customerEmail, ...(metadata || {}) })}::jsonb,
      now()
    )
  `).catch(() => null);
}

function serialize(row: Row) {
  return {
    id: Number(row.id || 0),
    customerName: String(row.customer_name || ''),
    customerPhone: String(row.customer_phone || ''),
    customerEmail: String(row.customer_email || ''),
    serviceId: row.service_id ? Number(row.service_id) : null,
    resourceId: row.resource_id ? Number(row.resource_id) : null,
    status: String(row.status || 'pending'),
    sourceChannel: String(row.source_channel || 'manual'),
    startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    timezone: String(row.timezone || 'America/Santo_Domingo'),
    notes: String(row.notes || ''),
    serviceName: String(row.service_name || ''),
    resourceName: String(row.resource_name || ''),
    nylasEventId: row.nylas_event_id ? String(row.nylas_event_id) : null,
    externalCalendarId: row.external_calendar_id ? String(row.external_calendar_id) : null,
    cancellationReason: String(row.cancellation_reason || ''),
    nylasError: row.metadata?.nylas_error ? String(row.metadata.nylas_error) : null,
  };
}

async function getConnection(teamId: number, resourceId: number | null) {
  const result = await db.execute(sql`
    SELECT id, provider, grant_id, account_email, calendar_id, calendar_name, status
    FROM reservation_calendar_connections
    WHERE team_id = ${teamId} AND status = 'connected' AND grant_id IS NOT NULL
    ORDER BY CASE WHEN resource_id = ${resourceId} THEN 0 ELSE 1 END,
             updated_at DESC NULLS LAST,
             created_at DESC
    LIMIT 1
  `).catch(() => null);
  return rows(result)[0] || null;
}

async function getBookingContext(teamId: number, bookingId: number): Promise<BookingContext | null> {
  const bookingResult = await db.execute(sql`
    SELECT b.*, COALESCE(s.name, '') AS service_name, COALESCE(s.duration_minutes, 30) AS service_duration_minutes,
           COALESCE(r.name, '') AS resource_name, COALESCE(r.timezone, b.timezone, 'America/Santo_Domingo') AS resource_timezone
    FROM reservation_bookings b
    LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
    LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
    WHERE b.team_id = ${teamId} AND b.id = ${bookingId}
    LIMIT 1
  `).catch(() => null);
  const booking = rows(bookingResult)[0];
  if (!booking?.id) return null;
  const connection = await getConnection(teamId, booking.resource_id ? Number(booking.resource_id) : null);
  return { booking, service: null, resource: null, connection };
}

async function hasConflict(teamId: number, resourceId: number | null, startAt: Date, endAt: Date, excludeId?: number | null) {
  if (!resourceId) return false;
  const result = await db.execute(sql`
    SELECT id
    FROM reservation_bookings
    WHERE team_id = ${teamId}
      AND resource_id = ${resourceId}
      AND (${excludeId || null}::bigint IS NULL OR id <> ${excludeId || null})
      AND status NOT IN ('cancelled', 'canceled')
      AND start_at IS NOT NULL
      AND end_at IS NOT NULL
      AND NOT (end_at <= ${startAt.toISOString()}::timestamptz OR start_at >= ${endAt.toISOString()}::timestamptz)
    LIMIT 1
  `).catch(() => null);
  return rows(result).length > 0;
}

function eventDescription(input: { serviceName?: string; resourceName?: string; phone?: string; email?: string; notes?: string }) {
  return [
    'Reserva creada desde AllSender Reservas IA.',
    input.serviceName ? `Servicio: ${input.serviceName}` : '',
    input.resourceName ? `Recurso: ${input.resourceName}` : '',
    input.phone ? `Teléfono: ${input.phone}` : '',
    input.email ? `Email: ${input.email}` : '',
    input.notes ? `Nota: ${input.notes}` : '',
  ].filter(Boolean).join('\n');
}


async function saveOutgoingChatMessage(teamId: number, chatId: number, text: string, status = 'sent', messageType = 'conversation', messageId?: string | null) {
  const id = messageId || `reservas_out_${Date.now()}_${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO messages
      (id, chat_id, from_me, message_type, text, status, is_ai, is_automation, is_internal, timestamp)
    VALUES
      (${id}, ${chatId}, true, ${messageType}, ${text}, ${status}, true, true, false, NOW())
    ON CONFLICT (id) DO NOTHING
  `).catch(() => null);

  await db.execute(sql`
    UPDATE chats
    SET last_message_text = ${text},
        last_message_timestamp = NOW(),
        last_message_from_me = true,
        last_message_status = ${status},
        unread_count = 0,
        archived_at = NULL,
        archived_reason = NULL,
        archived_by = NULL
    WHERE team_id = ${teamId} AND id = ${chatId}
  `).catch(() => null);
}

async function sendBookingChatNotification(teamId: number, chatId: unknown, text: string) {
  const parsedChatId = Number(chatId || 0);
  const messageText = cleanText(text, 1800);
  if (!parsedChatId || !messageText) return { ok: false, error: 'Sin conversación original.' };

  const chatResult = await db.execute(sql`
    SELECT c.id, c.remote_jid, c.instance_id,
           ei.instance_name, ei.access_token, ei.meta_token, ei.meta_phone_number_id,
           zc.zernio_account_id, zc.platform
    FROM chats c
    LEFT JOIN evolution_instances ei ON ei.id = c.instance_id AND ei.team_id = c.team_id
    LEFT JOIN zernio_connections zc ON zc.local_instance_id = c.instance_id AND zc.team_id = c.team_id
    WHERE c.team_id = ${teamId} AND c.id = ${parsedChatId}
    LIMIT 1
  `).catch(() => null);
  const chat = rows(chatResult)[0];
  if (!chat?.id) return { ok: false, error: 'No encontramos la conversación original.' };

  const remoteJid = String(chat.remote_jid || '');
  let providerMessageId: string | null = null;
  let messageType = 'conversation';

  try {
    if (remoteJid.endsWith('@zernio.allsender')) {
      const parsed = zernioConversationFromRemoteJid(remoteJid);
      if (!parsed?.conversationId || !chat.zernio_account_id) throw new Error('Conexión Zernio incompleta.');
      const sent: any = await sendZernioTextMessage({
        accountId: String(chat.zernio_account_id),
        conversationId: parsed.conversationId,
        text: messageText,
      });
      providerMessageId = `zrn_out_${String(parsed.platform || chat.platform || 'zernio')}_${String(sent?.messageId || sent?.id || sent?.data?.id || Date.now()).replace(/[^a-zA-Z0-9_.:-]/g, '_')}_${randomUUID()}`;
      messageType = String(parsed.platform || chat.platform || 'zernio');
    } else if (remoteJid.endsWith('@webchat.allsender')) {
      providerMessageId = `webchat_out_${Date.now()}_${randomUUID()}`;
      messageType = 'web_chat';
    } else if (chat.meta_token && chat.meta_phone_number_id) {
      const metaResult = await sendMetaTextMessage({
        phoneNumberId: String(chat.meta_phone_number_id),
        accessToken: String(chat.meta_token),
        to: remoteJid,
        text: messageText,
      });
      if (!metaResult.ok) throw new Error(metaResult.errorMessage || 'No pudimos enviar por WhatsApp oficial.');
      const providerId = (metaResult.data as any)?.messages?.[0]?.id || Date.now();
      providerMessageId = `meta_out_${String(providerId).replace(/[^a-zA-Z0-9_.:-]/g, '_')}_${randomUUID()}`;
      messageType = 'conversation';
    } else if (chat.instance_name && chat.access_token) {
      const evolutionApiUrl = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
      const sent = await callEvolutionJson(`${evolutionApiUrl}/message/sendText/${String(chat.instance_name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: String(chat.access_token) },
        body: JSON.stringify({ number: remoteJid, text: messageText }),
      }, 20000);
      if (!sent.ok) throw new Error(sent.errorMessage || 'No pudimos enviar por WhatsApp QR.');
      providerMessageId = String((sent.data as any)?.key?.id || `wa_out_${Date.now()}_${randomUUID()}`);
      messageType = String((sent.data as any)?.messageType || 'conversation');
    } else {
      providerMessageId = `reservas_out_${Date.now()}_${randomUUID()}`;
    }

    await saveOutgoingChatMessage(teamId, parsedChatId, messageText, 'sent', messageType, providerMessageId);
    return { ok: true, error: null };
  } catch (error: any) {
    await saveOutgoingChatMessage(teamId, parsedChatId, messageText, 'failed', messageType || 'conversation', providerMessageId || null);
    return { ok: false, error: error?.message || 'No pudimos notificar por el canal original.' };
  }
}

function statusChatMessage(input: { type: 'cancelled' | 'rescheduled' | 'confirmed'; customerName?: string; serviceName?: string; startAt?: string; timezone?: string; reason?: string | null }) {
  const name = cleanText(input.customerName, 120) || 'tu cita';
  const service = cleanText(input.serviceName, 160) || 'la cita';
  const when = input.startAt ? formatReservationDateTime(input.startAt, input.timezone || 'America/Santo_Domingo') : '';
  if (input.type === 'cancelled') return `Hola ${name}, tu cita de ${service}${when ? ` para ${when}` : ''} fue cancelada correctamente.${input.reason ? ` Motivo: ${input.reason}` : ''}`;
  if (input.type === 'rescheduled') return `Hola ${name}, tu cita de ${service} fue reprogramada para ${when}.`;
  return `Hola ${name}, tu cita de ${service} quedó confirmada para ${when}.`;
}

async function syncCreateEvent(teamId: number, booking: Row, connection: Row | null) {
  if (!connection?.grant_id || !booking?.id || !booking.start_at || !booking.end_at) return { row: booking, error: null as string | null };

  try {
    const event = await createNylasCalendarEvent({
      grantId: String(connection.grant_id),
      calendarId: String(connection.calendar_id || 'primary'),
      title: `${String(booking.service_name || 'Reserva')} - ${String(booking.customer_name || 'Cliente')}`,
      description: eventDescription({
        serviceName: String(booking.service_name || ''),
        resourceName: String(booking.resource_name || ''),
        phone: String(booking.customer_phone || ''),
        email: String(booking.customer_email || ''),
        notes: String(booking.notes || ''),
      }),
      startAt: new Date(booking.start_at).toISOString(),
      endAt: new Date(booking.end_at).toISOString(),
      timezone: String(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo'),
      customerEmail: booking.customer_email ? String(booking.customer_email) : null,
      customerName: String(booking.customer_name || ''),
      metadata: {
        allsender_booking_id: Number(booking.id),
        allsender_team_id: teamId,
        allsender_source: String(booking.source_channel || 'manual'),
      },
    });
    const eventId = String(event?.data?.id || event?.id || '');
    if (!eventId) return { row: booking, error: null };

    const updateResult = await db.execute(sql`
      UPDATE reservation_bookings
      SET nylas_event_id = ${eventId},
          external_calendar_id = ${String(connection.calendar_id || 'primary')},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ nylas_event_created: true, nylas_error: null })}::jsonb,
          updated_at = now()
      WHERE team_id = ${teamId} AND id = ${Number(booking.id)}
      RETURNING *
    `);
    return { row: rows(updateResult)[0] || booking, error: null };
  } catch (error: any) {
    const message = error?.message || 'No se pudo crear evento en Nylas.';
    await db.execute(sql`
      UPDATE reservation_bookings
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ nylas_event_created: false, nylas_error: message })}::jsonb,
          updated_at = now()
      WHERE team_id = ${teamId} AND id = ${Number(booking.id)}
    `).catch(() => null);
    return { row: booking, error: message };
  }
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await db.execute(sql`
    SELECT b.id, b.customer_name, b.customer_phone, b.customer_email, b.service_id, b.resource_id,
           b.status, b.source_channel, b.start_at, b.end_at, b.timezone, b.notes,
           b.nylas_event_id, b.external_calendar_id, b.cancellation_reason, b.metadata,
           COALESCE(s.name, '') AS service_name,
           COALESCE(r.name, '') AS resource_name
    FROM reservation_bookings b
    LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
    LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
    WHERE b.team_id = ${Number(team.id)}
    ORDER BY b.start_at ASC NULLS LAST, b.created_at DESC
    LIMIT 100
  `);

  return NextResponse.json({ ok: true, bookings: rows(result).map(serialize) });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = Number(team.id);

    const body = await request.json().catch(() => ({}));
    const customerName = cleanText(body.customerName ?? body.customer_name, 180);
    const serviceId = cleanId(body.serviceId ?? body.service_id);
    const resourceId = cleanId(body.resourceId ?? body.resource_id);
    const startAtText = cleanText(body.startAt ?? body.start_at, 80);
    const timezone = cleanText(body.timezone, 80) || 'America/Santo_Domingo';

    if (!customerName) return NextResponse.json({ error: 'El nombre del cliente es obligatorio.' }, { status: 400 });
    if (!startAtText) return NextResponse.json({ error: 'La fecha/hora de inicio es obligatoria.' }, { status: 400 });

    const startAt = validDate(startAtText);
    if (!startAt) return NextResponse.json({ error: 'Fecha/hora inválida.' }, { status: 400 });

    const serviceResult = serviceId
      ? await db.execute(sql`
          SELECT name, duration_minutes
          FROM reservation_services
          WHERE team_id = ${teamId} AND id = ${serviceId}
          LIMIT 1
        `)
      : null;
    const service = rows(serviceResult)[0] || {};
    const duration = Number(service.duration_minutes || body.durationMinutes || 30);
    const endAt = new Date(startAt.getTime() + Math.max(5, duration) * 60000);

    const conflict = await hasConflict(teamId, resourceId, startAt, endAt, null);
    if (conflict) return NextResponse.json({ error: 'Ese horario ya está ocupado para este recurso.' }, { status: 409 });

    const result = await db.execute(sql`
      INSERT INTO reservation_bookings (
        team_id, service_id, resource_id, customer_name, customer_phone, customer_email,
        status, source_channel, created_by_ai, requires_human_approval,
        start_at, end_at, timezone, notes, updated_at
      ) VALUES (
        ${teamId},
        ${serviceId},
        ${resourceId},
        ${customerName},
        ${cleanText(body.customerPhone ?? body.customer_phone, 80) || null},
        ${cleanText(body.customerEmail ?? body.customer_email, 220) || null},
        ${cleanText(body.status, 40) || 'confirmed'},
        ${cleanText(body.sourceChannel ?? body.source_channel, 80) || 'manual'},
        false,
        false,
        ${startAt.toISOString()}::timestamptz,
        ${endAt.toISOString()}::timestamptz,
        ${timezone},
        ${cleanText(body.notes, 2000) || null},
        now()
      )
      RETURNING *
    `);

    let booking = rows(result)[0] || {};
    const connection = await getConnection(teamId, resourceId);
    const sync = await syncCreateEvent(teamId, { ...booking, service_name: service.name || '' }, connection);
    booking = sync.row;

    const customerEmail = cleanText(body.customerEmail ?? body.customer_email, 220);
    if (customerEmail) {
      const emailResult = await sendReservationConfirmationEmail({
        to: customerEmail,
        customerName,
        serviceName: String(service.name || 'Reserva'),
        resourceName: String(booking.resource_name || ''),
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timezone,
        publicUrl: publicUrlFromMetadata(booking),
        calendarSynced: Boolean(booking.nylas_event_id),
      });

      const emailMeta = emailResult.ok
        ? { email_confirmation_sent: true, email_confirmation_error: null }
        : { email_confirmation_sent: false, email_confirmation_error: emailResult.error };
      await db.execute(sql`
        UPDATE reservation_bookings
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(emailMeta)}::jsonb,
            updated_at = now()
        WHERE team_id = ${teamId} AND id = ${Number(booking.id)}
      `).catch(() => null);

      await createOrReplaceEmailReminder(teamId, Number(booking.id), startAt, customerEmail, { source: 'manual_panel' });
    }

    return NextResponse.json({ ok: true, booking: serialize(booking), warning: sync.error });
  } catch (error: any) {
    console.error('[reservas:bookings:post]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo crear la reserva.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = Number(team.id);

    const body = await request.json().catch(() => ({}));
    const id = cleanId(body.id);
    const action = cleanText(body.action, 40).toLowerCase();
    if (!id) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 });

    const ctx = await getBookingContext(teamId, id);
    if (!ctx) return NextResponse.json({ error: 'Reserva no encontrada.' }, { status: 404 });
    const booking = ctx.booking;
    const connection = ctx.connection;
    const calendarId = String(booking.external_calendar_id || connection?.calendar_id || 'primary');
    const grantId = String(connection?.grant_id || '');
    const eventId = String(booking.nylas_event_id || '');

    if (action === 'cancel' || action === 'cancelar') {
      const reason = cleanText(body.reason || body.cancellationReason, 1000) || 'Cancelada desde panel AllSender.';
      let nylasError: string | null = null;
      let nylasCancelled = false;

      if (grantId && eventId) {
        try {
          await deleteNylasCalendarEvent({ grantId, eventId, calendarId, notifyParticipants: Boolean(booking.customer_email) });
          nylasCancelled = true;
        } catch (error: any) {
          nylasError = error?.message || 'No se pudo cancelar el evento en Nylas.';
        }
      }

      const metadata = nylasError
        ? { nylas_cancelled: false, nylas_error: nylasError }
        : { nylas_cancelled: nylasCancelled, nylas_error: null };

      const result = await db.execute(sql`
        UPDATE reservation_bookings
        SET status = 'cancelled',
            cancellation_reason = ${reason},
            metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb,
            updated_at = now()
        WHERE team_id = ${teamId} AND id = ${id}
        RETURNING *
      `);

      await db.execute(sql`
        UPDATE reservation_reminders
        SET status = 'cancelled',
            metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ cancelled_by: 'reservation_cancelled' })}::jsonb,
            updated_at = now()
        WHERE team_id = ${teamId} AND booking_id = ${id} AND status = 'pending'
      `).catch(() => null);

      let emailWarning: string | null = null;
      if (booking.customer_email) {
        const emailResult = await sendReservationStatusEmail({
          to: String(booking.customer_email),
          customerName: String(booking.customer_name || ''),
          serviceName: String(booking.service_name || 'Reserva'),
          resourceName: String(booking.resource_name || ''),
          startAt: booking.start_at ? new Date(booking.start_at).toISOString() : new Date().toISOString(),
          endAt: booking.end_at ? new Date(booking.end_at).toISOString() : new Date().toISOString(),
          timezone: String(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo'),
          publicUrl: publicUrlFromMetadata(booking),
          calendarSynced: Boolean(eventId),
          status: 'cancelled',
          reason,
        });
        if (!emailResult.ok) emailWarning = `Email: ${emailResult.error}`;
      }

      const chatResult = await sendBookingChatNotification(teamId, booking.chat_id, statusChatMessage({
        type: 'cancelled',
        customerName: String(booking.customer_name || ''),
        serviceName: String(booking.service_name || 'Reserva'),
        startAt: booking.start_at ? new Date(booking.start_at).toISOString() : undefined,
        timezone: String(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo'),
        reason,
      }));
      const chatWarning = chatResult.ok ? null : `Chat: ${chatResult.error}`;

      return NextResponse.json({ ok: true, booking: serialize(rows(result)[0] || {}), warning: [nylasError, emailWarning, chatWarning].filter(Boolean).join(' | ') || null });
    }

    if (action === 'reschedule' || action === 'reprogramar') {
      const newStartAt = validDate(body.startAt ?? body.start_at);
      if (!newStartAt) return NextResponse.json({ error: 'La nueva fecha/hora es obligatoria.' }, { status: 400 });

      const oldStart = booking.start_at ? new Date(booking.start_at) : new Date();
      const oldEnd = booking.end_at ? new Date(booking.end_at) : new Date(oldStart.getTime() + Number(booking.service_duration_minutes || 30) * 60000);
      const duration = minutesBetween(oldStart, oldEnd, Number(booking.service_duration_minutes || 30));
      const newEndAt = new Date(newStartAt.getTime() + duration * 60000);
      const resourceId = booking.resource_id ? Number(booking.resource_id) : null;

      const conflict = await hasConflict(teamId, resourceId, newStartAt, newEndAt, id);
      if (conflict) return NextResponse.json({ error: 'Ese horario ya está ocupado para este recurso.' }, { status: 409 });

      let nextEventId = eventId;
      let nextCalendarId = calendarId;
      let nylasError: string | null = null;

      if (grantId && eventId) {
        try {
          const event = await updateNylasCalendarEvent({
            grantId,
            eventId,
            calendarId,
            title: `${String(booking.service_name || 'Reserva')} - ${String(booking.customer_name || 'Cliente')}`,
            description: eventDescription({
              serviceName: String(booking.service_name || ''),
              resourceName: String(booking.resource_name || ''),
              phone: String(booking.customer_phone || ''),
              email: String(booking.customer_email || ''),
              notes: String(booking.notes || ''),
            }),
            startAt: newStartAt.toISOString(),
            endAt: newEndAt.toISOString(),
            timezone: String(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo'),
            customerEmail: booking.customer_email ? String(booking.customer_email) : null,
            customerName: String(booking.customer_name || ''),
            metadata: {
              allsender_booking_id: id,
              allsender_team_id: teamId,
              allsender_source: String(booking.source_channel || 'manual'),
              allsender_rescheduled: true,
            },
          });
          nextEventId = String(event?.data?.id || event?.id || eventId);
        } catch (error: any) {
          nylasError = error?.message || 'No se pudo reprogramar el evento en Nylas.';
        }
      } else if (grantId) {
        const sync = await syncCreateEvent(
          teamId,
          {
            ...booking,
            start_at: newStartAt.toISOString(),
            end_at: newEndAt.toISOString(),
          },
          connection,
        );
        nextEventId = String(sync.row?.nylas_event_id || '');
        nextCalendarId = String(sync.row?.external_calendar_id || calendarId || 'primary');
        nylasError = sync.error;
      }

      const metadata = nylasError
        ? { nylas_rescheduled: false, nylas_error: nylasError }
        : { nylas_rescheduled: true, nylas_error: null };

      const result = await db.execute(sql`
        UPDATE reservation_bookings
        SET status = 'rescheduled',
            start_at = ${newStartAt.toISOString()}::timestamptz,
            end_at = ${newEndAt.toISOString()}::timestamptz,
            nylas_event_id = ${nextEventId || null},
            external_calendar_id = ${nextCalendarId || null},
            metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb,
            updated_at = now()
        WHERE team_id = ${teamId} AND id = ${id}
        RETURNING *
      `);

      await createOrReplaceEmailReminder(teamId, id, newStartAt, booking.customer_email ? String(booking.customer_email) : null, { source: 'rescheduled_panel' });

      let emailWarning: string | null = null;
      if (booking.customer_email) {
        const emailResult = await sendReservationStatusEmail({
          to: String(booking.customer_email),
          customerName: String(booking.customer_name || ''),
          serviceName: String(booking.service_name || 'Reserva'),
          resourceName: String(booking.resource_name || ''),
          startAt: newStartAt.toISOString(),
          endAt: newEndAt.toISOString(),
          timezone: String(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo'),
          publicUrl: publicUrlFromMetadata(booking),
          calendarSynced: Boolean(nextEventId),
          status: 'rescheduled',
        });
        if (!emailResult.ok) emailWarning = `Email: ${emailResult.error}`;
      }

      const chatResult = await sendBookingChatNotification(teamId, booking.chat_id, statusChatMessage({
        type: 'rescheduled',
        customerName: String(booking.customer_name || ''),
        serviceName: String(booking.service_name || 'Reserva'),
        startAt: newStartAt.toISOString(),
        timezone: String(booking.timezone || booking.resource_timezone || 'America/Santo_Domingo'),
      }));
      const chatWarning = chatResult.ok ? null : `Chat: ${chatResult.error}`;

      return NextResponse.json({ ok: true, booking: serialize(rows(result)[0] || {}), warning: [nylasError, emailWarning, chatWarning].filter(Boolean).join(' | ') || null });
    }

    return NextResponse.json({ error: 'Acción no soportada.' }, { status: 400 });
  } catch (error: any) {
    console.error('[reservas:bookings:patch]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo actualizar la reserva.' }, { status: 500 });
  }
}
