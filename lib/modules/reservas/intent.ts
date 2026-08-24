import 'server-only';

export { shouldRouteAutoCalendarMessage } from './routing-guard';

export type ReservationIntentRoute = 'reservation_ai' | 'sales_ai' | 'base_ai' | 'human_review';
export type ReservationIntentName =
  | 'book_reservation'
  | 'reschedule_reservation'
  | 'cancel_reservation'
  | 'check_availability'
  | 'sales_request'
  | 'support_request'
  | 'mixed_or_unclear';

export type ReservationIntentResult = {
  route: ReservationIntentRoute;
  intent: ReservationIntentName;
  confidence: number;
  reasons: string[];
  extracted: {
    serviceHint?: string;
    dateHint?: string;
    timeHint?: string;
    customerNameHint?: string;
  };
  safeMode: true;
  shouldSendReply: false;
  replyPreview: string;
};

function normalize(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function hasAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function detectReservationIntent(message: string, services: string[] = []): ReservationIntentResult {
  const raw = String(message || '').trim();
  const text = normalize(raw);
  const reasons: string[] = [];

  const reservationWords = [
    'cita', 'citas', 'reserva', 'reservar', 'agenda', 'agendar', 'turno', 'horario', 'disponibilidad',
    'disponible', 'calendar', 'calendario', 'appointment', 'booking', 'schedule', 'programar', 'reprogramar',
  ];
  const cancelWords = ['cancelar cita', 'cancelar reserva', 'cancelame', 'cancelarla', 'cancelarlo', 'anular', 'no podre asistir'];
  const rescheduleWords = ['reprogramar', 'cambiar cita', 'cambiar reserva', 'mover cita', 'otra hora', 'otro dia', 'posponer'];
  const availabilityWords = ['disponibilidad', 'tienen espacio', 'hay espacio', 'hora disponible', 'horarios', 'cuando pueden'];
  const salesWords = ['precio', 'comprar', 'compra', 'producto', 'catalogo', 'carrito', 'orden', 'pedido', 'pago', 'delivery', 'envio', 'cotizacion', 'stock'];
  const supportWords = ['problema', 'soporte', 'ayuda', 'queja', 'reclamo', 'humano', 'asesor', 'agente'];

  const reservationScore = reservationWords.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
  const salesScore = salesWords.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
  const supportScore = supportWords.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);

  const serviceHint = services.find((service) => service && text.includes(normalize(service)));
  if (serviceHint) reasons.push(`Servicio detectado: ${serviceHint}`);
  if (reservationScore > 0) reasons.push(`Palabras de reserva: ${reservationScore}`);
  if (salesScore > 0) reasons.push(`Palabras de venta: ${salesScore}`);
  if (supportScore > 0) reasons.push(`Palabras de soporte/humano: ${supportScore}`);

  const timeHint = firstMatch(text, [
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?)?)\b/i,
    /\b(a las\s+\d{1,2}(?::\d{2})?)\b/i,
  ]);
  const dateHint = firstMatch(text, [
    /\b(hoy|manana|mañana|pasado manana|pasado mañana)\b/i,
    /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/i,
    /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i,
  ]);

  let route: ReservationIntentRoute = 'base_ai';
  let intent: ReservationIntentName = 'support_request';
  let confidence = 0.35;

  if (hasAny(text, cancelWords)) {
    route = 'reservation_ai';
    intent = 'cancel_reservation';
    confidence = 0.88;
    reasons.push('Intención de cancelación de reserva detectada.');
  } else if (hasAny(text, rescheduleWords)) {
    route = 'reservation_ai';
    intent = 'reschedule_reservation';
    confidence = 0.86;
    reasons.push('Intención de reprogramación detectada.');
  } else if (hasAny(text, availabilityWords)) {
    route = 'reservation_ai';
    intent = 'check_availability';
    confidence = 0.82;
    reasons.push('Consulta de disponibilidad detectada.');
  } else if (reservationScore > 0 || serviceHint) {
    route = 'reservation_ai';
    intent = 'book_reservation';
    confidence = serviceHint ? 0.86 : 0.76;
  } else if (salesScore > 0) {
    route = 'sales_ai';
    intent = 'sales_request';
    confidence = 0.78;
  } else if (supportScore > 0) {
    route = 'base_ai';
    intent = 'support_request';
    confidence = 0.6;
  } else {
    route = 'base_ai';
    intent = 'mixed_or_unclear';
    confidence = 0.35;
  }

  if (reservationScore > 0 && salesScore > 0) {
    route = 'human_review';
    intent = 'mixed_or_unclear';
    confidence = 0.55;
    reasons.push('Mensaje mixto: venta y reserva. Modo seguro recomienda humano o clasificación manual.');
  }

  const replyPreview = route === 'reservation_ai'
    ? 'Detecté que el cliente quiere gestionar una reserva. En modo seguro no responderé todavía; solo registraré la intención.'
    : route === 'sales_ai'
      ? 'Detecté intención de venta. Debe seguir Ventas IA, no Reservas IA.'
      : route === 'human_review'
        ? 'Mensaje mixto detectado. Requiere revisión humana antes de activar automatización.'
        : 'No parece reserva. Debe seguir IA base o atención humana.';

  return {
    route,
    intent,
    confidence,
    reasons,
    extracted: {
      serviceHint,
      dateHint,
      timeHint,
    },
    safeMode: true,
    shouldSendReply: false,
    replyPreview,
  };
}
