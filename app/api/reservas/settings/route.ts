import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';
import { resetTeamConversationFlows } from '@/lib/ai/conversation-mode-reset';
import { assertExclusiveAiModeAvailable } from '@/lib/ai/exclusive-mode-lock';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function clean(value: unknown, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bool(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on', 'si', 'sí'].includes(String(value).toLowerCase());
}

function stringArray(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 80)).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => clean(item, 80)).filter(Boolean);
    } catch {
      return value.split(',').map((item) => clean(item, 80)).filter(Boolean);
    }
  }
  return fallback;
}

function normalizeTimeFormat(value: unknown) {
  const text = clean(value, 20).toLowerCase();
  return ['24h', '24', 'h24', 'military'].includes(text) ? '24h' : '12h';
}


function textArraySql(values: string[]) {
  const safeValues = values.map((item) => clean(item, 80)).filter(Boolean);
  if (!safeValues.length) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(safeValues.map((item) => sql`${item}`), sql`, `)}]::text[]`;
}

async function ensureTimeFormatColumn() {
  await db.execute(sql`
    ALTER TABLE reservation_ai_settings
    ADD COLUMN IF NOT EXISTS time_format text NOT NULL DEFAULT '12h'
  `).catch(() => null);
}

function serialize(row: Row) {
  return {
    isActive: bool(row.is_active, false),
    agentName: clean(row.agent_name, 160) || 'Auto Cita IA',
    requireHumanApproval: bool(row.require_human_approval, false),
    canCreateBookings: bool(row.can_create_bookings, false),
    canReschedule: bool(row.can_reschedule, false),
    canCancel: bool(row.can_cancel, false),
    canCreateCalendarEvents: bool(row.can_create_calendar_events, false),
    allowedChannels: stringArray(row.allowed_channels, ['WhatsApp', 'WebChat', 'Instagram', 'Messenger', 'Facebook']),
    handoffKeywords: stringArray(row.handoff_keywords, ['humano', 'asesor', 'agente', 'ayuda', 'queja', 'urgente']),
    instructions: clean(row.instructions, 3000),
    businessName: clean(row.business_name, 180),
    businessDescription: clean(row.business_description, 3000),
    agentPersonality: clean(row.agent_personality, 2000) || 'Profesional, amable, claro y conversacional. No sonar como bot.',
    bookingPolicy: clean(row.booking_policy, 3000) || 'Confirmar servicio, fecha, hora, nombre y contacto antes de crear la cita.',
    closedMessage: clean(row.closed_message, 1000) || 'Ahora mismo estamos fuera de horario, pero puedo ayudarte a dejar tu solicitud de cita.',
    timezone: clean(row.timezone, 80) || 'America/Santo_Domingo',
    timeFormat: normalizeTimeFormat(row.time_format),
  };
}

export async function GET() {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    await ensureTimeFormatColumn();

    const result = await db.execute(sql`
      SELECT s.*, to_jsonb(s)->>'time_format' AS time_format
      FROM reservation_ai_settings s
      WHERE s.team_id = ${Number(team.id)}
      LIMIT 1
    `).catch(() => null);

    return NextResponse.json({ ok: true, reservationAi: serialize(rows(result)[0] || {}) });
  } catch {
    return NextResponse.json({ error: 'No se pudieron cargar los ajustes en este momento.' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    await ensureTimeFormatColumn();

    const body = await request.json().catch(() => ({}));
    const allowedChannels = stringArray(body.allowedChannels ?? body.allowed_channels, ['WhatsApp', 'WebChat', 'Instagram', 'Messenger', 'Facebook']);
    const handoffKeywords = stringArray(body.handoffKeywords ?? body.handoff_keywords, ['humano', 'asesor', 'agente', 'ayuda', 'queja', 'urgente']);
    const timeFormat = normalizeTimeFormat(body.timeFormat ?? body.time_format);
    const nextActive = bool(body.isActive ?? body.is_active, false);
    const previous = rows(await db.execute(sql`SELECT is_active FROM reservation_ai_settings WHERE team_id = ${Number(team.id)} LIMIT 1`).catch(() => null))[0];
    const wasActive = bool(previous?.is_active, false);
    if (nextActive) {
      await assertExclusiveAiModeAvailable(Number(team.id), 'auto_cita');
    }

    const result = await db.execute(sql`
      INSERT INTO reservation_ai_settings (
        team_id, is_active, agent_name, require_human_approval, can_create_bookings,
        can_reschedule, can_cancel, can_create_calendar_events, allowed_channels,
        handoff_keywords, instructions, business_name, business_description,
        agent_personality, booking_policy, closed_message, timezone, time_format, updated_at
      ) VALUES (
        ${Number(team.id)},
        ${nextActive},
        ${clean(body.agentName ?? body.agent_name, 160) || 'Auto Cita IA'},
        ${bool(body.requireHumanApproval ?? body.require_human_approval, false)},
        ${bool(body.canCreateBookings ?? body.can_create_bookings, false)},
        ${bool(body.canReschedule ?? body.can_reschedule, false)},
        ${bool(body.canCancel ?? body.can_cancel, false)},
        ${bool(body.canCreateCalendarEvents ?? body.can_create_calendar_events, false)},
        ${JSON.stringify(allowedChannels)}::jsonb,
        ${textArraySql(handoffKeywords)},
        ${clean(body.instructions, 3000)},
        ${clean(body.businessName ?? body.business_name, 180)},
        ${clean(body.businessDescription ?? body.business_description, 3000)},
        ${clean(body.agentPersonality ?? body.agent_personality, 2000)},
        ${clean(body.bookingPolicy ?? body.booking_policy, 3000)},
        ${clean(body.closedMessage ?? body.closed_message, 1000)},
        ${clean(body.timezone, 80) || 'America/Santo_Domingo'},
        ${timeFormat},
        NOW()
      )
      ON CONFLICT (team_id) DO UPDATE SET
        is_active = EXCLUDED.is_active,
        agent_name = EXCLUDED.agent_name,
        require_human_approval = EXCLUDED.require_human_approval,
        can_create_bookings = EXCLUDED.can_create_bookings,
        can_reschedule = EXCLUDED.can_reschedule,
        can_cancel = EXCLUDED.can_cancel,
        can_create_calendar_events = EXCLUDED.can_create_calendar_events,
        allowed_channels = EXCLUDED.allowed_channels,
        handoff_keywords = EXCLUDED.handoff_keywords,
        instructions = EXCLUDED.instructions,
        business_name = EXCLUDED.business_name,
        business_description = EXCLUDED.business_description,
        agent_personality = EXCLUDED.agent_personality,
        booking_policy = EXCLUDED.booking_policy,
        closed_message = EXCLUDED.closed_message,
        timezone = EXCLUDED.timezone,
        time_format = EXCLUDED.time_format,
        updated_at = NOW()
      RETURNING *
    `);

    if (nextActive && !wasActive) {
      await resetTeamConversationFlows(Number(team.id), 'auto_cita');
    }

    return NextResponse.json({ ok: true, reservationAi: serialize(rows(result)[0] || {}) });
  } catch (error) {
    console.error('[reservas:settings:put]', error);
    return NextResponse.json({ error: 'No se pudieron guardar los ajustes en este momento.' }, { status: 500 });
  }
}
