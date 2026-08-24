import { Link } from '@/i18n/routing';
import {
  Bot,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Home,
  Link2,
  PlugZap,
  UsersRound,
} from 'lucide-react';
import styles from '../reservas.module.css';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Visión general', icon: Home },
  { id: 'calendario', label: 'Calendario', icon: CalendarDays },
  { id: 'hoy', label: 'Hoy', icon: CalendarClock },
  { id: 'servicios', label: 'Servicios', icon: CheckCircle2 },
  { id: 'recursos', label: 'Recursos', icon: UsersRound },
  { id: 'horarios', label: 'Horarios', icon: CalendarClock },
  { id: 'conexiones', label: 'Conexiones', icon: PlugZap },
  { id: 'ajustes', label: 'Ajustes del agente', icon: Bot },
  { id: 'link-publico', label: 'Link público', icon: Link2 },
];

export function ReservasTopNav({ activeTab }: { activeTab: string }) {
  return (
    <nav className={styles.topNav} aria-label="Navegación interna de Auto Cita IA">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id || (!activeTab && item.id === 'dashboard');
        return (
          <Link
            key={item.id}
            href={`/modulo/reservas?tab=${item.id}`}
            className={`${styles.topNavItem} ${isActive ? styles.topNavItemActive : ''}`}
          >
            <Icon size={16} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
