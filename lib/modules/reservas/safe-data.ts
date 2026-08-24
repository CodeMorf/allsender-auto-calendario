import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';
import { getExclusiveAiLockState, type ExclusiveAiLockState } from '@/lib/ai/exclusive-mode-lock';

export type ReservasAiSnapshot = {
  isActive: boolean;
  agentName: string;
  requireHumanApproval: boolean;
  canCreateBookings: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  canCreateCalendarEvents: boolean;
  allowedChannels: string[];
  instructions: string;
  businessName: string;
  businessDescription: string;
  agentPersonality: string;
  bookingPolicy: string;
  closedMessage: string;
  timezone: string;
};

export type ReservasAiProviderSnapshot = {
  isActive: boolean;
  provider: string;
  model: string;
  hasApiKey: boolean;
};

export type ReservasSalesSnapshot = {
  isActive: boolean;
  agentName: string;
};

export type ReservasCountSnapshot = {
  totalBookings: number;
  todayBookings: number;
  pendingBookings: number;
  confirmedBookings: number;
  services: number;
  resources: number;
  connections: number;
  availabilityRules: number;
};

export type ReservasBookingRow = {
  id: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  serviceName: string;
  resourceName: string;
  status: string;
  sourceChannel: string;
  createdByAi: boolean;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  notes: string;
  nylasEventId: string | null;
  externalCalendarId: string | null;
  cancellationReason: string;
  nylasError: string | null;
};

export type ReservasServiceRow = {
  id: number;
  name: string;
  description: string;
  durationMinutes: number;
  priceAmount: number | null;
  currency: string;
  category: string;
  isActive: boolean;
};

export type ReservasResourceRow = {
  id: number;
  name: string;
  resourceType: string;
  email: string;
  capacity: number;
  isActive: boolean;
};

export type ReservasAvailabilityRuleRow = {
  id: number;
  weekday: number;
  startTime: string;
  endTime: string;
  timezone: string;
  serviceId: number | null;
  serviceName: string;
  resourceId: number | null;
  resourceName: string;
  isActive: boolean;
};

export type ReservasConnectionRow = {
  id: number;
  provider: string;
  accountEmail: string;
  status: string;
  calendarName: string;
  lastSyncAt: string | null;
};

export type ReservasModuleData = {
  teamId: number | null;
  hasReservationsTables: boolean;
  exclusiveAiLocks: ExclusiveAiLockState | null;
  aiProvider: ReservasAiProviderSnapshot;
  sales: ReservasSalesSnapshot;
  reservationAi: ReservasAiSnapshot;
  counts: ReservasCountSnapshot;
  bookings: ReservasBookingRow[];
  services: ReservasServiceRow[];
  resources: ReservasResourceRow[];
  availabilityRules: ReservasAvailabilityRuleRow[];
  connections: ReservasConnectionRow[];
  publicLink: string | null;
};

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

function num(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function isFixedLegacyNylasError(value: unknown) {
  const text = String(value ?? '').toLowerCase();
  return text.includes('invalid metadata') || (text.includes('when') && text.includes('invalid keys')) || (text.includes('end_time') && text.includes('multiple of 5'));
}

function asStringArray(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return fallback;
}

async function tableExists(tableName: string) {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${tableName}`}) AS table_name`).catch(() => null);
  return Boolean(rows(result)[0]?.table_name);
}

async function getAiProvider(teamId: number): Promise<ReservasAiProviderSnapshot> {
  const result = await db.execute(sql`
    SELECT is_active, provider, model,
           CASE WHEN NULLIF(api_key, '') IS NULL THEN false ELSE true END AS has_api_key
    FROM ai_configs
    WHERE team_id = ${teamId}
    LIMIT 1
  `).catch(() => null);
  const row = rows(result)[0] || {};
  return {
    isActive: bool(row.is_active, false),
    provider: str(row.provider, 'gemini'),
    model: str(row.model, row.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash'),
    hasApiKey: bool(row.has_api_key, false),
  };
}

async function getSalesSnapshot(teamId: number): Promise<ReservasSalesSnapshot> {
  const result = await db.execute(sql`
    SELECT is_active, agent_name
    FROM ai_sales_settings
    WHERE team_id = ${teamId}
    LIMIT 1
  `).catch(() => null);
  const row = rows(result)[0] || {};
  return {
    isActive: bool(row.is_active, false),
    agentName: str(row.agent_name, 'Ventas IA'),
  };
}

async function getReservationAiSettings(teamId: number, exists: boolean): Promise<ReservasAiSnapshot> {
  const fallback: ReservasAiSnapshot = {
    isActive: false,
    agentName: 'Auto Cita IA',
    requireHumanApproval: false,
    canCreateBookings: false,
    canReschedule: false,
    canCancel: false,
    canCreateCalendarEvents: false,
    allowedChannels: ['WhatsApp', 'WebChat', 'Instagram', 'Messenger', 'Facebook'],
    instructions: 'Actúa como un agente de citas profesional, amable y claro. Haz una pregunta a la vez y confirma antes de crear la reserva.',
    businessName: '',
    businessDescription: '',
    agentPersonality: 'Profesional, amable, claro y conversacional. No sonar como bot.',
    bookingPolicy: 'Confirmar servicio, fecha, hora, nombre y contacto antes de crear la cita.',
    closedMessage: 'Ahora mismo estamos fuera de horario, pero puedo ayudarte a dejar tu solicitud de cita.',
    timezone: 'America/Santo_Domingo',
  };

  if (!exists) return fallback;

  const result = await db.execute(sql`
    SELECT is_active, agent_name, require_human_approval, can_create_bookings,
           can_reschedule, can_cancel, can_create_calendar_events,
           allowed_channels, instructions,
           business_name, business_description, agent_personality, booking_policy, closed_message, timezone
    FROM reservation_ai_settings
    WHERE team_id = ${teamId}
    LIMIT 1
  `).catch(() => null);
  const row = rows(result)[0];
  if (!row) return fallback;

  return {
    isActive: bool(row.is_active, fallback.isActive),
    agentName: str(row.agent_name, fallback.agentName),
    requireHumanApproval: bool(row.require_human_approval, fallback.requireHumanApproval),
    canCreateBookings: bool(row.can_create_bookings, fallback.canCreateBookings),
    canReschedule: bool(row.can_reschedule, fallback.canReschedule),
    canCancel: bool(row.can_cancel, fallback.canCancel),
    canCreateCalendarEvents: bool(row.can_create_calendar_events, fallback.canCreateCalendarEvents),
    allowedChannels: asStringArray(row.allowed_channels, fallback.allowedChannels),
    instructions: str(row.instructions, fallback.instructions),
    businessName: str(row.business_name, fallback.businessName),
    businessDescription: str(row.business_description, fallback.businessDescription),
    agentPersonality: str(row.agent_personality, fallback.agentPersonality),
    bookingPolicy: str(row.booking_policy, fallback.bookingPolicy),
    closedMessage: str(row.closed_message, fallback.closedMessage),
    timezone: str(row.timezone, fallback.timezone),
  };
}

async function getCounts(teamId: number, hasTables: boolean): Promise<ReservasCountSnapshot> {
  const fallback: ReservasCountSnapshot = {
    totalBookings: 0,
    todayBookings: 0,
    pendingBookings: 0,
    confirmedBookings: 0,
    services: 0,
    resources: 0,
    connections: 0,
    availabilityRules: 0,
  };

  if (!hasTables) return fallback;

  const result = await db.execute(sql`
    SELECT
      COALESCE((SELECT COUNT(*)::int FROM reservation_bookings WHERE team_id = ${teamId}), 0) AS total_bookings,
      COALESCE((SELECT COUNT(*)::int FROM reservation_bookings WHERE team_id = ${teamId} AND status NOT IN ('cancelled', 'canceled') AND start_at::date = CURRENT_DATE), 0) AS today_bookings,
      COALESCE((SELECT COUNT(*)::int FROM reservation_bookings WHERE team_id = ${teamId} AND status = 'pending'), 0) AS pending_bookings,
      COALESCE((SELECT COUNT(*)::int FROM reservation_bookings WHERE team_id = ${teamId} AND status = 'confirmed'), 0) AS confirmed_bookings,
      COALESCE((SELECT COUNT(*)::int FROM reservation_services WHERE team_id = ${teamId}), 0) AS services,
      COALESCE((SELECT COUNT(*)::int FROM reservation_resources WHERE team_id = ${teamId}), 0) AS resources,
      COALESCE((SELECT COUNT(*)::int FROM reservation_calendar_connections WHERE team_id = ${teamId}), 0) AS connections,
      COALESCE((SELECT COUNT(*)::int FROM reservation_availability_rules WHERE team_id = ${teamId}), 0) AS availability_rules
  `).catch(() => null);
  const row = rows(result)[0] || {};

  return {
    totalBookings: num(row.total_bookings, 0),
    todayBookings: num(row.today_bookings, 0),
    pendingBookings: num(row.pending_bookings, 0),
    confirmedBookings: num(row.confirmed_bookings, 0),
    services: num(row.services, 0),
    resources: num(row.resources, 0),
    connections: num(row.connections, 0),
    availabilityRules: num(row.availability_rules, 0),
  };
}

async function getBookings(teamId: number, hasTables: boolean): Promise<ReservasBookingRow[]> {
  if (!hasTables) return [];

  const result = await db.execute(sql`
    SELECT b.id, b.customer_name, b.customer_phone, b.customer_email,
           b.status, b.source_channel, b.created_by_ai,
           b.start_at, b.end_at, b.timezone, b.notes,
           b.nylas_event_id, b.external_calendar_id, b.cancellation_reason, b.metadata,
           COALESCE(s.name, '') AS service_name,
           COALESCE(r.name, '') AS resource_name
    FROM reservation_bookings b
    LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
    LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
    WHERE b.team_id = ${teamId}
    ORDER BY
      CASE WHEN b.status IN ('cancelled', 'canceled') THEN 1 ELSE 0 END,
      b.start_at ASC NULLS LAST,
      b.created_at DESC
    LIMIT 120
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    customerName: str(row.customer_name, 'Cliente sin nombre'),
    customerPhone: str(row.customer_phone),
    customerEmail: str(row.customer_email),
    serviceName: str(row.service_name, 'Servicio no definido'),
    resourceName: str(row.resource_name, 'Recurso no definido'),
    status: str(row.status, 'pending'),
    sourceChannel: str(row.source_channel, 'inbox'),
    createdByAi: bool(row.created_by_ai, false),
    startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    timezone: str(row.timezone, 'America/Santo_Domingo'),
    notes: str(row.notes),
    nylasEventId: row.nylas_event_id ? str(row.nylas_event_id) : null,
    externalCalendarId: row.external_calendar_id ? str(row.external_calendar_id) : null,
    cancellationReason: str(row.cancellation_reason),
    nylasError: (!['cancelled', 'canceled'].includes(str(row.status).toLowerCase()) && !row.nylas_event_id && row.metadata?.nylas_error && !isFixedLegacyNylasError(row.metadata.nylas_error)) ? str(row.metadata.nylas_error) : null,
  }));
}

async function getServices(teamId: number, hasTables: boolean): Promise<ReservasServiceRow[]> {
  if (!hasTables) return [];

  const result = await db.execute(sql`
    SELECT id, name, description, duration_minutes, price_amount, currency, category, is_active
    FROM reservation_services
    WHERE team_id = ${teamId}
    ORDER BY is_active DESC, name ASC
    LIMIT 20
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    name: str(row.name, 'Servicio sin nombre'),
    description: str(row.description),
    durationMinutes: num(row.duration_minutes, 30),
    priceAmount: row.price_amount === null || row.price_amount === undefined ? null : num(row.price_amount),
    currency: str(row.currency, 'USD'),
    category: str(row.category, 'General'),
    isActive: bool(row.is_active, true),
  }));
}

async function getResources(teamId: number, hasTables: boolean): Promise<ReservasResourceRow[]> {
  if (!hasTables) return [];

  const result = await db.execute(sql`
    SELECT id, name, resource_type, email, capacity, is_active
    FROM reservation_resources
    WHERE team_id = ${teamId}
    ORDER BY is_active DESC, name ASC
    LIMIT 20
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    name: str(row.name, 'Recurso sin nombre'),
    resourceType: str(row.resource_type, 'empleado'),
    email: str(row.email),
    capacity: num(row.capacity, 1),
    isActive: bool(row.is_active, true),
  }));
}


async function getAvailabilityRules(teamId: number, hasTables: boolean): Promise<ReservasAvailabilityRuleRow[]> {
  if (!hasTables) return [];

  const result = await db.execute(sql`
    SELECT ar.id, ar.weekday, ar.start_time::text AS start_time, ar.end_time::text AS end_time,
           ar.timezone, ar.service_id, ar.resource_id, ar.is_active,
           COALESCE(s.name, 'Todos los servicios') AS service_name,
           COALESCE(r.name, 'Todos los recursos') AS resource_name
    FROM reservation_availability_rules ar
    LEFT JOIN reservation_services s ON s.id = ar.service_id AND s.team_id = ar.team_id
    LEFT JOIN reservation_resources r ON r.id = ar.resource_id AND r.team_id = ar.team_id
    WHERE ar.team_id = ${teamId}
    ORDER BY ar.is_active DESC, ar.weekday ASC, ar.start_time ASC
    LIMIT 80
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    weekday: num(row.weekday, 1),
    startTime: str(row.start_time, '09:00').slice(0, 5),
    endTime: str(row.end_time, '17:00').slice(0, 5),
    timezone: str(row.timezone, 'America/Santo_Domingo'),
    serviceId: row.service_id === null || row.service_id === undefined ? null : num(row.service_id),
    serviceName: str(row.service_name, 'Todos los servicios'),
    resourceId: row.resource_id === null || row.resource_id === undefined ? null : num(row.resource_id),
    resourceName: str(row.resource_name, 'Todos los recursos'),
    isActive: bool(row.is_active, true),
  }));
}

async function getConnections(teamId: number, hasTables: boolean): Promise<ReservasConnectionRow[]> {
  if (!hasTables) return [];

  const result = await db.execute(sql`
    SELECT id, provider, account_email, status, calendar_name, last_sync_at
    FROM reservation_calendar_connections
    WHERE team_id = ${teamId}
    ORDER BY updated_at DESC
    LIMIT 20
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: num(row.id),
    provider: str(row.provider, 'nylas'),
    accountEmail: str(row.account_email),
    status: str(row.status, 'disconnected'),
    calendarName: str(row.calendar_name, 'Calendario principal'),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
  }));
}

async function getPublicLink(teamId: number, hasTables: boolean): Promise<string | null> {
  if (!hasTables) return null;
  const result = await db.execute(sql`
    SELECT slug
    FROM reservation_public_links
    WHERE team_id = ${teamId} AND is_active = true
    ORDER BY created_at DESC
    LIMIT 1
  `).catch(() => null);
  const slug = str(rows(result)[0]?.slug);
  if (!slug) return null;
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || 'https://auth.allsender.tech').replace(/\/$/, '');
  return `${baseUrl}/es/reservar/${slug}`;
}

export async function getReservasModuleData(): Promise<ReservasModuleData> {
  const team = await getTeamForUser();
  if (!team?.id) {
    return {
      teamId: null,
      hasReservationsTables: false,
      exclusiveAiLocks: null,
      aiProvider: { isActive: false, provider: 'gemini', model: 'gemini-2.5-flash', hasApiKey: false },
      sales: { isActive: false, agentName: 'Ventas IA' },
      reservationAi: {
        isActive: false,
        agentName: 'Auto Cita IA',
        requireHumanApproval: false,
        canCreateBookings: false,
        canReschedule: false,
        canCancel: false,
        canCreateCalendarEvents: false,
        allowedChannels: [],
        instructions: '',
        businessName: '',
        businessDescription: '',
        agentPersonality: '',
        bookingPolicy: '',
        closedMessage: '',
        timezone: 'America/Santo_Domingo',
      },
      counts: {
        totalBookings: 0,
        todayBookings: 0,
        pendingBookings: 0,
        confirmedBookings: 0,
        services: 0,
        resources: 0,
        connections: 0,
        availabilityRules: 0,
      },
      bookings: [],
      services: [],
      resources: [],
      availabilityRules: [],
      connections: [],
      publicLink: null,
    };
  }

  const teamId = Number(team.id);
  const [
    hasAiSettings,
    hasBookings,
    hasServices,
    hasResources,
    hasConnections,
    hasAvailabilityRules,
    hasPublicLinks,
    aiProvider,
    sales,
  ] = await Promise.all([
    tableExists('reservation_ai_settings'),
    tableExists('reservation_bookings'),
    tableExists('reservation_services'),
    tableExists('reservation_resources'),
    tableExists('reservation_calendar_connections'),
    tableExists('reservation_availability_rules'),
    tableExists('reservation_public_links'),
    getAiProvider(teamId),
    getSalesSnapshot(teamId),
  ]);

  const hasTables = hasAiSettings && hasBookings && hasServices && hasResources && hasConnections && hasAvailabilityRules && hasPublicLinks;

  const [reservationAi, counts, bookings, services, resources, availabilityRules, connections, publicLink, exclusiveAiLocks] = await Promise.all([
    getReservationAiSettings(teamId, hasAiSettings),
    getCounts(teamId, hasTables),
    getBookings(teamId, hasTables),
    getServices(teamId, hasTables),
    getResources(teamId, hasTables),
    getAvailabilityRules(teamId, hasTables),
    getConnections(teamId, hasTables),
    getPublicLink(teamId, hasTables),
    getExclusiveAiLockState(teamId).catch(() => null),
  ]);

  return {
    teamId,
    hasReservationsTables: hasTables,
    exclusiveAiLocks,
    aiProvider,
    sales,
    reservationAi,
    counts,
    bookings,
    services,
    resources,
    availabilityRules,
    connections,
    publicLink,
  };
}
