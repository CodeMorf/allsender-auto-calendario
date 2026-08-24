import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id || 0);

    if (id > 0) {
      await db.execute(sql`
        UPDATE reservation_calendar_connections
        SET status = 'disconnected', updated_at = now()
        WHERE team_id = ${Number(team.id)} AND id = ${id}
      `);
    } else {
      await db.execute(sql`
        UPDATE reservation_calendar_connections
        SET status = 'disconnected', updated_at = now()
        WHERE team_id = ${Number(team.id)}
      `);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[reservas:nylas:disconnect]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo desconectar Nylas.' }, { status: 500 });
  }
}
