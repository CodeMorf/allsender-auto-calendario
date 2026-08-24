import 'server-only';

import { findServiceByText, type ReservationResourceOption, type ReservationServiceOption } from '@/lib/modules/reservas/availability';
import type { ReservationConversationState } from '@/lib/modules/reservas/conversation-state';
import type { ReservationExtraction } from '@/lib/modules/reservas/ai-extractor';

export type ReservationMissingField =
  | 'service'
  | 'resource'
  | 'date'
  | 'time'
  | 'customer_name'
  | 'customer_contact'
  | 'confirmation';

export type ReservationBrainDecision = {
  state: ReservationConversationState;
  missingFields: ReservationMissingField[];
  nextField: ReservationMissingField | null;
  nextQuestion: string | null;
  activeIntent: string;
  confirmation: boolean | null;
  modeGuardMessage: string | null;
};

function clean(value: unknown, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalize(value: unknown) {
  return clean(value, 1200)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isActiveReservationFlow(state: ReservationConversationState) {
  return Boolean(state.currentStage && state.currentStage !== 'idle' && state.currentStage !== 'booking_created');
}

export function isReservationModeGuardNeeded(text: string, state: ReservationConversationState) {
  if (!isActiveReservationFlow(state)) return false;
  const normalized = normalize(text);
  return /\b(producto|comprar|precio|orden|pedido|delivery|envio|envío|pago|factura|departamento|soporte|humano|asesor)\b/.test(normalized);
}

export function reservationModeGuardMessage() {
  return 'Ahora mismo estoy coordinando tu cita. Terminemos esta reserva y luego te puedo pasar con el equipo o ayudarte con otra solicitud.';
}

function serviceByName(name: string | null | undefined, services: ReservationServiceOption[]) {
  if (!name) return null;
  return findServiceByText(name, services) || services.find((item) => normalize(item.name) === normalize(name)) || null;
}

function resourceByName(name: string | null | undefined, resources: ReservationResourceOption[]) {
  if (!name) return null;
  const normalized = normalize(name);
  return resources.find((item) => {
    const resourceName = normalize(item.name);
    return resourceName === normalized || normalized.includes(resourceName) || resourceName.includes(normalized);
  }) || null;
}

export function mergeReservationConversationData(input: {
  state: ReservationConversationState;
  extraction: ReservationExtraction;
  services: ReservationServiceOption[];
  resources: ReservationResourceOption[];
}) {
  const { extraction, services, resources } = input;
  const service = serviceByName(extraction.service, services);
  const resource = resourceByName(extraction.resource, resources);
  const next: ReservationConversationState = {
    ...input.state,
    detectedIntent: extraction.intent || input.state.detectedIntent || null,
    selectedServiceId: service?.id || input.state.selectedServiceId || null,
    selectedResourceId: resource?.id || input.state.selectedResourceId || null,
    requestedDate: extraction.date || input.state.requestedDate || null,
    requestedTime: extraction.time || input.state.requestedTime || null,
    customerName: extraction.customer_name || input.state.customerName || null,
    customerPhone: extraction.phone || input.state.customerPhone || null,
    customerEmail: extraction.email || input.state.customerEmail || null,
    metadata: {
      ...(input.state.metadata || {}),
      active_mode: 'auto_cita',
      last_extraction_intent: extraction.intent,
      last_extraction_message: extraction.message || null,
    },
  };

  if (!next.selectedServiceId && services.length === 1) {
    next.selectedServiceId = services[0].id;
  }
  if (!next.selectedResourceId && resources.length === 1) {
    next.selectedResourceId = resources[0].id;
  }

  return next;
}

function serviceQuestion(services: ReservationServiceOption[]) {
  return [
    'Claro, con gusto te ayudo a coordinarla. ¿Qué servicio necesitas?',
    ...services.slice(0, 8).map((service, index) => `${index + 1}. ${service.name}`),
  ].join('\n');
}

function resourceQuestion(resources: ReservationResourceOption[]) {
  return [
    'Perfecto. ¿Con cuál especialista o recurso prefieres la cita?',
    ...resources.slice(0, 8).map((resource, index) => `${index + 1}. ${resource.name}`),
    '',
    'Si no tienes preferencia, responde "cualquiera".',
  ].join('\n');
}

function questionFor(field: ReservationMissingField, state: ReservationConversationState, services: ReservationServiceOption[], resources: ReservationResourceOption[]) {
  if (field === 'service') return serviceQuestion(services);
  if (field === 'resource') return resourceQuestion(resources);
  if (field === 'date') return 'Claro, con gusto te ayudo a coordinarla. ¿Qué día y hora te gustaría?';
  if (field === 'time') return 'Perfecto, ¿a qué hora te gustaría?';
  if (field === 'customer_name') return 'Sí, tengo ese horario disponible. ¿A nombre de quién registro la cita?';
  if (field === 'customer_contact') return 'Perfecto, envíame un teléfono o correo de contacto para completar la reserva.';
  if (field === 'confirmation') return '¿Confirmas que todo está correcto?';
  return null;
}

export function decideReservationConversation(input: {
  state: ReservationConversationState;
  extraction: ReservationExtraction;
  services: ReservationServiceOption[];
  resources: ReservationResourceOption[];
  text: string;
}) : ReservationBrainDecision {
  const state = mergeReservationConversationData(input);
  const missingFields: ReservationMissingField[] = [];
  const guard = isReservationModeGuardNeeded(input.text, input.state) ? reservationModeGuardMessage() : null;

  if (!state.selectedServiceId) missingFields.push('service');
  if (input.resources.length > 1 && !state.selectedResourceId) missingFields.push('resource');
  if (!state.requestedDate) missingFields.push('date');
  if (!state.requestedTime) missingFields.push('time');
  if (!state.customerName) missingFields.push('customer_name');
  if (!state.customerPhone && !state.customerEmail) missingFields.push('customer_contact');
  if (state.customerName && (state.customerPhone || state.customerEmail) && state.requestedDate && state.requestedTime && state.selectedServiceId) {
    missingFields.push('confirmation');
  }

  const lastAsked = clean((state.metadata as any)?.last_asked_field || '', 40) as ReservationMissingField | '';
  const nextField = missingFields.find((field) => field !== 'confirmation' && field !== lastAsked) || missingFields[0] || null;
  const nextQuestion = nextField ? questionFor(nextField, state, input.services, input.resources) : null;

  return {
    state: {
      ...state,
      metadata: {
        ...(state.metadata || {}),
        last_asked_field: nextField,
      },
    },
    missingFields,
    nextField,
    nextQuestion,
    activeIntent: input.extraction.intent,
    confirmation: input.extraction.confirmation,
    modeGuardMessage: guard,
  };
}
