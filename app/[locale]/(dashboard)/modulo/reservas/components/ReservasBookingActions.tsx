'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { CalendarClock, ExternalLink, XCircle } from 'lucide-react';

import type { ReservasBookingRow } from '@/lib/modules/reservas/safe-data';
import styles from '../reservas.module.css';

type Props = {
  booking: ReservasBookingRow;
  compact?: boolean;
};

function toDateTimeLocal(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}


function googleCalendarDayUrl(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `https://calendar.google.com/calendar/u/0/r/day/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

async function patchBooking(body: Record<string, unknown>) {
  const response = await fetch('/api/reservas/bookings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    throw new Error(data?.error || `Error HTTP ${response.status}`);
  }
  return data;
}

export function ReservasBookingActions({ booking, compact = false }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const defaultStart = useMemo(() => toDateTimeLocal(booking.startAt), [booking.startAt]);
  const isCancelled = booking.status === 'cancelled' || booking.status === 'canceled';
  const googleDayUrl = googleCalendarDayUrl(booking.startAt);

  async function cancelBooking() {
    if (isCancelled) return;
    if (!confirm(`Cancelar la reserva de ${booking.customerName || 'este cliente'}?`)) return;
    setLoading('cancel');
    setMessage(null);
    try {
      const result = await patchBooking({ id: booking.id, action: 'cancel', reason: 'Cancelada desde panel AllSender.' });
      setMessage(result.warning || 'Reserva cancelada correctamente.');
      window.location.reload();
    } catch (error: any) {
      setMessage(error?.message || 'No se pudo cancelar la reserva.');
    } finally {
      setLoading(null);
    }
  }

  async function rescheduleBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCancelled) return;
    const form = event.currentTarget;
    const startAt = String(new FormData(form).get('startAt') || '').trim();
    if (!startAt) {
      setMessage('Selecciona una nueva fecha/hora.');
      return;
    }
    setLoading('reschedule');
    setMessage(null);
    try {
      const result = await patchBooking({ id: booking.id, action: 'reschedule', startAt });
      setMessage(result.warning || 'Reserva reprogramada correctamente.');
      window.location.reload();
    } catch (error: any) {
      setMessage(error?.message || 'No se pudo reprogramar la reserva.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className={`${styles.bookingActions} ${compact ? styles.bookingActionsCompact : ''}`}>
      <button
        className={styles.dangerButton}
        type="button"
        onClick={cancelBooking}
        disabled={isCancelled || Boolean(loading)}
        title="Cancela en AllSender y elimina el evento en Google Calendar si existe"
      >
        <XCircle size={15} /> {loading === 'cancel' ? 'Cancelando...' : 'Cancelar'}
      </button>

      <form className={styles.rescheduleForm} onSubmit={rescheduleBooking}>
        <input name="startAt" type="datetime-local" defaultValue={defaultStart} disabled={isCancelled || Boolean(loading)} />
        <button
          className={styles.secondaryButton}
          type="submit"
          disabled={isCancelled || Boolean(loading)}
          title="Reprograma en AllSender y actualiza el evento externo si existe"
        >
          <CalendarClock size={15} /> {loading === 'reschedule' ? 'Reprogramando...' : 'Reprogramar'}
        </button>
      </form>

      {booking.nylasEventId ? (
        <span className={styles.syncLabel}>Google Calendar sincronizado</span>
      ) : (
        <span className={styles.syncLabelMuted}>Sin evento externo</span>
      )}
      {booking.nylasEventId && googleDayUrl ? (
        <a className={styles.googleLink} href={googleDayUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Ver en Google
        </a>
      ) : null}
      {message ? <small className={styles.actionMessage}>{message}</small> : null}
    </div>
  );
}
