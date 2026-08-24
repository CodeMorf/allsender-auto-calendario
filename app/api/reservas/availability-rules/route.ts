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

function optionalId(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanWeekdays(value: unknown, fallback: number) {
  const source = Array.isArray(value) ? value : [fallback];
  const days = source
    .map((item) => Number(item))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

function cleanTime(value: unknown, fallback: string) {
  const text = cleanText(value, 20);
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function serializeRule(row: Row) {
  return {
    id: Number(row.id),
    weekday: Number(row.weekday),
    startTime: String(row.start_time || '09:00').slice(0, 5),
    endTime: String(row.end_time || '17:00').slice(0, 5),
    timezone: String(row.timezone || 'America/Santo_Domingo'),
    serviceId: row.service_id === null || row.service_id === undefined ? null : Number(row.service_id),
    resourceId: row.resource_id === null || row.resource_id === undefined ? null : Number(row.resource_id),
    serviceName: String(row.service_name || 'Todos los servicios'),
    resourceName: String(row.resource_name || 'Todos los recursos'),
    isActive: row.is_active !== false,
  };
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

  const result = await db.execute(sql`
    SELECT ar.id, ar.weekday, ar.start_time::text AS start_time, ar.end_time::text AS end_time,
           ar.timezone, ar.service_id, ar.resource_id, ar.is_active,
           COALESCE(s.name, 'Todos los servicios') AS service_name,
           COALESCE(r.name, 'Todos los recursos') AS resource_name
    FROM reservation_availability_rules ar
    LEFT JOIN reservation_services s ON s.id = ar.service_id AND s.team_id = ar.team_id
    LEFT JOIN reservation_resources r ON r.id = ar.resource_id AND r.team_id = ar.team_id
    WHERE ar.team_id = ${Number(team.id)}
    ORDER BY ar.is_active DESC, ar.weekday ASC, ar.start_time ASC
  `);

  return NextResponse.json({ ok: true, rules: rows(result).map(serializeRule) });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const weekday = cleanNumber(body.weekday, 1, 0, 6);
    const weekdays = cleanWeekdays(body.weekdays, weekday);
    const startTime = cleanTime(body.startTime ?? body.start_time, '09:00');
    const endTime = cleanTime(body.endTime ?? body.end_time, '17:00');
    const timezone = cleanText(body.timezone, 80) || 'America/Santo_Domingo';
    const serviceId = optionalId(body.serviceId ?? body.service_id);
    const resourceId = optionalId(body.resourceId ?? body.resource_id);

    if (startTime >= endTime) {
      return NextResponse.json({ error: 'La hora final debe ser mayor que la hora inicial.' }, { status: 400 });
    }

    const insertedIds: number[] = [];
    for (const day of weekdays) {
      const result = await db.execute(sql`
        INSERT INTO reservation_availability_rules (
          team_id, service_id, resource_id, weekday, start_time, end_time, timezone, is_active, updated_at
        ) VALUES (
          ${Number(team.id)},
          ${serviceId},
          ${resourceId},
          ${day},
          ${startTime}::time,
          ${endTime}::time,
          ${timezone},
          ${body.isActive === false ? false : true},
          now()
        )
        RETURNING id
      `);
      insertedIds.push(...rows(result).map((row) => Number(row.id)).filter(Boolean));
    }

    const inserted: Row[] = [];
    for (const id of insertedIds) {
      const detail = await db.execute(sql`
        SELECT ar.id, ar.weekday, ar.start_time::text AS start_time, ar.end_time::text AS end_time,
               ar.timezone, ar.service_id, ar.resource_id, ar.is_active,
               COALESCE(s.name, 'Todos los servicios') AS service_name,
               COALESCE(r.name, 'Todos los recursos') AS resource_name
        FROM reservation_availability_rules ar
        LEFT JOIN reservation_services s ON s.id = ar.service_id AND s.team_id = ar.team_id
        LEFT JOIN reservation_resources r ON r.id = ar.resource_id AND r.team_id = ar.team_id
        WHERE ar.team_id = ${Number(team.id)} AND ar.id = ${id}
        LIMIT 1
      `);
      inserted.push(...rows(detail));
    }

    return NextResponse.json({ ok: true, rules: inserted.map(serializeRule), rule: serializeRule(inserted[0] || {}) });
  } catch (error: any) {
    console.error('[reservas:availability-rules:post]', error);
    return NextResponse.json({ error: 'No se pudo guardar el horario.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'No se pudo cargar el equipo activo.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Horario inválido.' }, { status: 400 });

    await db.execute(sql`
      DELETE FROM reservation_availability_rules
      WHERE team_id = ${Number(team.id)} AND id = ${id}
    `);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[reservas:availability-rules:delete]', error);
    return NextResponse.json({ error: 'No se pudo eliminar el horario.' }, { status: 500 });
  }
}
