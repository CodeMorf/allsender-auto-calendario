import 'server-only';

import { detectReservationIntent } from '@/lib/modules/reservas/intent';
import { shouldRouteAutoCalendarMessage } from '@/lib/modules/reservas/routing-guard';
import { listReservationServices } from '@/lib/modules/reservas/availability';

export type AiRouterDecision = {
  route: 'reservation_ai' | 'sales_ai' | 'base_ai' | 'human_review';
  intent: string;
  confidence: number;
  reasons: string[];
};

function normalizeIntentText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isPlainGreeting(value: unknown) {
  const text = normalizeIntentText(value);
  return /^(hola|buenas|saludos|buen dia|buenas tardes|buenas noches|hello|hi|hey)$/.test(text);
}

function hasExplicitReservationIntent(value: unknown) {
  const text = normalizeIntentText(value);
  return /\b(cita|citas|reserva|reservar|agenda|agendar|turno|consulta|horario|disponibilidad|reprogramar|mover mi cita|cambiar mi cita|cancelar mi cita)\b/.test(text);
}

function hasExplicitSalesIntent(value: unknown) {
  const text = normalizeIntentText(value);
  return /\b(comprar|compra|producto|productos|catalogo|catalogo|precio|cuanto cuesta|cuanto vale|orden|pedido|carrito|pago|transferencia|contra entrega|delivery|envio|tracking|rastreo|stock|disponible|quiero ver|busco|tienen|vende|venden)\b/.test(text);
}

export async function routeInboxMessageIntent(params: { teamId: number; text: string }) : Promise<AiRouterDecision> {
  const text = normalizeIntentText(params.text);

  if (!text) {
    return { route: 'base_ai', intent: 'empty', confidence: 0.4, reasons: ['empty_message'] };
  }

  if (isPlainGreeting(text)) {
    return { route: 'base_ai', intent: 'greeting', confidence: 0.95, reasons: ['plain_greeting'] };
  }

  const services = await listReservationServices(params.teamId).then((items) => items.map((item) => item.name)).catch(() => []);
  const reservation = detectReservationIntent(params.text, services);
  const reservationEligible = shouldRouteAutoCalendarMessage(params.text);

  if (reservationEligible && ((reservation.route === 'reservation_ai' && reservation.confidence >= 0.55) || hasExplicitReservationIntent(text))) {
    return {
      route: 'reservation_ai',
      intent: reservation.intent || 'reservation_request',
      confidence: Math.max(reservation.confidence || 0, hasExplicitReservationIntent(text) ? 0.85 : 0),
      reasons: [...(reservation.reasons || []), hasExplicitReservationIntent(text) ? 'explicit_reservation_intent' : 'reservation_detector'],
    };
  }

  if (reservationEligible && reservation.route === 'human_review') {
    return {
      route: 'human_review',
      intent: reservation.intent,
      confidence: reservation.confidence,
      reasons: reservation.reasons || [],
    };
  }

  if (reservation.route === 'sales_ai' && hasExplicitSalesIntent(text)) {
    return {
      route: 'sales_ai',
      intent: reservation.intent || 'sales_request',
      confidence: Math.max(reservation.confidence || 0, 0.82),
      reasons: [...(reservation.reasons || []), 'explicit_sales_intent'],
    };
  }

  if (hasExplicitSalesIntent(text)) {
    return {
      route: 'sales_ai',
      intent: 'sales_request',
      confidence: 0.82,
      reasons: ['explicit_sales_intent'],
    };
  }

  return {
    route: 'base_ai',
    intent: reservation.intent || 'general_message',
    confidence: reservation.confidence || 0.6,
    reasons: reservation.reasons || ['no_specialized_agent_match'],
  };
}
