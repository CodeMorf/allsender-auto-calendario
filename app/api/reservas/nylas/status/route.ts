import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';
import { getNylasMissingConfig, getNylasRuntimeConfig } from '@/lib/modules/reservas/nylas';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const config = getNylasRuntimeConfig();
  const missing = getNylasMissingConfig(config);
  const result = await db.execute(sql`
    SELECT id, provider, account_email, calendar_name, status, last_sync_at, last_error
    FROM reservation_calendar_connections
    WHERE team_id = ${Number(team.id)}
    ORDER BY updated_at DESC
  `).catch(() => null);

  return NextResponse.json({
    ok: true,
    enabled: config.enabled && missing.length === 0,
    missing,
    apiUri: config.apiUri,
    callbackUrl: config.callbackUrl,
    connections: rows(result).map((row) => ({
      id: Number(row.id),
      provider: String(row.provider || 'nylas'),
      accountEmail: String(row.account_email || ''),
      calendarName: String(row.calendar_name || 'Calendario principal'),
      status: String(row.status || 'disconnected'),
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
      lastError: String(row.last_error || ''),
    })),
  });
}
