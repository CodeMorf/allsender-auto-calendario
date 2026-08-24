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

function serializeService(row: Row) {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    description: String(row.description || ''),
    category: String(row.category || 'General'),
    durationMinutes: Number(row.duration_minutes || 30),
    priceAmount: row.price_amount === null || row.price_amount === undefined ? null : Number(row.price_amount),
    currency: String(row.currency || 'USD'),
    isActive: row.is_active !== false,
  };
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await db.execute(sql`
    SELECT id, name, description, category, duration_minutes, price_amount, currency, is_active
    FROM reservation_services
    WHERE team_id = ${Number(team.id)}
    ORDER BY is_active DESC, name ASC
  `);

  return NextResponse.json({ ok: true, services: rows(result).map(serializeService) });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const name = cleanText(body.name, 180);
    if (!name) return NextResponse.json({ error: 'El nombre del servicio es obligatorio.' }, { status: 400 });

    const durationMinutes = cleanNumber(body.durationMinutes ?? body.duration_minutes, 30, 5, 1440);
    const priceText = cleanText(body.priceAmount ?? body.price_amount, 30);
    const priceAmount = priceText === '' ? null : cleanNumber(priceText, 0, 0, 999999);
    const currency = cleanText(body.currency, 10) || 'USD';

    const result = await db.execute(sql`
      INSERT INTO reservation_services (
        team_id, name, description, category, duration_minutes, price_amount, currency, is_active, updated_at
      ) VALUES (
        ${Number(team.id)},
        ${name},
        ${cleanText(body.description, 2000) || null},
        ${cleanText(body.category, 120) || 'General'},
        ${durationMinutes},
        ${priceAmount},
        ${currency},
        ${body.isActive === false ? false : true},
        now()
      )
      RETURNING id, name, description, category, duration_minutes, price_amount, currency, is_active
    `);

    return NextResponse.json({ ok: true, service: serializeService(rows(result)[0] || {}) });
  } catch (error: any) {
    console.error('[reservas:services:post]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo crear el servicio.' }, { status: 500 });
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
      DELETE FROM reservation_services
      WHERE team_id = ${Number(team.id)} AND id = ${id}
    `);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[reservas:services:delete]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo eliminar el servicio.' }, { status: 500 });
  }
}
