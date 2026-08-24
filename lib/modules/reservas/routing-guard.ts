function normalize(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Keeps Auto Calendario from consuming restaurant and commerce messages.
 * This module is intentionally dependency-free so the guard can be tested in
 * isolation and reused by server-side and routing code.
 */
export function shouldRouteAutoCalendarMessage(message: string, hasActiveFlow = false): boolean {
  if (hasActiveFlow) return true;

  const text = normalize(message);
  if (!text) return false;

  const restaurantSignals = [
    'mesa', 'menu', 'carta', 'plato', 'comida', 'pizza', 'hamburguesa',
    'restaurante', 'delivery', 'para llevar', 'sucursal', 'combo', 'bebida',
  ];
  const appointmentSignals = [
    'cita', 'agendar', 'agenda', 'turno', 'consulta', 'especialista', 'doctor',
    'abogado', 'calendario', 'appointment', 'booking', 'schedule', 'reprogramar',
    'cancelar cita', 'mover mi cita', 'cambiar mi cita',
  ];
  const availabilitySignals = ['disponibilidad', 'hay espacio', 'hora disponible', 'horarios'];

  const hasRestaurantContext = restaurantSignals.some((signal) => text.includes(signal));
  const hasAppointmentContext = appointmentSignals.some((signal) => text.includes(signal));
  const hasAvailabilityContext = availabilitySignals.some((signal) => text.includes(signal));

  // "reservar mesa" or "disponibilidad para cenar" belongs to RestApp. An
  // explicit cita/turno/consulta still wins when both contexts are present.
  if (hasRestaurantContext && !hasAppointmentContext) return false;
  return hasAppointmentContext || hasAvailabilityContext || /\b(reserva|reservar)\b/.test(text);
}
