import 'server-only';

import {
  cancelReservationBookingFromAi,
  checkReservationAvailability,
  createReservationBookingFromAi,
  findNextReservationBookingForChat,
  listReservationResources,
  listReservationServices,
  rescheduleReservationBookingFromAi,
} from '@/lib/modules/reservas/availability';

export type ReservationToolContext = {
  teamId: number;
  chatId: number;
};

export async function reservation_list_services(_args: Record<string, unknown>, context: ReservationToolContext) {
  return { ok: true, services: await listReservationServices(context.teamId) };
}

export async function reservation_list_resources(_args: Record<string, unknown>, context: ReservationToolContext) {
  return { ok: true, resources: await listReservationResources(context.teamId) };
}

export async function reservation_check_availability(args: Record<string, unknown>, context: ReservationToolContext) {
  return checkReservationAvailability({
    teamId: context.teamId,
    serviceId: Number(args.service_id || args.serviceId || 0),
    resourceId: args.resource_id || args.resourceId ? Number(args.resource_id || args.resourceId) : null,
    date: String(args.date || '').slice(0, 10),
    limit: Number(args.limit || 8),
  });
}

export async function reservation_create_booking(args: Record<string, unknown>, context: ReservationToolContext) {
  return createReservationBookingFromAi({
    teamId: context.teamId,
    chatId: context.chatId,
    serviceId: Number(args.service_id || args.serviceId || 0),
    resourceId: args.resource_id || args.resourceId ? Number(args.resource_id || args.resourceId) : null,
    customerName: String(args.customer_name || args.customerName || ''),
    customerPhone: String(args.customer_phone || args.customerPhone || ''),
    customerEmail: String(args.customer_email || args.customerEmail || ''),
    startAt: String(args.start_at || args.startAt || ''),
    timezone: String(args.timezone || 'America/Santo_Domingo'),
    requireHumanApproval: Boolean(args.require_human_approval || args.requireHumanApproval),
    createCalendarEvent: Boolean(args.create_calendar_event || args.createCalendarEvent),
    notes: String(args.notes || ''),
  });
}

export async function reservation_find_booking(_args: Record<string, unknown>, context: ReservationToolContext) {
  const booking = await findNextReservationBookingForChat(context.teamId, context.chatId);
  return { ok: Boolean(booking), booking };
}

export async function reservation_update_booking(args: Record<string, unknown>, context: ReservationToolContext) {
  return rescheduleReservationBookingFromAi({
    teamId: context.teamId,
    bookingId: Number(args.booking_id || args.bookingId || 0),
    serviceId: Number(args.service_id || args.serviceId || 0),
    resourceId: Number(args.resource_id || args.resourceId || 0),
    startAt: String(args.start_at || args.startAt || ''),
    timezone: String(args.timezone || 'America/Santo_Domingo'),
  });
}

export async function reservation_cancel_booking(args: Record<string, unknown>, context: ReservationToolContext) {
  const bookingId = Number(args.booking_id || args.bookingId || 0);
  if (!bookingId) return { ok: false, message: 'No se encontró la reserva.' };
  return await cancelReservationBookingFromAi(context.teamId, bookingId, String(args.reason || ''));
}

export async function reservation_handoff_to_human(args: Record<string, unknown>, _context: ReservationToolContext) {
  return {
    ok: true,
    humanRequired: true,
    reason: String(args.reason || 'El cliente requiere atención personalizada.'),
  };
}
