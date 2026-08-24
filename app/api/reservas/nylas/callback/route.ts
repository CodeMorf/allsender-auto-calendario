import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';
import { decodeNylasState, exchangeNylasCode, getNylasGrantInfo } from '@/lib/modules/reservas/nylas';

export const dynamic = 'force-dynamic';

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || 'https://auth.allsender.tech').replace(/\/$/, '');
}

function redirectBack(params: Record<string, string>) {
  const url = new URL(`${appUrl()}/es/modulo/reservas`);
  url.searchParams.set('tab', 'conexiones');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const team = await getTeamForUser();
  if (!team?.id) return redirectBack({ nylas_error: 'unauthorized' });

  const error = request.nextUrl.searchParams.get('error');
  if (error) return redirectBack({ nylas_error: error });

  const code = request.nextUrl.searchParams.get('code');
  if (!code) return redirectBack({ nylas_error: 'missing_code' });

  const state = decodeNylasState(request.nextUrl.searchParams.get('state'));
  if (state?.teamId && Number(state.teamId) !== Number(team.id)) {
    return redirectBack({ nylas_error: 'invalid_state' });
  }

  try {
    const token = await exchangeNylasCode(code);
    const grantId = String(token.grant_id || '');
    if (!grantId) throw new Error('Nylas no devolvió grant_id.');

    const grant = await getNylasGrantInfo(grantId);
    const grantData = grant?.data || grant || {};
    const email = String(
      token.email ||
      token.email_address ||
      grantData.email ||
      grantData.email_address ||
      grantData.provider_user_id ||
      ''
    );
    const provider = String(grantData.provider || state?.provider || 'nylas');

    await db.execute(sql`
      INSERT INTO reservation_calendar_connections (
        team_id, provider, provider_account_id, grant_id, account_email,
        calendar_id, calendar_name, status, scopes, sync_mode, last_sync_at, metadata, updated_at
      ) VALUES (
        ${Number(team.id)},
        ${provider || 'nylas'},
        ${String(grantData.provider_user_id || '') || null},
        ${grantId},
        ${email || null},
        ${'primary'},
        ${'Calendario principal'},
        ${'connected'},
        ${JSON.stringify(grantData.scopes || [])}::jsonb,
        ${'read_write'},
        now(),
        ${JSON.stringify({ grant: grantData })}::jsonb,
        now()
      )
      ON CONFLICT (team_id, provider, grant_id) DO UPDATE SET
        account_email = EXCLUDED.account_email,
        provider_account_id = EXCLUDED.provider_account_id,
        status = 'connected',
        last_error = NULL,
        last_sync_at = now(),
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `);

    await db.execute(sql`
      INSERT INTO reservation_sync_logs (team_id, event_type, status, message, payload, processed_at)
      VALUES (${Number(team.id)}, 'nylas.connected', 'processed', 'Calendario conectado por Nylas', ${JSON.stringify({ grantId, email, provider })}::jsonb, now())
    `).catch(() => null);

    return redirectBack({ nylas: 'connected' });
  } catch (error: any) {
    console.error('[reservas:nylas:callback]', error);
    return redirectBack({ nylas_error: error?.message || 'callback_failed' });
  }
}
