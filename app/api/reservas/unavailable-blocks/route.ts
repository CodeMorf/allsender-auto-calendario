import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { getTeamForUser } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const maybe = result as { rows?: Row[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function cleanText(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function optionalId(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown) {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date : null;
}

function serializeBlock(row: Row) {
  return {
    id: Number(row.id || 0),
    title: String(row.title || 'No disponible'),
    reason: String(row.reason || ''),
    resourceId: row.resource_id === null || row.resource_id === undefined ? null : Number(row.resource_id),
    serviceId: row.service_id === null || row.service_id === undefined ? null : Number(row.service_id),
    resourceName: String(row.resource_name || 'Todo el negocio'),
    serviceName: String(row.service_name || 'Todos los servicios'),
    startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    timezone: String(row.timezone || 'America/Santo_Domingo'),
    isActive: row.is_active !== false,
  };
}

export async function GET() {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    const result = await db.execute(sql`
      SELECT b.id, b.title, b.reason, b.resource_id, b.service_id, b.start_at, b.end_at,
             b.timezone, b.is_active,
             COALESCE(r.name, 'Todo el negocio') AS resource_name,
             COALESCE(s.name, 'Todos los servicios') AS service_name
      FROM reservation_unavailable_blocks b
      LEFT JOIN reservation_resources r ON r.id = b.resource_id AND r.team_id = b.team_id
      LEFT JOIN reservation_services s ON s.id = b.service_id AND s.team_id = b.team_id
      WHERE b.team_id = ${Number(team.id)}
      ORDER BY b.is_active DESC, b.start_at ASC
      LIMIT 120
    `);

    return NextResponse.json({ ok: true, blocks: rows(result).map(serializeBlock) });
  } catch (error: any) {
    console.error('[reservas:unavailable-blocks:get]', error);
    return NextResponse.json({ error: 'No se pudo cargar la disponibilidad.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const resourceId = optionalId(body.resourceId ?? body.resource_id);
    const serviceId = optionalId(body.serviceId ?? body.service_id);
    const title = cleanText(body.title, 180) || 'No disponible';
    const reason = cleanText(body.reason, 180) || title;
    const timezone = cleanText(body.timezone, 80) || 'America/Santo_Domingo';
    const startAt = validDate(body.startAt ?? body.start_at);
    const endAt = validDate(body.endAt ?? body.end_at);

    if (!startAt || !endAt) return NextResponse.json({ error: 'Selecciona fecha y hora de inicio y final.' }, { status: 400 });
    if (endAt <= startAt) return NextResponse.json({ error: 'La hora final debe ser mayor que la hora inicial.' }, { status: 400 });

    const result = await db.execute(sql`
      INSERT INTO reservation_unavailable_blocks (
        team_id, resource_id, service_id, title, reason, start_at, end_at, timezone, is_active, metadata, updated_at
      ) VALUES (
        ${Number(team.id)}, ${resourceId}, ${serviceId}, ${title}, ${reason},
        ${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz,
        ${timezone}, ${body.isActive === false ? false : true},
        ${JSON.stringify({ source: 'panel_calendar' })}::jsonb,
        NOW()
      )
      RETURNING id, title, reason, resource_id, service_id, start_at, end_at, timezone, is_active,
                'Todo el negocio'::text AS resource_name,
                'Todos los servicios'::text AS service_name
    `);

    return NextResponse.json({ ok: true, block: serializeBlock(rows(result)[0] || {}) });
  } catch (error: any) {
    console.error('[reservas:unavailable-blocks:post]', error);
    return NextResponse.json({ error: 'No se pudo guardar el bloqueo.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const id = optionalId(body.id);
    if (!id) return NextResponse.json({ error: 'Bloqueo inválido.' }, { status: 400 });

    await db.execute(sql`
      DELETE FROM reservation_unavailable_blocks
      WHERE team_id = ${Number(team.id)} AND id = ${id}
    `);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[reservas:unavailable-blocks:delete]', error);
    return NextResponse.json({ error: 'No se pudo eliminar el bloqueo.' }, { status: 500 });
  }
}
