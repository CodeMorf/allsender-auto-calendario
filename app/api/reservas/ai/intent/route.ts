import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';
import { detectReservationIntent } from '@/lib/modules/reservas/intent';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function cleanText(value: unknown, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

async function tableExists(tableName: string) {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${tableName}`}) AS table_name`).catch(() => null);
  return Boolean(rows(result)[0]?.table_name);
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

async function getRecentLogs(teamId: number) {
  if (!(await tableExists('reservation_sync_logs'))) return [];
  const result = await db.execute(sql`
    SELECT id, event_type, status, message, payload, created_at
    FROM reservation_sync_logs
    WHERE team_id = ${teamId}
      AND event_type IN ('reservation_ai.intent_detect.safe', 'reservation_ai.intent_test.safe')
    ORDER BY created_at DESC
    LIMIT 30
  `).catch(() => null);

  return rows(result).map((row) => ({
    id: Number(row.id || 0),
    eventType: String(row.event_type || ''),
    status: String(row.status || ''),
    message: String(row.message || ''),
    payload: row.payload || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

async function logIntent(teamId: number, payload: Record<string, unknown>, message: string) {
  if (!(await tableExists('reservation_sync_logs'))) return;
  await db.execute(sql`
    INSERT INTO reservation_sync_logs (team_id, event_type, status, message, payload, processed_at)
    VALUES (
      ${teamId},
      'reservation_ai.intent_test.safe',
      'received',
      ${message},
      ${JSON.stringify(payload)}::jsonb,
      now()
    )
  `).catch((error) => {
    console.error('[reservas:ai:intent:log]', error);
  });
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const teamId = Number(team.id);
  const [services, logs] = await Promise.all([getActiveServices(teamId), getRecentLogs(teamId)]);
  return NextResponse.json({
    ok: true,
    mode: 'safe_detection_only',
    sendsMessages: false,
    services,
    logs,
  });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = Number(team.id);
    const body = await request.json().catch(() => ({}));
    const message = cleanText(body.message || body.text || body.body, 2000);
    const channel = cleanText(body.channel || 'manual_test', 80);
    const chatId = cleanText(body.chatId || body.chat_id, 80);

    if (!message) {
      return NextResponse.json({ error: 'message es obligatorio.' }, { status: 400 });
    }

    const services = await getActiveServices(teamId);
    const result = detectReservationIntent(message, services);
    const payload = {
      team_id: teamId,
      channel,
      chat_id: chatId || null,
      message,
      result,
      note: 'Modo seguro: no envía respuestas, no toca Chat y no crea reservas automáticamente.',
    };

    await logIntent(teamId, payload, `Intent ${result.intent} → ${result.route} (${Math.round(result.confidence * 100)}%)`);

    return NextResponse.json({
      ok: true,
      mode: 'safe_detection_only',
      sendsMessages: false,
      createsBooking: false,
      result,
    });
  } catch (error: any) {
    console.error('[reservas:ai:intent:post]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo analizar la intención.' }, { status: 500 });
  }
}
