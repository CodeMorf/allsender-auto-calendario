import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';

export type ReservationConversationStage =
  | 'idle'
  | 'detecting_intent'
  | 'asking_service'
  | 'asking_resource'
  | 'asking_date'
  | 'asking_time'
  | 'asking_customer_name'
  | 'asking_customer_contact'
  | 'confirming_booking'
  | 'booking_created'
  | 'rescheduling'
  | 'cancelling'
  | 'human_handoff_required';

export type ReservationConversationState = {
  id?: number | null;
  teamId: number;
  chatId: number;
  contactId?: number | null;
  currentStage: ReservationConversationStage;
  detectedIntent?: string | null;
  selectedServiceId?: number | null;
  selectedResourceId?: number | null;
  requestedDate?: string | null;
  requestedTime?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  pendingPayload?: Record<string, unknown> | null;
  lastUserMessage?: string | null;
  lastAiMessage?: string | null;
  humanRequired?: boolean;
  metadata?: Record<string, unknown> | null;
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

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown) {
  const clean = String(value ?? '').trim();
  return clean || null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

export async function reservationConversationStateTableExists() {
  const result = await db.execute(sql`SELECT to_regclass('public.reservation_ai_conversation_state') AS table_name`).catch(() => null);
  return Boolean(rows(result)[0]?.table_name);
}

function serialize(row: Row, teamId: number, chatId: number): ReservationConversationState {
  return {
    id: num(row.id),
    teamId,
    chatId,
    contactId: num(row.contact_id),
    currentStage: (text(row.current_stage) || 'idle') as ReservationConversationStage,
    detectedIntent: text(row.detected_intent),
    selectedServiceId: num(row.selected_service_id),
    selectedResourceId: num(row.selected_resource_id),
    requestedDate: text(row.requested_date),
    requestedTime: text(row.requested_time),
    customerName: text(row.customer_name),
    customerPhone: text(row.customer_phone),
    customerEmail: text(row.customer_email),
    pendingPayload: objectValue(row.pending_payload),
    lastUserMessage: text(row.last_user_message),
    lastAiMessage: text(row.last_ai_message),
    humanRequired: bool(row.human_required, false),
    metadata: objectValue(row.metadata),
  };
}

export function emptyReservationConversationState(teamId: number, chatId: number): ReservationConversationState {
  return {
    teamId,
    chatId,
    currentStage: 'idle',
    pendingPayload: {},
    metadata: {},
    humanRequired: false,
  };
}

export async function getReservationConversationState(teamId: number, chatId: number) {
  if (!(await reservationConversationStateTableExists())) return null;
  const result = await db.execute(sql`
    SELECT *
    FROM reservation_ai_conversation_state
    WHERE team_id = ${teamId} AND chat_id = ${chatId}
    LIMIT 1
  `).catch(() => null);
  const row = rows(result)[0];
  return row ? serialize(row, teamId, chatId) : null;
}

export async function saveReservationConversationState(input: ReservationConversationState) {
  if (!(await reservationConversationStateTableExists())) return null;
  const pendingPayload = JSON.stringify(input.pendingPayload || {});
  const metadata = JSON.stringify(input.metadata || {});
  const result = await db.execute(sql`
    INSERT INTO reservation_ai_conversation_state (
      team_id, chat_id, contact_id, current_stage, detected_intent,
      selected_service_id, selected_resource_id, requested_date, requested_time,
      customer_name, customer_phone, customer_email, pending_payload,
      last_user_message, last_ai_message, human_required, metadata, updated_at
    ) VALUES (
      ${input.teamId}, ${input.chatId}, ${input.contactId || null}, ${input.currentStage || 'idle'}, ${input.detectedIntent || null},
      ${input.selectedServiceId || null}, ${input.selectedResourceId || null}, ${input.requestedDate || null}, ${input.requestedTime || null},
      ${input.customerName || null}, ${input.customerPhone || null}, ${input.customerEmail || null}, ${pendingPayload}::jsonb,
      ${input.lastUserMessage || null}, ${input.lastAiMessage || null}, ${Boolean(input.humanRequired)}, ${metadata}::jsonb, NOW()
    )
    ON CONFLICT (team_id, chat_id) DO UPDATE SET
      contact_id = EXCLUDED.contact_id,
      current_stage = EXCLUDED.current_stage,
      detected_intent = EXCLUDED.detected_intent,
      selected_service_id = EXCLUDED.selected_service_id,
      selected_resource_id = EXCLUDED.selected_resource_id,
      requested_date = EXCLUDED.requested_date,
      requested_time = EXCLUDED.requested_time,
      customer_name = EXCLUDED.customer_name,
      customer_phone = EXCLUDED.customer_phone,
      customer_email = EXCLUDED.customer_email,
      pending_payload = EXCLUDED.pending_payload,
      last_user_message = EXCLUDED.last_user_message,
      last_ai_message = EXCLUDED.last_ai_message,
      human_required = EXCLUDED.human_required,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
  `);
  const row = rows(result)[0];
  return row ? serialize(row, input.teamId, input.chatId) : null;
}

export async function resetReservationConversationState(teamId: number, chatId: number, lastUserMessage?: string | null) {
  return saveReservationConversationState({
    ...emptyReservationConversationState(teamId, chatId),
    currentStage: 'idle',
    lastUserMessage: lastUserMessage || null,
  });
}
