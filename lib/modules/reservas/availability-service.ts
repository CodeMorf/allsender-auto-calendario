import 'server-only';

import {
  checkReservationAvailability,
  listReservationResources,
  listReservationServices,
  zonedDateTimeToUtcIso,
  type ReservationResourceOption,
  type ReservationServiceOption,
  type ReservationSlot,
  type ReservationTimeFormat,
} from '@/lib/modules/reservas/availability';

export type ReservationSlotValidation = {
  available: boolean;
  slot: ReservationSlot | null;
  alternatives: ReservationSlot[];
  service: ReservationServiceOption | null;
  resource: ReservationResourceOption | null;
};

function clean(value: unknown, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function localDateAndTimeFromIso(iso: string, timezone = 'America/Santo_Domingo') {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'America/Santo_Domingo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
    const year = part('year');
    const month = part('month');
    const day = part('day');
    const hour = part('hour');
    const minute = part('minute');
    if (!year || !month || !day || !hour || !minute) return null;
    return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
  } catch {
    return null;
  }
}

export async function getReservationCatalog(teamId: number) {
  const [services, resources] = await Promise.all([
    listReservationServices(teamId),
    listReservationResources(teamId),
  ]);
  return { services, resources };
}

export async function getRealReservationAlternatives(input: {
  teamId: number;
  serviceId: number;
  resourceId?: number | null;
  date: string;
  limit?: number;
  timeFormat?: ReservationTimeFormat;
}) {
  return checkReservationAvailability({
    teamId: input.teamId,
    serviceId: input.serviceId,
    resourceId: input.resourceId || null,
    date: input.date,
    limit: input.limit || 5,
    timeFormat: input.timeFormat || '12h',
  });
}

export async function validateRequestedReservationSlot(input: {
  teamId: number;
  serviceId: number;
  resourceId?: number | null;
  date: string;
  time: string;
  timezone?: string | null;
  timeFormat?: ReservationTimeFormat;
}): Promise<ReservationSlotValidation> {
  const availability = await checkReservationAvailability({
    teamId: input.teamId,
    serviceId: input.serviceId,
    resourceId: input.resourceId || null,
    date: input.date,
    limit: 96,
    timeFormat: input.timeFormat || '12h',
  });

  const timezone = clean(input.timezone || availability.resource?.timezone || 'America/Santo_Domingo', 80) || 'America/Santo_Domingo';
  const requestedStart = zonedDateTimeToUtcIso(input.date, input.time.length === 5 ? `${input.time}:00` : input.time, timezone);
  const requestedTime = new Date(requestedStart).getTime();
  const exactSlot = availability.slots.find((slot) => Math.abs(new Date(slot.startAt).getTime() - requestedTime) < 60_000) || null;

  const alternatives = availability.slots
    .filter((slot) => !exactSlot || slot.startAt !== exactSlot.startAt)
    .sort((a, b) => Math.abs(new Date(a.startAt).getTime() - requestedTime) - Math.abs(new Date(b.startAt).getTime() - requestedTime))
    .slice(0, 5);

  return {
    available: Boolean(exactSlot),
    slot: exactSlot,
    alternatives,
    service: availability.service || null,
    resource: availability.resource || null,
  };
}

export function slotToConversationState(slot: ReservationSlot, timezone = 'America/Santo_Domingo') {
  const local = localDateAndTimeFromIso(slot.startAt, timezone);
  return {
    requestedDate: local?.date || null,
    requestedTime: local?.time || null,
    selectedSlotStartAt: slot.startAt,
    selectedSlotEndAt: slot.endAt,
    selectedSlotLabel: slot.label,
  };
}
