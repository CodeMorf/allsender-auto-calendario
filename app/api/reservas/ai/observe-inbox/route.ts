import { NextRequest, NextResponse } from 'next/server';

import { getTeamForUser } from '@/lib/db/queries';
import { getRecentInboxIntentLogs, scanTeamInboxForReservationIntent } from '@/lib/modules/reservas/inbox-observer';

export const dynamic = 'force-dynamic';

function intParam(request: NextRequest, name: string, fallback: number) {
  const value = Number(request.nextUrl.searchParams.get(name));
  return Number.isFinite(value) ? value : fallback;
}

export async function GET(request: NextRequest) {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const teamId = Number(team.id);
  const logs = await getRecentInboxIntentLogs(teamId, intParam(request, 'limit', 30));
  return NextResponse.json({
    ok: true,
    mode: 'observe_inbox_safe',
    sendsMessages: false,
    createsBooking: false,
    logs,
  });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const result = await scanTeamInboxForReservationIntent(Number(team.id), {
      limit: body.limit,
      hours: body.hours,
      dryRun: body.dryRun,
      source: body.source || 'manual_observer',
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    console.error('[reservas:ai:observe-inbox:post]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo observar el inbox.' }, { status: 500 });
  }
}
