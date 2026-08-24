import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getTeamModuleAccess } from '@/lib/modules/module-access';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function bool(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return fallback;
  return ['true', 't', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clean(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeTimeFormat(value: unknown): '12h' | '24h' {
  const text = clean(value, 20).toLowerCase();
  return ['24h', '24', 'military', 'h24'].includes(text) ? '24h' : '12h';
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

export type ReservationAgentSettings = {
  isActive: boolean;
  agentName: string;
  requireHumanApproval: boolean;
  canCreateBookings: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  canCreateCalendarEvents: boolean;
  allowedChannels: string[];
  handoffKeywords: string[];
  instructions: string;
  businessName: string;
  businessDescription: string;
  agentPersonality: string;
  bookingPolicy: string;
  closedMessage: string;
  timezone: string;
  timeFormat: '12h' | '24h';
};

export async function getReservationAgentSettings(teamId: number): Promise<ReservationAgentSettings> {
  const result = await db.execute(sql`
    SELECT s.is_active, s.agent_name, s.require_human_approval, s.can_create_bookings,
           s.can_reschedule, s.can_cancel, s.can_create_calendar_events,
           s.allowed_channels, s.handoff_keywords, s.instructions,
           s.business_name, s.business_description, s.agent_personality, s.booking_policy, s.closed_message, s.timezone,
           to_jsonb(s)->>'time_format' AS time_format
    FROM reservation_ai_settings s
    WHERE s.team_id = ${teamId}
    LIMIT 1
  `).catch(() => null);

  const row = rows(result)[0] || {};
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

export async function canRunReservationAgent(teamId: number) {
  const [access, settings] = await Promise.all([
    getTeamModuleAccess(teamId).catch(() => null),
    getReservationAgentSettings(teamId).catch(() => null),
  ]);

  return Boolean(
    access?.isAiEngineActive &&
    access?.isReservasModuleActive &&
    settings?.isActive
  );
}

export async function logReservationAgentEvent(teamId: number, eventType: string, message: string, payload: Record<string, unknown> = {}) {
  await db.execute(sql`
    INSERT INTO reservation_sync_logs (team_id, event_type, status, message, payload, processed_at)
    VALUES (${teamId}, ${eventType}, 'processed', ${message}, ${JSON.stringify(payload)}::jsonb, NOW())
  `).catch(() => null);
}
