import { ReservasModuleShell } from './components/ReservasModuleShell';
import { getReservasModuleData } from '@/lib/modules/reservas/safe-data';

export const dynamic = 'force-dynamic';

const ALLOWED_TABS = new Set([
  'dashboard',
  'calendario',
  'hoy',
  'servicios',
  'recursos',
  'horarios',
  'conexiones',
  'ajustes',
  'link-publico',
]);

function normalizeTab(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  const tab = typeof raw === 'string' ? raw.trim() : '';
  return ALLOWED_TABS.has(tab) ? tab : 'dashboard';
}

export default async function ReservasIaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const activeTab = normalizeTab(params?.tab);
  const data = await getReservasModuleData();

  return <ReservasModuleShell activeTab={activeTab} data={data} />;
}
