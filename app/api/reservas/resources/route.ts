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

function cleanNumber(value: unknown, fallback: number, min = 0, max = 1000000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function serializeResource(row: Row) {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    resourceType: String(row.resource_type || 'empleado'),
    email: String(row.email || ''),
    phone: String(row.phone || ''),
    capacity: Number(row.capacity || 1),
    timezone: String(row.timezone || 'America/Santo_Domingo'),
    isActive: row.is_active !== false,
  };
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await db.execute(sql`
    SELECT id, name, resource_type, email, phone, capacity, timezone, is_active
    FROM reservation_resources
    WHERE team_id = ${Number(team.id)}
    ORDER BY is_active DESC, name ASC
  `);

  return NextResponse.json({ ok: true, resources: rows(result).map(serializeResource) });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const name = cleanText(body.name, 180);
    if (!name) return NextResponse.json({ error: 'El nombre del recurso es obligatorio.' }, { status: 400 });

    const result = await db.execute(sql`
      INSERT INTO reservation_resources (
        team_id, name, resource_type, email, phone, capacity, timezone, is_active, updated_at
      ) VALUES (
        ${Number(team.id)},
        ${name},
        ${cleanText(body.resourceType ?? body.resource_type, 60) || 'empleado'},
        ${cleanText(body.email, 180) || null},
        ${cleanText(body.phone, 80) || null},
        ${cleanNumber(body.capacity, 1, 1, 999)},
        ${cleanText(body.timezone, 80) || 'America/Santo_Domingo'},
        ${body.isActive === false ? false : true},
        now()
      )
      RETURNING id, name, resource_type, email, phone, capacity, timezone, is_active
    `);

    return NextResponse.json({ ok: true, resource: serializeResource(rows(result)[0] || {}) });
  } catch (error: any) {
    console.error('[reservas:resources:post]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo crear el recurso.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 });

    await db.execute(sql`
      DELETE FROM reservation_resources
      WHERE team_id = ${Number(team.id)} AND id = ${id}
    `);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[reservas:resources:delete]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo eliminar el recurso.' }, { status: 500 });
  }
}
