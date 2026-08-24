import { NextRequest, NextResponse } from 'next/server';

import { getTeamForUser } from '@/lib/db/queries';
import { buildNylasOAuthUrl, encodeNylasState } from '@/lib/modules/reservas/nylas';

export const dynamic = 'force-dynamic';

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || 'https://auth.allsender.tech').replace(/\/$/, '');
}

export async function GET(request: NextRequest) {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.redirect(`${appUrl()}/es/login`);

  const provider = request.nextUrl.searchParams.get('provider') || 'google';
  const loginHint = request.nextUrl.searchParams.get('email') || undefined;

  try {
    const state = encodeNylasState({ teamId: Number(team.id), provider });
    const authUrl = buildNylasOAuthUrl({ provider, loginHint, state });
    return NextResponse.redirect(authUrl);
  } catch (error: any) {
    const url = new URL(`${appUrl()}/es/modulo/reservas`);
    url.searchParams.set('tab', 'conexiones');
    url.searchParams.set('nylas_error', error?.message || 'config');
    return NextResponse.redirect(url);
  }
}
