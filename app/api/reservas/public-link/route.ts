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

function cleanText(value: unknown, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || 'https://auth.allsender.tech').replace(/\/$/, '');
}

function serialize(row: Row) {
  const slug = String(row.slug || '');
  return {
    id: Number(row.id || 0),
    slug,
    title: String(row.title || 'Reserva tu cita'),
    isActive: row.is_active !== false,
    url: slug ? `${appUrl()}/es/reservar/${slug}` : null,
  };
}

export async function GET() {
  const team = await getTeamForUser();
  if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await db.execute(sql`
    SELECT id, slug, title, is_active
    FROM reservation_public_links
    WHERE team_id = ${Number(team.id)}
    ORDER BY is_active DESC, created_at DESC
    LIMIT 1
  `);

  return NextResponse.json({ ok: true, link: serialize(rows(result)[0] || {}) });
}

export async function POST(request: NextRequest) {
  try {
    const team = await getTeamForUser();
    if (!team?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const title = cleanText(body.title, 180) || 'Reserva tu cita';
    const requestedSlug = slugify(cleanText(body.slug, 120));

    const existing = await db.execute(sql`
      SELECT id, slug, title, is_active
      FROM reservation_public_links
      WHERE team_id = ${Number(team.id)}
      ORDER BY is_active DESC, created_at DESC
      LIMIT 1
    `);
    const existingRow = rows(existing)[0];
    if (existingRow?.id && !requestedSlug) {
      return NextResponse.json({ ok: true, link: serialize(existingRow) });
    }

    const baseSlug = requestedSlug || `reservas-${Number(team.id)}`;
    let saved: Row | null = null;
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 0 ? '' : `-${Math.random().toString(36).slice(2, 7)}`;
      const slug = `${baseSlug}${suffix}`.slice(0, 110);
      const result = await db.execute(sql`
        INSERT INTO reservation_public_links (team_id, slug, title, is_active, updated_at)
        VALUES (${Number(team.id)}, ${slug}, ${title}, true, now())
        ON CONFLICT (slug) DO NOTHING
        RETURNING id, slug, title, is_active
      `);
      saved = rows(result)[0] || null;
      if (saved) break;
    }

    if (!saved) return NextResponse.json({ error: 'No se pudo crear un slug único.' }, { status: 409 });
    return NextResponse.json({ ok: true, link: serialize(saved) });
  } catch (error: any) {
    console.error('[reservas:public-link:post]', error);
    return NextResponse.json({ error: error?.message || 'No se pudo crear el link público.' }, { status: 500 });
  }
}
