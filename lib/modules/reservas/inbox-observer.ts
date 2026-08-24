import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { detectReservationIntent } from '@/lib/modules/reservas/intent';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

async function tableExists(tableName: string) {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${tableName}`}) AS table_name`).catch(() => null);
  return Boolean(rows(result)[0]?.table_name);
}

function cleanInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function cleanText(value: unknown, max = 1200) {
  return String(value ?? '').trim().slice(0, max);
}

async function getActiveServices(teamId: number) {
  if (!(await tableExists('reservation_services'))) return [];
  const result = await db.execute(sql`
    SELECT name
    FROM reservation_services
    WHERE team_id = ${teamId} AND is_active = true
    ORDER BY name ASC
    LIMIT 80
  `).catch(() => null);
  return rows(result).map((row) => String(row.name || '').trim()).filter(Boolean);
}

async function alreadyLogged(teamId: number, messageId: string) {
  if (!(await tableExists('reservation_sync_logs'))) return true;
  const result = await db.execute(sql`
    SELECT id
    FROM reservation_sync_logs
    WHERE team_id = ${teamId}
      AND event_type = 'reservation_ai.intent_detect.safe'
      AND payload->>'message_id' = ${messageId}
    LIMIT 1
  `).catch(() => null);
  return rows(result).length > 0;
}

async function insertObservationLog(teamId: number, message: string, payload: Record<string, unknown>) {
  if (!(await tableExists('reservation_sync_logs'))) return false;
  await db.execute(sql`
    INSERT INTO reservation_sync_logs (team_id, event_type, status, message, payload, processed_at)
    VALUES (
      ${teamId},
      'reservation_ai.intent_detect.safe',
      'observed',
      ${message},
      ${JSON.stringify(payload)}::jsonb,
      now()
    )
  `);
  return true;
}

async function loadCandidateMessages(teamId: number, limit: number, hours: number) {
  const result = await db.execute(sql`
    SELECT
      m.id AS message_id,
      m.chat_id,
      m.text,
      m.message_type,
      m.timestamp,
      c.remote_jid,
      c.name AS chat_name,
      c.push_name,
      COALESCE(c.provider, c.source_channel, c.platform, 'unknown') AS provider,
      c.platform,
      c.channel_label
    FROM messages m
    INNER JOIN chats c ON c.id = m.chat_id
    WHERE c.team_id = ${teamId}
      AND COALESCE(m.from_me, false) = false
      AND COALESCE(m.is_internal, false) = false
      AND COALESCE(m.text, '') <> ''
      AND m.timestamp >= now() - (${hours} * interval '1 hour')
    ORDER BY m.timestamp DESC
    LIMIT ${limit}
  `).catch((error) => {
    console.error('[reservas:inbox-observer:load-candidates]', error);
    return null;
  });
  return rows(result);
}

export type InboxObservationOptions = {
  limit?: number;
  hours?: number;
  dryRun?: boolean;
  source?: string;
};

export async function scanTeamInboxForReservationIntent(teamId: number, options: InboxObservationOptions = {}) {
  const limit = cleanInt(options.limit, 60, 1, 150);
  const hours = cleanInt(options.hours, 72, 1, 24 * 14);
  const dryRun = Boolean(options.dryRun);
  const source = cleanText(options.source || 'manual_observer', 80);

  const services = await getActiveServices(teamId);
  const candidates = await loadCandidateMessages(teamId, limit, hours);

  const summary = {
    teamId,
    mode: 'observe_inbox_safe',
    sendsMessages: false,
    createsBooking: false,
    dryRun,
    limit,
    hours,
    candidates: candidates.length,
    logged: 0,
    skippedAlreadyLogged: 0,
    skippedEmpty: 0,
    routes: {
      reservation_ai: 0,
      sales_ai: 0,
      base_ai: 0,
      human_review: 0,
    } as Record<string, number>,
    observations: [] as Array<Record<string, unknown>>,
  };

  for (const row of candidates) {
    const messageId = cleanText(row.message_id, 220);
    const text = cleanText(row.text, 2000);
    if (!messageId || !text) {
      summary.skippedEmpty += 1;
      continue;
    }

    if (!dryRun && await alreadyLogged(teamId, messageId)) {
      summary.skippedAlreadyLogged += 1;
      continue;
    }

    const result = detectReservationIntent(text, services);
    summary.routes[result.route] = (summary.routes[result.route] || 0) + 1;

    const observation = {
      source,
      team_id: teamId,
      message_id: messageId,
      chat_id: row.chat_id ? Number(row.chat_id) : null,
      channel: row.channel_label || row.platform || row.provider || 'unknown',
      provider: row.provider || null,
      remote_jid: row.remote_jid || null,
      customer_name: row.chat_name || row.push_name || null,
      message: text,
      message_type: row.message_type || null,
      message_timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null,
      result,
      note: 'Modo observación real: detecta intención en mensajes reales del inbox, pero no envía respuestas ni crea reservas.',
    };

    if (!dryRun) {
      await insertObservationLog(
        teamId,
        `Inbox ${result.intent} → ${result.route} (${Math.round(result.confidence * 100)}%)`,
        observation
      ).catch((error) => {
        console.error('[reservas:inbox-observer:insert-log]', error);
      });
      summary.logged += 1;
    }

    summary.observations.push(observation);
  }

  return summary;
}

export async function getRecentInboxIntentLogs(teamId: number, limit = 30) {
  if (!(await tableExists('reservation_sync_logs'))) return [];
  const safeLimit = cleanInt(limit, 30, 1, 100);
  const result = await db.execute(sql`
    SELECT id, event_type, status, message, payload, created_at, processed_at
    FROM reservation_sync_logs
    WHERE team_id = ${teamId}
      AND event_type = 'reservation_ai.intent_detect.safe'
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: Number(row.id || 0),
    eventType: String(row.event_type || ''),
    status: String(row.status || ''),
    message: String(row.message || ''),
    payload: row.payload || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
  }));
}
