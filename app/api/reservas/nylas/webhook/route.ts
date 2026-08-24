import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';

export const dynamic = 'force-dynamic';

type AnyObject = Record<string, any>;

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function getNylasEventType(payload: AnyObject) {
  return pickString(
    payload?.type,
    payload?.event_type,
    payload?.trigger_type,
    payload?.data?.type,
    payload?.data?.event_type
  ) || 'nylas.webhook';
}

function getNylasGrantId(payload: AnyObject) {
  const object = payload?.data?.object || payload?.object || payload?.data || {};
  return pickString(
    payload?.grant_id,
    payload?.data?.grant_id,
    object?.grant_id,
    object?.grant?.id,
    object?.id && String(getNylasEventType(payload)).startsWith('grant.') ? object?.id : ''
  );
}

function getNylasObjectId(payload: AnyObject) {
  const object = payload?.data?.object || payload?.object || payload?.data || {};
  return pickString(payload?.id, object?.id, payload?.data?.id);
}

export async function GET(request: NextRequest) {
  const challenge = request.nextUrl.searchParams.get('challenge');

  if (challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ ok: true, service: 'allsender-reservas-nylas-webhook' });
}

export async function POST(request: NextRequest) {
  let payload: AnyObject = {};

  try {
    payload = (await request.json()) as AnyObject;
  } catch {
    payload = {};
  }

  const eventType = getNylasEventType(payload);
  const grantId = getNylasGrantId(payload);
  const objectId = getNylasObjectId(payload);

  try {
    const connectionResult = grantId
      ? await db.execute(sql`
          SELECT id, team_id
          FROM reservation_calendar_connections
          WHERE grant_id = ${grantId}
          ORDER BY updated_at DESC
          LIMIT 1
        `)
      : ({ rows: [] } as any);

    const connection = (connectionResult as any)?.rows?.[0];

    if (connection?.team_id) {
      await db.execute(sql`
        INSERT INTO reservation_sync_logs (
          team_id, connection_id, event_type, status, message, payload, processed_at
        ) VALUES (
          ${Number(connection.team_id)},
          ${Number(connection.id)},
          ${eventType},
          ${'received'},
          ${objectId ? `Nylas ${eventType}: ${objectId}` : `Nylas ${eventType}`},
          ${JSON.stringify(payload)}::jsonb,
          now()
        )
      `);

      if (eventType === 'grant.expired' || eventType === 'grant.deleted') {
        await db.execute(sql`
          UPDATE reservation_calendar_connections
          SET status = ${eventType === 'grant.deleted' ? 'disconnected' : 'expired'},
              last_error = ${eventType},
              updated_at = now()
          WHERE id = ${Number(connection.id)}
        `);
      }
    } else {
      console.log('[reservas:nylas:webhook] Evento sin conexión local todavía', {
        eventType,
        grantId,
        objectId,
      });
    }
  } catch (error) {
    console.error('[reservas:nylas:webhook]', error);
    // Nylas solo necesita 200 para no reintentar si el evento no es crítico.
    // El error queda en logs del servidor para diagnóstico.
  }

  return NextResponse.json({ ok: true });
}
