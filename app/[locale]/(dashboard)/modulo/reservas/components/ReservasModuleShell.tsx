'use client';

import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Bot,
  Calendar,
  CalendarClock,
  CalendarDays,
  ExternalLink,
  CheckCircle2,
  Clock3,
  Copy,
  Link2,
  Lock,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { Link } from '@/i18n/routing';
import type { ReservasModuleData, ReservasServiceRow, ReservasResourceRow } from '@/lib/modules/reservas/safe-data';
import styles from '../reservas.module.css';
import { ReservasTopNav } from './ReservasTopNav';
import { ReservasBookingActions } from './ReservasBookingActions';

type Props = {
  activeTab: string;
  data: ReservasModuleData;
};

type StatusState = {
  type: 'success' | 'error' | 'info';
  message: string;
} | null;

function StatusPill({
  children,
  variant = 'neutral',
}: {
  children: ReactNode;
  variant?: 'neutral' | 'success' | 'warning' | 'danger' | 'ai' | 'blue';
}) {
  return <span className={`${styles.pill} ${styles[`pill_${variant}`]}`}>{children}</span>;
}

function EmptyState({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  tone: 'blue' | 'orange' | 'green' | 'purple';
}) {
  return (
    <div className={styles.metricCard}>
      <div className={`${styles.metricIcon} ${styles[`metric_${tone}`]}`}>{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha';
  try {
    return new Intl.DateTimeFormat('es', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return 'Fecha inválida';
  }
}

function bookingStatus(status: string) {
  if (status === 'confirmed') return { label: 'Confirmada', variant: 'success' as const };
  if (status === 'cancelled') return { label: 'Cancelada', variant: 'danger' as const };
  if (status === 'rescheduled') return { label: 'Reprogramada', variant: 'blue' as const };
  return { label: 'Pendiente', variant: 'warning' as const };
}


type BookingFilter = 'active' | 'synced' | 'cancelled' | 'all';

function isCancelledBooking(status: string) {
  return ['cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

function isActiveBooking(status: string) {
  return !isCancelledBooking(status);
}

function filterBookings(bookings: ReservasModuleData['bookings'], filter: BookingFilter) {
  if (filter === 'all') return bookings;
  if (filter === 'cancelled') return bookings.filter((booking) => isCancelledBooking(booking.status));
  if (filter === 'synced') return bookings.filter((booking) => isActiveBooking(booking.status) && Boolean(booking.nylasEventId));
  return bookings.filter((booking) => isActiveBooking(booking.status));
}

function bookingDateKey(value: string | null) {
  if (!value) return 'Sin fecha';
  try {
    return new Intl.DateTimeFormat('es', { dateStyle: 'full' }).format(new Date(value));
  } catch {
    return 'Fecha inválida';
  }
}

function dateKeyInTimezone(value: Date | string, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(value));
    const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return '';
  }
}

function formatTimeOnly(value: string | null) {
  if (!value) return 'Sin hora';
  try {
    return new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
  } catch {
    return 'Hora inválida';
  }
}

function bookingStats(bookings: ReservasModuleData['bookings']) {
  const active = bookings.filter((booking) => isActiveBooking(booking.status));
  const cancelled = bookings.filter((booking) => isCancelledBooking(booking.status));
  const synced = active.filter((booking) => Boolean(booking.nylasEventId));
  const errors = bookings.filter((booking) => isActiveBooking(booking.status) && !booking.nylasEventId && Boolean(booking.nylasError));
  return { active: active.length, cancelled: cancelled.length, synced: synced.length, errors: errors.length, total: bookings.length };
}

function FilterTabs({ value, onChange, bookings }: { value: BookingFilter; onChange: (value: BookingFilter) => void; bookings: ReservasModuleData['bookings'] }) {
  const stats = bookingStats(bookings);
  const items: Array<{ id: BookingFilter; label: string; count: number }> = [
    { id: 'active', label: 'Activas', count: stats.active },
    { id: 'synced', label: 'Sincronizadas', count: stats.synced },
    { id: 'cancelled', label: 'Canceladas', count: stats.cancelled },
    { id: 'all', label: 'Todas', count: stats.total },
  ];
  return (
    <div className={styles.bookingFilterBar}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onChange(item.id)}
          className={`${styles.filterButton} ${value === item.id ? styles.filterButtonActive : ''}`}
        >
          {item.label} <span>{item.count}</span>
        </button>
      ))}
    </div>
  );
}

function GoogleCalendarDayLink({ startAt }: { startAt: string | null }) {
  if (!startAt) return null;
  const date = new Date(startAt);
  if (!Number.isFinite(date.getTime())) return null;
  const url = `https://calendar.google.com/calendar/u/0/r/day/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return (
    <a className={styles.googleLink} href={url} target="_blank" rel="noreferrer">
      <ExternalLink size={14} /> Ver día en Google
    </a>
  );
}

function ActionMessage({ status }: { status: StatusState }) {
  if (!status) return null;
  return <div className={`${styles.messageBox} ${styles[`message_${status.type}`]}`}>{status.message}</div>;
}

async function jsonFetch(url: string, options: RequestInit) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    throw new Error(data?.error || 'No se pudo completar la acción en este momento.');
  }
  return data;
}

function getFormValue(form: HTMLFormElement, name: string) {
  return String(new FormData(form).get(name) || '').trim();
}


type AvailabilityRule = {
  id: number;
  weekday: number;
  startTime: string;
  endTime: string;
  timezone: string;
  serviceId: number | null;
  serviceName: string;
  resourceId: number | null;
  resourceName: string;
  isActive: boolean;
};

type UnavailableBlock = {
  id: number;
  title: string;
  reason: string;
  resourceId: number | null;
  resourceName: string;
  serviceId: number | null;
  serviceName: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  isActive: boolean;
};

const WEEKDAYS = [
  { id: 1, short: 'Lun', label: 'Lunes' },
  { id: 2, short: 'Mar', label: 'Martes' },
  { id: 3, short: 'Mié', label: 'Miércoles' },
  { id: 4, short: 'Jue', label: 'Jueves' },
  { id: 5, short: 'Vie', label: 'Viernes' },
  { id: 6, short: 'Sáb', label: 'Sábado' },
  { id: 0, short: 'Dom', label: 'Domingo' },
];

function weekdayLabel(value: number) {
  return WEEKDAYS.find((day) => day.id === Number(value))?.label || 'Día';
}

function normalizeRuleTime(value: string) {
  return String(value || '').slice(0, 5) || '09:00';
}

function localDateTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function addHoursValue(hours: number) {
  return localDateTimeValue(new Date(Date.now() + hours * 60 * 60 * 1000));
}

function DashboardView({ data }: { data: ReservasModuleData }) {
  return (
    <section className={styles.sectionStack}>
      <div className={styles.heroGrid}>
        <div className={styles.heroCard}>
          <div className={styles.heroBadge}>
            <Sparkles size={16} />
            Auto Cita IA
          </div>
          <h1>Agenda inteligente conectada al inbox, redes sociales y calendario.</h1>
          <p>
            El agente de reservas usa la misma configuración de IA de <strong>/settings/ai</strong>,
            pero con reglas separadas para no mezclar ventas, reservas ni atención general.
          </p>
          <div className={styles.heroActions}>
            <StatusPill variant={data.aiProvider.hasApiKey ? 'success' : 'warning'}>
              Motor IA: {data.aiProvider.hasApiKey ? 'API key configurada' : 'sin API key'}
            </StatusPill>
            <StatusPill variant={data.reservationAi.isActive ? 'ai' : 'neutral'}>
              Auto Cita IA {data.reservationAi.isActive ? 'activa' : 'desactivada'}
            </StatusPill>
            <StatusPill variant={data.hasReservationsTables ? 'success' : 'warning'}>
              Agenda: {data.hasReservationsTables ? 'lista' : 'configuración pendiente'}
            </StatusPill>
          </div>
        </div>

        <div className={styles.routingCard}>
          <h2>Reglas para no interferir</h2>
          <div className={styles.routeList}>
            <div><span>1</span><strong>Ventas IA</strong><p>Productos, pagos, órdenes y LogiHub.</p></div>
            <div><span>2</span><strong>Auto Cita IA</strong><p>Servicios, recursos, horarios, disponibilidad y calendario.</p></div>
            <div><span>3</span><strong>IA general</strong><p>Atención general si no es venta ni reserva.</p></div>
          </div>
        </div>
      </div>


      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div><h2>Regla fuerte de modo unico</h2><p>Auto Cita IA puede usar IA basica para dar seguimiento, pero solo debe manejar citas.</p></div>
          <StatusPill variant="warning">No mezclar modos</StatusPill>
        </div>
        <div className={styles.guardList}>
          <div><strong>Departamento</strong><p>Soporte y enrutamiento con IA basica entrenada. No vender, no agendar.</p></div>
          <div><strong>Auto Cita IA</strong><p>Citas, disponibilidad, reprogramacion, cancelacion y seguimiento.</p></div>
          <div><strong>Ventas IA</strong><p>Productos, objeciones, ordenes, pagos y seguimiento comercial.</p></div>
        </div>
      </div>

      <div className={styles.metricsGrid}>
        <MetricCard icon={<CalendarClock size={26} />} label="Reservas de hoy" value={data.counts.todayBookings} tone="blue" />
        <MetricCard icon={<Clock3 size={26} />} label="Pendientes" value={data.counts.pendingBookings} tone="orange" />
        <MetricCard icon={<CheckCircle2 size={26} />} label="Servicios" value={data.counts.services} tone="green" />
        <MetricCard icon={<UsersRound size={26} />} label="Recursos" value={data.counts.resources} tone="purple" />
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2>Reservas recientes</h2>
            <p>Datos reales del equipo actual. No usamos clientes falsos ni demo.</p>
          </div>
          <StatusPill variant="blue">{data.counts.totalBookings} total</StatusPill>
        </div>

        {data.bookings.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Fecha / hora</th>
                  <th>Cliente</th>
                  <th>Servicio</th>
                  <th>Recurso</th>
                  <th>Canal</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {data.bookings.map((booking) => {
                  const status = bookingStatus(booking.status);
                  return (
                    <tr key={booking.id}>
                      <td>{formatDate(booking.startAt)}</td>
                      <td>{booking.customerName}</td>
                      <td>{booking.serviceName}</td>
                      <td>{booking.resourceName}</td>
                      <td>
                        <span className={styles.inlineBadge}>
                          {booking.sourceChannel}
                          {booking.createdByAi ? <Bot size={13} /> : null}
                        </span>
                      </td>
                      <td><StatusPill variant={status.variant}>{status.label}</StatusPill></td>
                      <td><ReservasBookingActions booking={booking} compact /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<CalendarClock size={36} />}
            title="No hay reservas registradas todavía"
            text="Crea servicios, recursos y luego una reserva manual para validar el flujo interno."
          />
        )}
      </div>
    </section>
  );
}

function CalendarView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<BookingFilter>('active');
  const filteredBookings = filterBookings(data.bookings, filter);
  const stats = bookingStats(data.bookings);
  const [blocks, setBlocks] = useState<UnavailableBlock[]>([]);
  const [blockLoading, setBlockLoading] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/reservas/unavailable-blocks')
      .then((response) => response.json())
      .then((payload) => {
        if (active && Array.isArray(payload?.blocks)) setBlocks(payload.blocks);
      })
      .catch(() => null);
    return () => { active = false; };
  }, []);

  async function createUnavailableBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBlockLoading(true);
    setStatus(null);
    try {
      const result = await jsonFetch('/api/reservas/unavailable-blocks', {
        method: 'POST',
        body: JSON.stringify({
          resourceId: getFormValue(form, 'blockResourceId') || null,
          serviceId: getFormValue(form, 'blockServiceId') || null,
          reason: getFormValue(form, 'blockReason') || 'No disponible',
          title: getFormValue(form, 'blockReason') || 'No disponible',
          startAt: getFormValue(form, 'blockStartAt'),
          endAt: getFormValue(form, 'blockEndAt'),
          timezone: getFormValue(form, 'blockTimezone') || data.reservationAi.timezone || 'America/Santo_Domingo',
        }),
      });
      if (result?.block) setBlocks((current) => [result.block, ...current]);
      setStatus({ type: 'success', message: 'Bloqueo guardado. Auto Cita IA no ofrecerá ese horario.' });
      form.reset();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo guardar el bloqueo.' });
    } finally {
      setBlockLoading(false);
    }
  }

  async function removeUnavailableBlock(block: UnavailableBlock) {
    if (!confirm(`Eliminar bloqueo de ${block.resourceName || 'la agenda'}?`)) return;
    try {
      await jsonFetch('/api/reservas/unavailable-blocks', { method: 'DELETE', body: JSON.stringify({ id: block.id }) });
      setBlocks((current) => current.filter((item) => item.id !== block.id));
      setStatus({ type: 'success', message: 'Bloqueo eliminado correctamente.' });
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo eliminar el bloqueo.' });
    }
  }

  async function createBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setLoading(true);
    setStatus(null);
    try {
      await jsonFetch('/api/reservas/bookings', {
        method: 'POST',
        body: JSON.stringify({
          customerName: getFormValue(form, 'customerName'),
          customerPhone: getFormValue(form, 'customerPhone'),
          customerEmail: getFormValue(form, 'customerEmail'),
          serviceId: getFormValue(form, 'serviceId') || null,
          resourceId: getFormValue(form, 'resourceId') || null,
          startAt: getFormValue(form, 'startAt'),
          status: getFormValue(form, 'status') || 'confirmed',
          sourceChannel: 'manual',
          notes: getFormValue(form, 'notes'),
        }),
      });
      setStatus({ type: 'success', message: 'Reserva creada correctamente. Se intentó sincronizar con Google Calendar si Nylas está conectado.' });
      window.location.href = '/es/modulo/reservas?tab=calendario';
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo crear la reserva.' });
    } finally {
      setLoading(false);
    }
  }

  const grouped = filteredBookings.reduce<Record<string, typeof filteredBookings>>((acc, booking) => {
    const key = bookingDateKey(booking.startAt);
    acc[key] = acc[key] || [];
    acc[key].push(booking);
    return acc;
  }, {});

  const timezone = data.reservationAi.timezone || 'America/Santo_Domingo';
  const todayKey = dateKeyInTimezone(new Date(), timezone);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    const key = dateKeyInTimezone(date, timezone);
    const dayBookings = data.bookings.filter((booking) => dateKeyInTimezone(booking.startAt || '', timezone) === key);
    const label = new Intl.DateTimeFormat('es', { weekday: 'short' }).format(date).replace('.', '');
    return {
      key,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      number: new Intl.DateTimeFormat('es', { day: 'numeric' }).format(date),
      bookings: dayBookings,
    };
  }), [data.bookings, timezone]);

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div>
          <h1>Calendario de reservas</h1>
          <p>Gestión real de citas internas y eventos sincronizados con calendario conectado.</p>
        </div>
        <StatusPill variant={data.connections.length ? 'success' : 'warning'}>
          Calendario: {data.connections.length ? 'conectado' : 'sin conectar'}
        </StatusPill>
      </div>

      <div className={styles.realCalendarCard}>
        <div className={styles.realCalendarHeader}>
          <div>
            <span className={styles.realCalendarKicker}>AGENDA EN TIEMPO REAL</span>
            <h2>Tu semana, clara de un vistazo</h2>
            <p>Consulta tus próximas citas, su estado y la sincronización externa sin perderte en una lista.</p>
          </div>
          <StatusPill variant={data.connections.length ? 'success' : 'warning'}>
            {data.connections.length ? 'Sincronización activa' : 'Agenda interna'}
          </StatusPill>
        </div>
        <div className={styles.realCalendarGrid}>
          {weekDays.map((day) => (
            <div className={`${styles.realCalendarDay} ${day.key === todayKey ? styles.realCalendarDayToday : ''}`} key={day.key}>
              <div className={styles.realCalendarDayTop}>
                <span>{day.label}</span>
                <strong>{day.number}</strong>
              </div>
              <span className={styles.realCalendarDayCount}>{day.bookings.length ? `${day.bookings.length} cita${day.bookings.length === 1 ? '' : 's'}` : 'Libre'}</span>
              <div className={styles.realCalendarDayNames}>
                {day.bookings.slice(0, 2).map((booking) => (
                  <span key={booking.id}><i className={styles.realCalendarDot} />{booking.customerName || 'Cliente'}</span>
                ))}
                {day.bookings.length > 2 ? <small>+{day.bookings.length - 2} más</small> : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.calendarSummaryGrid}>
        <div className={styles.summaryMiniCard}><strong>{stats.active}</strong><span>Activas</span></div>
        <div className={styles.summaryMiniCard}><strong>{stats.synced}</strong><span>Google Calendar</span></div>
        <div className={styles.summaryMiniCard}><strong>{stats.cancelled}</strong><span>Canceladas</span></div>
        <div className={styles.summaryMiniCard}><strong>{stats.errors}</strong><span>Alertas de calendario</span></div>
      </div>

      <div className={styles.calendarLayout}>
        <div className={styles.calendarPanel}>
          <div className={styles.calendarToolbarV2}>
            <FilterTabs value={filter} onChange={setFilter} bookings={data.bookings} />
            <p>Las reservas canceladas quedan ocultas por defecto para mantener la operación limpia.</p>
          </div>

          {filteredBookings.length ? (
            <div className={styles.bookingDateGroups}>
              {Object.entries(grouped).map(([date, bookings]) => (
                <div className={styles.bookingDateGroup} key={date}>
                  <div className={styles.bookingDateHeader}>
                    <CalendarDays size={18} />
                    <strong>{date}</strong>
                    <span>{bookings.length} reserva(s)</span>
                  </div>
                  <div className={styles.bookingCardList}>
                    {bookings.map((booking) => {
                      const statusInfo = bookingStatus(booking.status);
                      const cancelled = isCancelledBooking(booking.status);
                      return (
                        <article className={`${styles.bookingCard} ${cancelled ? styles.bookingCardCancelled : ''}`} key={booking.id}>
                          <div className={styles.bookingTimeBlock}>
                            <strong>{formatTimeOnly(booking.startAt)}</strong>
                            <span>{formatTimeOnly(booking.endAt)}</span>
                          </div>
                          <div className={styles.bookingMainBlock}>
                            <div className={styles.statusRow}>
                              <h3>{booking.customerName || 'Cliente'}</h3>
                              <StatusPill variant={statusInfo.variant}>{statusInfo.label}</StatusPill>
                            </div>
                            <p>{booking.serviceName || 'Servicio no definido'} · {booking.resourceName || 'Recurso no definido'}</p>
                            <div className={styles.bookingMeta}>
                              <span>{booking.sourceChannel || 'manual'}</span>
                              {booking.nylasEventId ? <span className={styles.syncLabel}>Google Calendar sincronizado</span> : <span className={styles.syncLabelMuted}>Sin evento externo</span>}
                              {isActiveBooking(booking.status) && !booking.nylasEventId && booking.nylasError ? <span className={styles.syncLabelMuted}>Alerta calendario</span> : null}
                            </div>
                            {booking.nylasEventId ? <GoogleCalendarDayLink startAt={booking.startAt} /> : null}
                          </div>
                          <div className={styles.bookingActionBlock}>
                            <ReservasBookingActions booking={booking} compact />
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Calendar size={42} />}
              title={filter === 'cancelled' ? 'No hay reservas canceladas' : 'No hay reservas para este filtro'}
              text="Crea una reserva desde el link público o desde el panel para verla aquí."
            />
          )}
        </div>
        <aside className={styles.calendarAside}>
          <h2>Crear reserva manual</h2>
          <p>Guarda la cita en AllSender y crea evento externo si hay calendario conectado.</p>
          <ActionMessage status={status} />
          <form className={styles.formStack} onSubmit={createBooking}>
            <label className={styles.field}>Cliente<input name="customerName" required placeholder="Nombre del cliente" /></label>
            <label className={styles.field}>Teléfono<input name="customerPhone" placeholder="Opcional" /></label>
            <label className={styles.field}>Email<input name="customerEmail" type="email" placeholder="Opcional" /></label>
            <label className={styles.field}>Servicio<select name="serviceId"><option value="">Sin servicio</option>{data.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
            <label className={styles.field}>Recurso<select name="resourceId"><option value="">Sin recurso</option>{data.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
            <label className={styles.field}>Fecha y hora<input name="startAt" type="datetime-local" required /></label>
            <label className={styles.field}>Estado<select name="status" defaultValue="confirmed"><option value="confirmed">Confirmada</option><option value="pending">Pendiente</option></select></label>
            <label className={styles.field}>Notas<textarea name="notes" rows={3} placeholder="Notas internas" /></label>
            <button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Guardando...' : 'Crear reserva'}</button>
          </form>

          <div className={styles.asideDivider} />

          <h2>Marcar no disponible</h2>
          <p>Bloquea horas del negocio completo o de un personal específico. Auto Cita IA no ofrecerá esos espacios.</p>
          <form className={styles.formStack} onSubmit={createUnavailableBlock}>
            <label className={styles.field}>Aplica a
              <select name="blockResourceId" defaultValue="">
                <option value="">Todo el negocio</option>
                {data.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>Servicio
              <select name="blockServiceId" defaultValue="">
                <option value="">Todos los servicios</option>
                {data.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>Motivo
              <select name="blockReason" defaultValue="No disponible">
                <option value="No disponible">No disponible</option>
                <option value="Almuerzo">Almuerzo</option>
                <option value="Reunión">Reunión</option>
                <option value="Día cerrado">Día cerrado</option>
                <option value="Vacaciones">Vacaciones</option>
                <option value="Mantenimiento">Mantenimiento</option>
              </select>
            </label>
            <label className={styles.field}>Desde<input name="blockStartAt" type="datetime-local" required defaultValue={addHoursValue(1)} /></label>
            <label className={styles.field}>Hasta<input name="blockEndAt" type="datetime-local" required defaultValue={addHoursValue(2)} /></label>
            <label className={styles.field}>Zona horaria<input name="blockTimezone" defaultValue={data.reservationAi.timezone || 'America/Santo_Domingo'} /></label>
            <button className={styles.secondaryButton} type="submit" disabled={blockLoading}><Ban size={15} /> {blockLoading ? 'Guardando...' : 'Guardar bloqueo'}</button>
          </form>

          {blocks.length ? (
            <div className={styles.blockList}>
              {blocks.slice(0, 8).map((block) => (
                <div className={styles.blockItem} key={block.id}>
                  <div>
                    <strong>{block.reason || block.title}</strong>
                    <span>{block.resourceName} · {formatDate(block.startAt)} - {formatTimeOnly(block.endAt)}</span>
                  </div>
                  <button className={styles.iconButtonDanger} type="button" onClick={() => removeUnavailableBlock(block)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function TodayView({ data }: { data: ReservasModuleData }) {
  const todayAll = data.bookings.filter((booking) => {
    if (!booking.startAt) return false;
    const bookingDate = new Date(booking.startAt);
    const now = new Date();
    return bookingDate.toDateString() === now.toDateString();
  });
  const today = todayAll.filter((booking) => isActiveBooking(booking.status));
  const cancelledToday = todayAll.length - today.length;

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div>
          <h1>Reservas de hoy</h1>
          <p>Seguimiento operativo de la agenda diaria del equipo. Las canceladas quedan fuera de la cola principal.</p>
        </div>
        <div className={styles.headerStatus}>
          <StatusPill variant="blue">{today.length} activas hoy</StatusPill>
          {cancelledToday ? <StatusPill variant="danger">{cancelledToday} cancelada(s)</StatusPill> : null}
        </div>
      </div>

      <div className={styles.card}>
        {today.length ? (
          <div className={styles.bookingCardList}>
            {today.map((booking) => {
              const status = bookingStatus(booking.status);
              return (
                <article className={styles.bookingCard} key={booking.id}>
                  <div className={styles.bookingTimeBlock}>
                    <strong>{formatTimeOnly(booking.startAt)}</strong>
                    <span>{formatTimeOnly(booking.endAt)}</span>
                  </div>
                  <div className={styles.bookingMainBlock}>
                    <div className={styles.statusRow}>
                      <h3>{booking.customerName || 'Cliente'}</h3>
                      <StatusPill variant={status.variant}>{status.label}</StatusPill>
                    </div>
                    <p>{booking.serviceName} · {booking.resourceName}</p>
                    <div className={styles.bookingMeta}>
                      <span>{booking.sourceChannel}</span>
                      {booking.nylasEventId ? <span className={styles.syncLabel}>Google Calendar sincronizado</span> : <span className={styles.syncLabelMuted}>Sin evento externo</span>}
                    </div>
                    {booking.nylasEventId ? <GoogleCalendarDayLink startAt={booking.startAt} /> : null}
                  </div>
                  <div className={styles.bookingActionBlock}>
                    <ReservasBookingActions booking={booking} compact />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Clock3 size={38} />}
            title="No hay reservas activas para hoy"
            text="El estado vacío es intencional: no usamos datos demo ni clientes inventados."
          />
        )}
      </div>
    </section>
  );
}

function ServiceForm({ onDone }: { onDone: (message: string) => void }) {
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setLoading(true);
    try {
      await jsonFetch('/api/reservas/services', {
        method: 'POST',
        body: JSON.stringify({
          name: getFormValue(form, 'name'),
          description: getFormValue(form, 'description'),
          category: getFormValue(form, 'category'),
          durationMinutes: getFormValue(form, 'durationMinutes'),
          priceAmount: getFormValue(form, 'priceAmount'),
          currency: getFormValue(form, 'currency') || 'USD',
        }),
      });
      onDone('Servicio creado correctamente.');
      window.location.reload();
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <label className={styles.field}>Nombre<input name="name" required placeholder="Ej: Consulta general" /></label>
      <label className={styles.field}>Duración<input name="durationMinutes" type="number" min="5" defaultValue="30" /></label>
      <label className={styles.field}>Precio<input name="priceAmount" type="number" min="0" step="0.01" placeholder="Opcional" /></label>
      <label className={styles.field}>Moneda<input name="currency" defaultValue="USD" /></label>
      <label className={styles.fieldWide}>Categoría<input name="category" placeholder="Ej: Medicina, Salón, Restaurante" /></label>
      <label className={styles.fieldWide}>Descripción<textarea name="description" rows={2} placeholder="Descripción visible para el equipo" /></label>
      <button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Guardando...' : 'Guardar servicio'}</button>
    </form>
  );
}

function ServicesView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);

  async function removeService(service: ReservasServiceRow) {
    if (!confirm(`Eliminar servicio "${service.name}"?`)) return;
    try {
      await jsonFetch('/api/reservas/services', { method: 'DELETE', body: JSON.stringify({ id: service.id }) });
      window.location.reload();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo eliminar.' });
    }
  }

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div><h1>Servicios</h1><p>Servicios que la IA podrá ofrecer para reservar.</p></div>
        <StatusPill variant="blue">{data.services.length} servicios</StatusPill>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}><div><h2>Nuevo servicio</h2><p>Se guarda real por team_id.</p></div></div>
        <ActionMessage status={status} />
        <ServiceForm onDone={(message) => setStatus({ type: 'success', message })} />
      </div>

      <div className={styles.card}>
        {data.services.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Nombre</th><th>Duración</th><th>Precio</th><th>Categoría</th><th>Estado</th><th>Acción</th></tr></thead>
              <tbody>
                {data.services.map((service) => (
                  <tr key={service.id}>
                    <td><strong>{service.name}</strong><small>{service.description}</small></td>
                    <td>{service.durationMinutes} min</td>
                    <td>{service.priceAmount === null ? 'No definido' : `${service.currency} ${service.priceAmount}`}</td>
                    <td>{service.category}</td>
                    <td><StatusPill variant={service.isActive ? 'success' : 'neutral'}>{service.isActive ? 'Activo' : 'Inactivo'}</StatusPill></td>
                    <td><button className={styles.iconButtonDanger} type="button" onClick={() => removeService(service)}><Trash2 size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<CheckCircle2 size={38} />} title="No hay servicios configurados" text="Crea el primer servicio real para este equipo." />
        )}
      </div>
    </section>
  );
}

function ResourceForm({ onDone }: { onDone: (message: string) => void }) {
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setLoading(true);
    try {
      await jsonFetch('/api/reservas/resources', {
        method: 'POST',
        body: JSON.stringify({
          name: getFormValue(form, 'name'),
          resourceType: getFormValue(form, 'resourceType'),
          email: getFormValue(form, 'email'),
          phone: getFormValue(form, 'phone'),
          capacity: getFormValue(form, 'capacity'),
          timezone: getFormValue(form, 'timezone') || 'America/Santo_Domingo',
        }),
      });
      onDone('Recurso creado correctamente.');
      window.location.reload();
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <label className={styles.field}>Nombre<input name="name" required placeholder="Ej: Doctor, Mesa, Sala" /></label>
      <label className={styles.field}>Tipo<select name="resourceType" defaultValue="empleado"><option value="doctor">Doctor</option><option value="mesa">Mesa</option><option value="empleado">Empleado</option><option value="sala">Sala</option><option value="otro">Otro</option></select></label>
      <label className={styles.field}>Email<input name="email" type="email" placeholder="Opcional" /></label>
      <label className={styles.field}>Teléfono<input name="phone" placeholder="Opcional" /></label>
      <label className={styles.field}>Capacidad<input name="capacity" type="number" min="1" defaultValue="1" /></label>
      <label className={styles.field}>Zona horaria<input name="timezone" defaultValue="America/Santo_Domingo" /></label>
      <button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Guardando...' : 'Guardar recurso'}</button>
    </form>
  );
}


function ResourceWorkHoursPanel({ data, onStatus }: { data: ReservasModuleData; onStatus: (status: StatusState) => void }) {
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [loading, setLoading] = useState(false);
  const resourceRules = data.availabilityRules.filter((rule) => rule.resourceId);

  function toggleDay(day: number) {
    setWeekdays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const resourceId = getFormValue(form, 'resourceId');
    if (!resourceId) {
      onStatus({ type: 'error', message: 'Selecciona el personal o recurso antes de guardar el horario.' });
      return;
    }
    setLoading(true);
    try {
      await jsonFetch('/api/reservas/availability-rules', {
        method: 'POST',
        body: JSON.stringify({
          weekdays,
          resourceId,
          serviceId: getFormValue(form, 'serviceId') || null,
          startTime: getFormValue(form, 'startTime') || '09:00',
          endTime: getFormValue(form, 'endTime') || '18:00',
          timezone: getFormValue(form, 'timezone') || data.reservationAi.timezone || 'America/Santo_Domingo',
          isActive: true,
        }),
      });
      onStatus({ type: 'success', message: 'Horario del personal guardado correctamente.' });
      window.location.reload();
    } catch (error: any) {
      onStatus({ type: 'error', message: error?.message || 'No se pudo guardar el horario del personal.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h2>Horarios por personal o recurso</h2>
          <p>Define cuándo trabaja cada persona, doctor, sala o recurso. La IA usará este horario antes de ofrecer citas.</p>
        </div>
        <StatusPill variant={resourceRules.length ? 'success' : 'warning'}>{resourceRules.length ? `${resourceRules.length} horario(s)` : 'Sin horarios por recurso'}</StatusPill>
      </div>
      {data.resources.length ? (
        <form className={styles.formStack} onSubmit={submit}>
          <div className={styles.channelList}>
            {WEEKDAYS.map((day) => (
              <button key={day.id} type="button" className={styles.channelButton} onClick={() => toggleDay(day.id)}>
                <StatusPill variant={weekdays.includes(day.id) ? 'success' : 'neutral'}>{day.short}</StatusPill>
              </button>
            ))}
          </div>
          <div className={styles.inlineForm}>
            <label className={styles.field}>Personal / recurso
              <select name="resourceId" required defaultValue="">
                <option value="">Seleccionar</option>
                {data.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>Servicio
              <select name="serviceId" defaultValue="">
                <option value="">Todos los servicios</option>
                {data.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>Entrada<input name="startTime" type="time" defaultValue="09:00" /></label>
            <label className={styles.field}>Salida<input name="endTime" type="time" defaultValue="18:00" /></label>
            <label className={styles.field}>Zona horaria<input name="timezone" defaultValue={data.reservationAi.timezone || 'America/Santo_Domingo'} /></label>
            <button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Guardando...' : 'Guardar horario del personal'}</button>
          </div>
        </form>
      ) : (
        <EmptyState icon={<UsersRound size={34} />} title="Crea un recurso primero" text="Luego podrás asignarle su horario de trabajo y los servicios que atiende." />
      )}

      {resourceRules.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Personal</th><th>Día</th><th>Horario</th><th>Servicio</th><th>Estado</th></tr></thead>
            <tbody>
              {resourceRules.map((rule) => (
                <tr key={`resource-rule-${rule.id}`}>
                  <td><strong>{rule.resourceName}</strong></td>
                  <td>{weekdayLabel(rule.weekday)}</td>
                  <td>{normalizeRuleTime(rule.startTime)} - {normalizeRuleTime(rule.endTime)}</td>
                  <td>{rule.serviceName}</td>
                  <td><StatusPill variant={rule.isActive ? 'success' : 'neutral'}>{rule.isActive ? 'Disponible' : 'Cerrado'}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ResourcesView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);

  async function removeResource(resource: ReservasResourceRow) {
    if (!confirm(`Eliminar recurso "${resource.name}"?`)) return;
    try {
      await jsonFetch('/api/reservas/resources', { method: 'DELETE', body: JSON.stringify({ id: resource.id }) });
      window.location.reload();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo eliminar.' });
    }
  }

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div><h1>Recursos</h1><p>Doctores, mesas, empleados, salas o recursos reservables.</p></div>
        <StatusPill variant="blue">{data.resources.length} recursos</StatusPill>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}><div><h2>Nuevo recurso</h2><p>Se guarda real por team_id.</p></div></div>
        <ActionMessage status={status} />
        <ResourceForm onDone={(message) => setStatus({ type: 'success', message })} />
      </div>

      <ResourceWorkHoursPanel data={data} onStatus={setStatus} />

      <div className={styles.card}>
        {data.resources.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Nombre</th><th>Tipo</th><th>Email</th><th>Capacidad</th><th>Estado</th><th>Acción</th></tr></thead>
              <tbody>
                {data.resources.map((resource) => (
                  <tr key={resource.id}>
                    <td><strong>{resource.name}</strong></td>
                    <td>{resource.resourceType}</td>
                    <td>{resource.email || 'No definido'}</td>
                    <td>{resource.capacity}</td>
                    <td><StatusPill variant={resource.isActive ? 'success' : 'neutral'}>{resource.isActive ? 'Activo' : 'Inactivo'}</StatusPill></td>
                    <td><button className={styles.iconButtonDanger} type="button" onClick={() => removeResource(resource)}><Trash2 size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<UsersRound size={38} />} title="No hay recursos configurados" text="Cada cliente tendrá sus recursos separados por team_id." />
        )}
      </div>
    </section>
  );
}


function WorkHoursView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<AvailabilityRule[]>(() => (data.availabilityRules || []) as AvailabilityRule[]);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);

  useEffect(() => {
    let active = true;
    fetch('/api/reservas/availability-rules')
      .then((response) => response.json())
      .then((payload) => {
        if (active && Array.isArray(payload?.rules)) setRules(payload.rules);
      })
      .catch(() => null);
    return () => { active = false; };
  }, []);

  function toggleDay(day: number) {
    setWeekdays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setLoading(true);
    setStatus(null);
    try {
      const payload = await jsonFetch('/api/reservas/availability-rules', {
        method: 'POST',
        body: JSON.stringify({
          weekdays,
          startTime: getFormValue(form, 'startTime') || '09:00',
          endTime: getFormValue(form, 'endTime') || '18:00',
          timezone: getFormValue(form, 'timezone') || data.reservationAi.timezone || 'America/Santo_Domingo',
          serviceId: getFormValue(form, 'serviceId') || null,
          resourceId: getFormValue(form, 'resourceId') || null,
          isActive: getFormValue(form, 'isActive') !== 'false',
        }),
      });
      if (Array.isArray(payload?.rules)) setRules((current) => [...payload.rules, ...current]);
      setStatus({ type: 'success', message: 'Horario de trabajo guardado correctamente.' });
      form.reset();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo guardar el horario.' });
    } finally {
      setLoading(false);
    }
  }

  async function removeRule(rule: AvailabilityRule) {
    if (!confirm(`Eliminar horario de ${weekdayLabel(rule.weekday)} ${rule.startTime} - ${rule.endTime}?`)) return;
    try {
      await jsonFetch('/api/reservas/availability-rules', { method: 'DELETE', body: JSON.stringify({ id: rule.id }) });
      setRules((current) => current.filter((item) => item.id !== rule.id));
      setStatus({ type: 'success', message: 'Horario eliminado correctamente.' });
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo eliminar el horario.' });
    }
  }

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div>
          <h1>Horarios de trabajo</h1>
          <p>Define cuándo la agenda está abierta para recibir citas. Auto Cita IA usará estos horarios para ofrecer disponibilidad real.</p>
        </div>
        <StatusPill variant={rules.length ? 'success' : 'warning'}>{rules.length ? `${rules.length} horario(s)` : 'Configurar horarios'}</StatusPill>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2>Agregar horario</h2>
            <p>Ejemplo: lunes a viernes de 09:00 a 18:00 para Consulta para Visa con Doctor Miguel.</p>
          </div>
        </div>
        <ActionMessage status={status} />
        <form className={styles.formStack} onSubmit={submit}>
          <div className={styles.channelList}>
            {WEEKDAYS.map((day) => (
              <button key={day.id} type="button" className={styles.channelButton} onClick={() => toggleDay(day.id)}>
                <StatusPill variant={weekdays.includes(day.id) ? 'success' : 'neutral'}>{day.short}</StatusPill>
              </button>
            ))}
          </div>
          <div className={styles.inlineForm}>
            <label className={styles.field}>Servicio
              <select name="serviceId" defaultValue="">
                <option value="">Todos los servicios</option>
                {data.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>Recurso
              <select name="resourceId" defaultValue="">
                <option value="">Todos los recursos</option>
                {data.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>Abre<input name="startTime" type="time" defaultValue="09:00" /></label>
            <label className={styles.field}>Cierra<input name="endTime" type="time" defaultValue="18:00" /></label>
            <label className={styles.field}>Zona horaria<input name="timezone" defaultValue={data.reservationAi.timezone || 'America/Santo_Domingo'} /></label>
            <label className={styles.field}>Estado<select name="isActive" defaultValue="true"><option value="true">Abierto</option><option value="false">Cerrado temporalmente</option></select></label>
            <button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Guardando...' : 'Guardar horario'}</button>
          </div>
        </form>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div><h2>Horarios configurados</h2><p>Auto Cita IA solo ofrecerá citas dentro de los horarios abiertos.</p></div>
        </div>
        {rules.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Día</th><th>Horario</th><th>Servicio</th><th>Recurso</th><th>Zona</th><th>Estado</th><th>Acción</th></tr></thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td><strong>{weekdayLabel(rule.weekday)}</strong></td>
                    <td>{normalizeRuleTime(rule.startTime)} - {normalizeRuleTime(rule.endTime)}</td>
                    <td>{rule.serviceName}</td>
                    <td>{rule.resourceName}</td>
                    <td>{rule.timezone}</td>
                    <td><StatusPill variant={rule.isActive ? 'success' : 'neutral'}>{rule.isActive ? 'Abierto' : 'Cerrado'}</StatusPill></td>
                    <td><button className={styles.iconButtonDanger} type="button" onClick={() => removeRule(rule)}><Trash2 size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Clock3 size={38} />} title="No hay horarios configurados" text="Agrega tus horarios de trabajo para que Auto Cita IA pueda ofrecer citas disponibles." />
        )}
      </div>
    </section>
  );
}

function ConnectionsView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);
  const items = [
    { name: 'Google Calendar', provider: 'google', service: 'calendar', desc: 'Sincronizar disponibilidad y crear eventos.' },
    { name: 'Outlook Calendar', provider: 'microsoft', service: 'calendar', desc: 'Conectar Microsoft 365 y calendarios corporativos.' },
    { name: 'Gmail', provider: 'google', service: 'email', desc: 'Enviar confirmaciones y recordatorios por correo.' },
    { name: 'Contactos', provider: 'google', service: 'contacts', desc: 'Reconocer clientes recurrentes desde contactos.' },
  ];

  const connectedConnections = data.connections.filter((connection) => connection.status === 'connected');

  function providerMatches(connectionProvider: string, expectedProvider: string) {
    const normalizedProvider = String(connectionProvider || '').toLowerCase();
    if (expectedProvider === 'google') return normalizedProvider === 'google' || normalizedProvider === 'gmail';
    if (expectedProvider === 'microsoft') return normalizedProvider === 'microsoft' || normalizedProvider === 'outlook' || normalizedProvider === 'office365';
    return normalizedProvider === expectedProvider;
  }

  async function disconnect(id?: number) {
    try {
      await jsonFetch('/api/reservas/nylas/disconnect', { method: 'POST', body: JSON.stringify({ id }) });
      setStatus({ type: 'success', message: 'Conexión marcada como desconectada.' });
      window.location.reload();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo desconectar.' });
    }
  }

  return (
    <section className={styles.sectionStack}>
      <div className={styles.nylasCard}>
        <div className={styles.nylasIcon}><PlugZap size={28} /></div>
        <div>
          <h1>Conexiones de calendario</h1>
          <p>Conecta calendarios externos para sincronizar disponibilidad, eventos, email y contactos desde AllSender.</p>
          <div className={styles.heroActions}>
            <StatusPill variant="blue">White-label desde AllSender</StatusPill>
            <StatusPill variant={data.connections.length ? 'success' : 'warning'}>{data.connections.length ? `${data.connections.length} conexión(es)` : 'sin conexiones'}</StatusPill>
          </div>
          <p className={styles.note}>Una conexión Google puede habilitar Google Calendar, Gmail y Contactos. Outlook solo aparece conectado cuando exista una cuenta Microsoft conectada.</p>
          <ActionMessage status={status} />
        </div>
      </div>

      <div className={styles.connectionGrid}>
        {items.map((item) => {
          const connected = connectedConnections.find((connection) => providerMatches(connection.provider, item.provider));
          const statusText = connected
            ? item.provider === 'google'
              ? 'Conectado por Google'
              : 'Conectado por Microsoft'
            : 'Desconectado';
          return (
            <div className={styles.connectionCard} key={`${item.provider}-${item.service}`}>
              <div>
                <div className={styles.connectionIcon}><CalendarDays size={24} /></div>
                <h2>{item.name}</h2>
                <p>{item.desc}</p>
                {connected ? <p className={styles.note}>Cuenta: {connected.accountEmail || 'conectada'}</p> : null}
              </div>
              <div className={styles.buttonRow}>
                <StatusPill variant={connected ? 'success' : 'neutral'}>{statusText}</StatusPill>
                <a className={styles.secondaryButton} href={`/api/reservas/nylas/connect?provider=${item.provider}`}>{connected ? 'Reconectar' : 'Conectar'}</a>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div><h2>Cuentas conectadas</h2><p>Se guarda grant_id por team_id. No se muestran tokens ni claves en la UI.</p></div>
        </div>
        {data.connections.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Proveedor</th><th>Cuenta</th><th>Calendario</th><th>Última sincronización</th><th>Estado</th><th>Acción</th></tr></thead>
              <tbody>
                {data.connections.map((connection) => (
                  <tr key={connection.id}>
                    <td>{connection.provider}</td>
                    <td>{connection.accountEmail || 'Cuenta conectada'}</td>
                    <td>{connection.calendarName}</td>
                    <td>{formatDate(connection.lastSyncAt)}</td>
                    <td><StatusPill variant={connection.status === 'connected' ? 'success' : 'warning'}>{connection.status}</StatusPill></td>
                    <td><button className={styles.dangerButton} type="button" onClick={() => disconnect(connection.id)}>Desconectar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<PlugZap size={38} />} title="Calendario externo no conectado todavía" text="Puedes continuar con la agenda interna. Conecta un calendario externo cuando quieras sincronizar eventos automáticamente." />
        )}
      </div>
    </section>
  );
}

function SettingsView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<any>({ ...data.reservationAi, timeFormat: (data.reservationAi as any).timeFormat || '12h' });
  const channels = ['WhatsApp', 'WebChat', 'Instagram', 'Messenger', 'Facebook', 'Zernio / Meta'];
  const autoCitaLock = data.exclusiveAiLocks?.modes?.auto_cita || null;
  const autoCitaLocked = Boolean(autoCitaLock?.locked);

  useEffect(() => {
    let mounted = true;
    jsonFetch('/api/reservas/settings', {})
      .then((result) => {
        if (!mounted || !result?.reservationAi) return;
        setState((current: any) => ({ ...current, ...result.reservationAi, timeFormat: result.reservationAi.timeFormat || current.timeFormat || '12h' }));
      })
      .catch(() => null);
    return () => { mounted = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setStatus(null);
    try {
      await jsonFetch('/api/reservas/settings', { method: 'PUT', body: JSON.stringify(state) });
      setStatus({ type: 'success', message: 'Ajustes guardados correctamente.' });
      window.location.reload();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo guardar.' });
    } finally {
      setLoading(false);
    }
  }

  function toggleChannel(channel: string) {
    setState((current: any) => ({
      ...current,
      allowedChannels: current.allowedChannels.includes(channel)
        ? current.allowedChannels.filter((item: string) => item !== channel)
        : [...current.allowedChannels, channel],
    }));
  }

  type ReservationAiBooleanKey = 'isActive' | 'canCreateBookings' | 'requireHumanApproval' | 'canReschedule' | 'canCancel' | 'canCreateCalendarEvents';
  const toggleKeys: Array<[ReservationAiBooleanKey, string]> = [
    ['isActive', 'Activar Auto Cita IA'],
    ['canCreateBookings', 'Crear reservas'],
    ['canReschedule', 'Reprogramar automáticamente'],
    ['canCancel', 'Cancelar automáticamente'],
    ['canCreateCalendarEvents', 'Crear evento en calendario conectado'],
  ];

  const confirmationMode = state.requireHumanApproval ? 'human' : 'automatic';
  const confirmationSummary = state.requireHumanApproval
    ? 'La IA toma la solicitud, confirma los datos y la deja pendiente para que tu equipo apruebe la cita final.'
    : 'La IA confirma la cita cuando el cliente acepta los datos, crea el evento en calendario conectado y avisa al cliente.';

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div><h1>Ajustes del agente de citas</h1><p>Usa el motor IA global de AllSender, pero con reglas y permisos propios para gestionar citas.</p></div>
        <StatusPill variant={data.aiProvider.hasApiKey ? 'success' : 'warning'}>{data.aiProvider.provider} / {data.aiProvider.model}</StatusPill>
      </div>


      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div><h2>Activacion segura de Auto Cita IA</h2><p>Al activar este agente, AllSender reinicia los flujos abiertos para que una conversacion vieja no mezcle ventas, soporte y citas.</p></div>
          <StatusPill variant="warning">Una conversacion = un modo</StatusPill>
        </div>
        <div className={styles.guardList}>
          <div><strong>Auto Cita IA</strong><p>Puede dar seguimiento al usuario sobre su cita y confirmar datos de agenda.</p></div>
          <div><strong>No ventas</strong><p>No debe pedir producto, direccion, metodo de pago ni datos de orden.</p></div>
          <div><strong>No departamento humano</strong><p>Si un humano toma control, la IA queda pausada para ese chat.</p></div>
        </div>
      </div>

      <form className={styles.settingsGrid} onSubmit={submit}>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div><h2>Agente de reservas</h2><p>Estos ajustes controlan cómo atiende el agente de citas.</p></div>
            <StatusPill variant={state.isActive ? 'ai' : 'neutral'}>{state.isActive ? 'Activo' : 'Inactivo'}</StatusPill>
          </div>
          <ActionMessage status={status} />
          {autoCitaLocked ? (
            <div className={`${styles.messageBox} ${styles.message_info}`}>
              <strong><Lock size={14} /> Auto Cita IA bloqueada:</strong> {autoCitaLock?.lockMessage || 'Otro modo IA esta activo.'}
            </div>
          ) : null}
          <div className={styles.formStack}>
            <label className={styles.field}>Nombre del agente<input value={state.agentName} onChange={(e) => setState((s: any) => ({ ...s, agentName: e.target.value }))} placeholder="Ej: Laura, asistente de citas" /></label>
            <label className={styles.field}>Nombre de la empresa<input value={state.businessName || ''} onChange={(e) => setState((s: any) => ({ ...s, businessName: e.target.value }))} placeholder="Ej: Visa Consult RD" /></label>
            <label className={styles.fieldWide}>¿De qué trata la empresa?<textarea rows={3} value={state.businessDescription || ''} onChange={(e) => setState((s: any) => ({ ...s, businessDescription: e.target.value }))} placeholder="Ej: Agencia que asesora solicitudes de visa, renovación de pasaporte y trámites migratorios." /></label>
            <label className={styles.fieldWide}>Cómo debe actuar el agente<textarea rows={4} value={state.agentPersonality || ''} onChange={(e) => setState((s: any) => ({ ...s, agentPersonality: e.target.value }))} placeholder="Ej: Profesional, amable, breve, una pregunta a la vez, siempre confirma datos antes de agendar." /></label>
            <label className={styles.fieldWide}>Reglas de reserva<textarea rows={4} value={state.bookingPolicy || ''} onChange={(e) => setState((s: any) => ({ ...s, bookingPolicy: e.target.value }))} placeholder="Ej: Pedir nombre completo, teléfono, correo y servicio. No prometer disponibilidad fuera del horario configurado." /></label>
            <label className={styles.fieldWide}>Mensaje fuera de horario<textarea rows={3} value={state.closedMessage || ''} onChange={(e) => setState((s: any) => ({ ...s, closedMessage: e.target.value }))} placeholder="Ej: Estamos fuera de horario, pero puedo tomar tus datos para gestionar la cita." /></label>
            <label className={styles.field}>Zona horaria<input value={state.timezone || 'America/Santo_Domingo'} onChange={(e) => setState((s: any) => ({ ...s, timezone: e.target.value }))} /></label>
            <div className={styles.fieldWide}>
              <span>Formato de hora</span>
              <div className={styles.timeFormatOptions}>
                <button
                  type="button"
                  className={`${styles.timeFormatOption} ${(state.timeFormat || '12h') === '12h' ? styles.timeFormatOptionActive : ''}`}
                  onClick={() => setState((s: any) => ({ ...s, timeFormat: '12h' }))}
                >
                  <Clock3 size={18} />
                  <strong>12 horas</strong>
                  <small>10:00 a. m. / 3:00 p. m.</small>
                </button>
                <button
                  type="button"
                  className={`${styles.timeFormatOption} ${state.timeFormat === '24h' ? styles.timeFormatOptionActive : ''}`}
                  onClick={() => setState((s: any) => ({ ...s, timeFormat: '24h' }))}
                >
                  <Clock3 size={18} />
                  <strong>24 horas</strong>
                  <small>10:00 / 15:00 / 23:00</small>
                </button>
              </div>
            </div>
            <label className={styles.fieldWide}>Instrucciones adicionales<textarea rows={4} value={state.instructions} onChange={(e) => setState((s: any) => ({ ...s, instructions: e.target.value }))} placeholder="Notas internas para el agente de citas." /></label>
          </div>
          <div className={styles.confirmationModeBox}>
            <div className={styles.confirmationHeader}>
              <div>
                <h3>Modo de confirmación</h3>
                <p>Define si Auto Cita IA confirma la cita completa o si deja la solicitud para revisión del equipo.</p>
              </div>
              <StatusPill variant={state.requireHumanApproval ? 'warning' : 'success'}>
                {state.requireHumanApproval ? 'Revisión humana' : 'Confirmación automática'}
              </StatusPill>
            </div>

            <div className={styles.confirmationOptions}>
              <button
                type="button"
                className={`${styles.confirmationOption} ${confirmationMode === 'automatic' ? styles.confirmationOptionActive : ''}`}
                onClick={() => setState((current: any) => ({ ...current, requireHumanApproval: false }))}
              >
                <div className={styles.confirmationOptionIcon}><CheckCircle2 size={22} /></div>
                <div>
                  <strong>Confirmación automática</strong>
                  <span>La IA confirma cuando el cliente responde “sí”, crea el evento en el calendario y envía la confirmación.</span>
                </div>
              </button>

              <button
                type="button"
                className={`${styles.confirmationOption} ${confirmationMode === 'human' ? styles.confirmationOptionActive : ''}`}
                onClick={() => setState((current: any) => ({ ...current, requireHumanApproval: true }))}
              >
                <div className={styles.confirmationOptionIcon}><UsersRound size={22} /></div>
                <div>
                  <strong>Revisión humana</strong>
                  <span>La IA recibe la solicitud y tu equipo confirma antes de crear la cita final en el calendario.</span>
                </div>
              </button>
            </div>

            <div className={styles.confirmationFlowSummary}>
              <strong>Flujo activo:</strong> {confirmationSummary}
            </div>
          </div>

          <div className={styles.toggleList}>
            {toggleKeys.map(([key, label]) => (
              <button
                className={styles.toggleRow}
                type="button"
                key={String(key)}
                disabled={key === 'isActive' && autoCitaLocked}
                onClick={() => {
                  if (key === 'isActive' && autoCitaLocked) return;
                  setState((current: any) => ({ ...current, [key]: !current[key] }));
                }}
              >
                <span>{key === 'isActive' && autoCitaLocked ? <><Lock size={14} /> Auto Cita IA bloqueada</> : label}</span>
                <span className={`${styles.switch} ${state[key] ? styles.switchOn : ''}`} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className={styles.formActions}><button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Guardando...' : 'Guardar ajustes'}</button></div>
        </div>

        <div className={styles.card}>
          <h2>Canales permitidos</h2>
          <p className={styles.note}>Selecciona dónde puede actuar el agente de reservas.</p>
          <div className={styles.channelList}>
            {channels.map((channel) => (
              <button key={channel} type="button" onClick={() => toggleChannel(channel)} className={styles.channelButton}>
                <StatusPill variant={state.allowedChannels.includes(channel) ? 'success' : 'neutral'}>{channel}</StatusPill>
              </button>
            ))}
          </div>
          <div className={styles.guardList}>
            <div><strong>Ventas IA</strong><p>Solo catálogo, productos, pagos, órdenes y envío.</p></div>
            <div><strong>Auto Cita IA</strong><p>Solo servicios, recursos, horarios, disponibilidad y calendario.</p></div>
            <div><strong>IA general</strong><p>Atención general cuando no sea venta ni reserva.</p></div>
          </div>
        </div>
      </form>
    </section>
  );
}

function PublicLinkView({ data }: { data: ReservasModuleData }) {
  const [status, setStatus] = useState<StatusState>(null);
  const [loading, setLoading] = useState(false);
  const defaultSlug = useMemo(() => (data.teamId ? `reservas-${data.teamId}` : 'reservas'), [data.teamId]);
  const [copied, setCopied] = useState(false);

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setLoading(true);
    setStatus(null);
    try {
      const result = await jsonFetch('/api/reservas/public-link', {
        method: 'POST',
        body: JSON.stringify({ title: getFormValue(form, 'title'), slug: getFormValue(form, 'slug') }),
      });
      setStatus({ type: 'success', message: `Link creado: ${result.link?.url || ''}` });
      window.location.reload();
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'No se pudo crear el link.' });
    } finally {
      setLoading(false);
    }
  }

  async function copyPublicLink() {
    if (!data.publicLink) return;
    try {
      await navigator.clipboard.writeText(data.publicLink);
      setCopied(true);
      setStatus({ type: 'success', message: 'Link copiado al portapapeles.' });
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setStatus({ type: 'info', message: data.publicLink });
    }
  }

  return (
    <section className={styles.sectionStack}>
      <div className={styles.cardHeaderBlock}>
        <div><h1>Link público de reserva</h1><p>Para que clientes puedan reservar desde web, redes o campañas.</p></div>
        <StatusPill variant={data.publicLink ? 'success' : 'warning'}>{data.publicLink ? 'Activo' : 'Pendiente'}</StatusPill>
      </div>

      <div className={styles.publicLinkCard}>
        <Link2 size={32} />
        <h2>{data.publicLink || 'Aún no hay link público creado'}</h2>
        <p>El link abre una página pública segura que lee servicios y recursos reales del equipo.</p>
        {data.publicLink ? (
          <div className={styles.publicLinkActions}>
            <a className={styles.secondaryButton} href={data.publicLink} target="_blank" rel="noreferrer">Abrir link</a>
            <button className={styles.secondaryButton} type="button" onClick={copyPublicLink}>
              <Copy size={16} /> {copied ? 'Copiado' : 'Copiar link'}
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}><div><h2>Crear link</h2><p>No sobrescribe si ya existe un link activo para el equipo.</p></div></div>
        <ActionMessage status={status} />
        <form className={styles.inlineForm} onSubmit={createLink}>
          <label className={styles.field}>Título<input name="title" defaultValue="Reserva tu cita" /></label>
          <label className={styles.field}>Slug<input name="slug" defaultValue={defaultSlug} /></label>
          <button className={styles.primaryButton} type="submit" disabled={loading}>{loading ? 'Creando...' : 'Crear link público'}</button>
        </form>
      </div>
    </section>
  );
}

function MissingTeamView() {
  return (
    <div className={styles.pageWrap}>
      <div className={styles.alertBox}>No se pudo cargar el equipo activo. Vuelve a iniciar sesión.</div>
    </div>
  );
}

export function ReservasModuleShell({ activeTab, data }: Props) {
  if (!data.teamId) return <MissingTeamView />;

  const content = (() => {
    switch (activeTab) {
      case 'calendario': return <CalendarView data={data} />;
      case 'hoy': return <TodayView data={data} />;
      case 'servicios': return <ServicesView data={data} />;
      case 'recursos': return <ResourcesView data={data} />;
      case 'horarios': return <WorkHoursView data={data} />;
      case 'conexiones': return <ConnectionsView data={data} />;
      case 'ajustes': return <SettingsView data={data} />;
      case 'link-publico': return <PublicLinkView data={data} />;
      default: return <DashboardView data={data} />;
    }
  })();

  return (
    <div className={styles.pageWrap}>
      <div className={styles.moduleShell}>
        <header className={styles.moduleHeader}>
          <div>
            <span className={styles.kicker}>Módulo</span>
            <h1>Auto Cita IA</h1>
            <p>Agenda inteligente conectada al inbox, redes sociales y calendario.</p>
          </div>
          <div className={styles.headerStatus}>
            <StatusPill variant={data.sales.isActive ? 'success' : 'neutral'}>Ventas IA separada</StatusPill>
            <StatusPill variant={data.aiProvider.isActive ? 'ai' : 'neutral'}>Motor IA {data.aiProvider.isActive ? 'activo' : 'inactivo'}</StatusPill>
          </div>
        </header>

        <div className={styles.requiredAutomationNotice}>
          <div className={styles.requiredAutomationContent}>
            <div className={styles.requiredAutomationIcon}><ShieldCheck size={24} /></div>
            <div>
              <p className={styles.requiredAutomationEyebrow}>Configuracion requerida</p>
              <h2>Activa la automatizacion para que Departamentos responda</h2>
              <p>El modulo queda guardado aqui, pero el enrutamiento se ejecuta cuando existe una automatizacion activa de departamentos para el canal. Crea o activa ese flujo en Automatizaciones y usa palabras como departamento, soporte o administracion.</p>
            </div>
          </div>
          <Link href="/automation" className={styles.requiredAutomationButton}>Ir a automatizaciones</Link>
        </div>

        <ReservasTopNav activeTab={activeTab} />
        <main className={styles.contentArea}>{content}</main>
      </div>
    </div>
  );
}
