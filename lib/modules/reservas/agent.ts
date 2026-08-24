import 'server-only';

import { routeInboxMessageIntent } from '@/lib/modules/ai-router/intent-router';
import {
  checkReservationAvailability,
  createReservationBookingFromAi,
  findNextReservationBookingForChat,
  cancelReservationBookingFromAi,
  rescheduleReservationBookingFromAi,
  findServiceByText,
  zonedDateTimeToUtcIso,
  type ReservationTimeFormat,
  getDefaultReservationResource,
} from '@/lib/modules/reservas/availability';
import { extractReservationConversationData } from '@/lib/modules/reservas/ai-extractor';
import { decideReservationConversation } from '@/lib/modules/reservas/conversation-brain';
import { getReservationCatalog, slotToConversationState, validateRequestedReservationSlot } from '@/lib/modules/reservas/availability-service';
import {
  emptyReservationConversationState,
  getReservationConversationState,
  reservationConversationStateTableExists,
  resetReservationConversationState,
  saveReservationConversationState,
  ReservationConversationState,
} from '@/lib/modules/reservas/conversation-state';
import { canRunReservationAgent, getReservationAgentSettings, logReservationAgentEvent } from '@/lib/modules/reservas/service';

export type ReservationAgentResult = {
  handled: boolean;
  responseText?: string;
  action?: string;
  reason?: string;
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

function yesIntent(text: string) {
  return /\b(si|sí|confirmo|confirmar|correcto|dale|ok|esta bien|está bien|perfecto)\b/i.test(text);
}

function resetIntent(text: string) {
  return /\b(cancelar flujo|empezar de nuevo|reiniciar|otra cita|nueva cita)\b/i.test(text);
}

function nameChangeIntent(text: string) {
  const normalized = normalize(text);
  return /\b(cambia|cambiar|corrige|corregir|actualiza|actualizar|modifica|modificar)\b.*\b(nombre|me llamo|soy)\b/.test(normalized)
    || /\bnombre\b.*\b(es|soy|sera|seria)\b/.test(normalized);
}

function asksRegisteredName(text: string) {
  const normalized = normalize(text);
  return /\b(cambiaste|cambio|actualizaste|actualizado|quedo|registrado)\b.*\bnombre\b/.test(normalized)
    || /\bnombre\b.*\b(cambiaste|actualizaste|quedo|registrado)\b/.test(normalized);
}

function extractPhone(text: string) {
  const localMatch = text.match(/(?:\+?1[\s\-.]?)?(?:809|829|849)[\s\-.]?\d{3}[\s\-.]?\d{4}/);
  const genericMatch = localMatch || text.match(/\+?\d[\d\s().-]{6,}\d/);
  if (!genericMatch) return null;
  const digits = genericMatch[0].replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function extractEmail(text: string) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function titleCase(value: string) {
  return value.split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');
}

function extractName(text: string) {
  const match = text.match(/(?:mi nombre es|me llamo|soy|nombre)\s*:?[\s]+([a-záéíóúñü.' -]{3,80})/i);
  if (match?.[1]) return titleCase(match[1].replace(/[.,;].*$/, '').trim());
  const withoutContact = text.replace(/(?:\+?1[\s\-.]?)?(?:809|829|849)[\s\-.]?\d{3}[\s\-.]?\d{4}/g, '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '').trim();
  const normalized = normalize(withoutContact);
  if (/\b(cita|reserva|agenda|hora|manana|mañana|hoy|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|servicio|precio|producto)\b/.test(normalized)) return null;
  const words = withoutContact.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 4 && /^[a-záéíóúñü.' -]+$/i.test(withoutContact)) return titleCase(withoutContact);
  return null;
}

function toDateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function extractDate(text: string) {
  const normalized = normalize(text);
  const now = new Date();
  if (/\bhoy\b/.test(normalized)) return toDateString(now);
  if (/\bmanana\b/.test(normalized)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toDateString(d);
  }
  const numeric = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = Number(numeric[3] ? (numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : now.getFullYear());
    const d = new Date(year, month - 1, day);
    if (Number.isFinite(d.getTime())) return toDateString(d);
  }
  const weekDays: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
  for (const [name, target] of Object.entries(weekDays)) {
    if (normalized.includes(name)) {
      const d = new Date(now);
      const delta = (target - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + delta);
      return toDateString(d);
    }
  }
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return iso ? iso[1] : null;
}

function extractTime(text: string) {
  const match = text.match(/\b(?:a las\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const suffix = normalize(match[3] || '');
  if (hour > 23 || minute > 59) return null;
  if (suffix.includes('pm') && hour < 12) hour += 12;
  if (suffix.includes('am') && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function startIsoFromDateTime(date: string, time: string, timezone = 'America/Santo_Domingo') {
  return zonedDateTimeToUtcIso(date, time.length === 5 ? `${time}:00` : time, timezone);
}

function normalizeTimeFormat(value: unknown): ReservationTimeFormat {
  const text = clean(value, 20).toLowerCase();
  return ['24h', '24', 'h24', 'military'].includes(text) ? '24h' : '12h';
}


function formatReservationDateTime(iso: string, timezone = 'America/Santo_Domingo', timeFormat: ReservationTimeFormat = '12h') {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'la fecha acordada';
  const resolvedTimezone = clean(timezone, 80) || 'America/Santo_Domingo';
  try {
    const dateText = new Intl.DateTimeFormat('es', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: resolvedTimezone,
    }).format(date);
    const local = localDateAndTimeFromIso(iso, resolvedTimezone);
    let timeText = '';
    if (local?.time) {
      const [rawHour, rawMinute] = local.time.split(':').map((item) => Number(item));
      const hour = Number.isFinite(rawHour) ? rawHour : 0;
      const minute = Number.isFinite(rawMinute) ? rawMinute : 0;
      if (normalizeTimeFormat(timeFormat) === '24h') {
        timeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      } else {
        const displayHour = hour % 12 || 12;
        const suffix = hour < 12 ? 'a. m.' : 'p. m.';
        timeText = `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
      }
    }
    return timeText ? `${dateText} a las ${timeText}` : dateText;
  } catch {
    return 'la fecha acordada';
  }
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

function contactSummary(phone?: string | null, email?: string | null) {
  return [phone || '', email || ''].filter(Boolean).join(' / ') || 'Pendiente';
}

function wantsAnotherSlot(text: string) {
  const normalized = normalize(text);
  return /\b(otro horario|otra hora|otro turno|otra opcion|dame otra|no puedo|mas tarde|mas temprano|cambiar hora|cambiar horario)\b/.test(normalized);
}

function formatServiceList(services: Array<{ name: string }>) {
  if (!services.length) return 'Todavía no hay servicios disponibles. Configura tus servicios para recibir reservas.';
  return services.slice(0, 6).map((service, index) => `${index + 1}. ${service.name}`).join('\n');
}

function serviceSelectionNumber(text: string) {
  const normalized = normalize(text);
  const direct = normalized.match(/^\s*(\d{1,2})\s*$/);
  if (direct) return Number(direct[1]);
  const match = normalized.match(/(?:opcion|opción|servicio|numero|número|el|la|quiero|necesito|escogo|selecciono)\s*(?:es|seria|sería)?\s*(\d{1,2})\b/);
  if (match) return Number(match[1]);
  const anyNumber = normalized.match(/\b(\d{1,2})\b/);
  return anyNumber ? Number(anyNumber[1]) : null;
}

function serviceFromSelectionText(text: string, services: Array<{ id: number; name: string }>) {
  const selected = serviceSelectionNumber(text);
  if (!selected || selected < 1) return null;
  return services[selected - 1] || null;
}


function resourceSelectionNumber(text: string) {
  const normalized = normalize(text);
  const direct = normalized.match(/^\s*(\d{1,2})\s*$/);
  if (direct) return Number(direct[1]);
  const match = normalized.match(/(?:recurso|especialista|abogado|consultor|doctor|doctora|asesor|asesora|persona|empleado|empleada|con|prefiero|quiero)\s*(?:el|la|al|a la|numero|número|opcion|opción)?\s*(\d{1,2})\b/);
  if (match) return Number(match[1]);
  return null;
}

function noResourcePreference(text: string) {
  const normalized = normalize(text);
  return /\b(cualquiera|cualquier|el que sea|la que sea|no importa|sin preferencia|me da igual|quien este disponible|quien esté disponible|el disponible|la disponible)\b/.test(normalized);
}

function findResourceByText(text: string, resources: Array<{ id: number; name: string }>) {
  const normalized = normalize(text);
  if (!normalized) return null;

  let best: { id: number; name: string } | null = null;
  let bestScore = 0;

  for (const resource of resources) {
    const name = normalize(resource.name);
    if (!name) continue;
    let score = 0;
    if (normalized.includes(name)) score = 10 + name.length;
    else {
      const words = name.split(/\s+/).filter((word) => word.length >= 3);
      score = words.reduce((acc, word) => acc + (normalized.includes(word) ? 3 : 0), 0);
    }
    if (score > bestScore) {
      bestScore = score;
      best = resource;
    }
  }

  return bestScore >= 3 ? best : null;
}

function resourceFromSelectionText(text: string, resources: Array<{ id: number; name: string }>) {
  const selected = resourceSelectionNumber(text);
  if (selected && selected >= 1 && resources[selected - 1]) return resources[selected - 1];
  return findResourceByText(text, resources);
}

function formatResourceList(resources: Array<{ name: string }>) {
  return resources.slice(0, 8).map((resource, index) => `${index + 1}. ${resource.name}`).join('\n');
}

function resourceQuestion(settings: Awaited<ReturnType<typeof getReservationAgentSettings>>, resources: Array<{ name: string }>) {
  const business = settings.businessName ? ` en ${settings.businessName}` : '';
  return `Perfecto${business}. ¿Con cuál especialista prefieres la cita?\n${formatResourceList(resources)}\n\nSi no tienes preferencia, responde “cualquiera”.`;
}

function formatSlots(slots: Array<{ label: string }>) {
  return slots.slice(0, 5).map((slot, index) => `${index + 1}. ${slot.label}`).join('\n');
}

function applySlotSelectionFromText(state: ReservationConversationState, text: string, timezone = 'America/Santo_Domingo') {
  if (!['asking_time', 'rescheduling'].includes(String(state.currentStage || ''))) return state;

  const selectedNumber = Number(clean(text, 20));
  if (!Number.isInteger(selectedNumber) || selectedNumber < 1) return state;

  const slots = Array.isArray(state.pendingPayload?.slots)
    ? state.pendingPayload?.slots as Array<{ startAt?: string; endAt?: string; label?: string }>
    : [];

  const slot = slots[selectedNumber - 1];
  const slotStartAt = clean(slot?.startAt, 120);
  if (!slotStartAt) return state;

  const local = localDateAndTimeFromIso(slotStartAt, timezone);
  if (!local) return state;

  return {
    ...state,
    requestedDate: local.date || state.requestedDate || null,
    requestedTime: local.time,
    pendingPayload: {
      ...(state.pendingPayload || {}),
      selectedSlotStartAt: slotStartAt,
      selectedSlotEndAt: clean(slot?.endAt, 120) || null,
      selectedSlotLabel: clean(slot?.label, 80) || null,
    },
  } satisfies ReservationConversationState;
}

function updateStateFromText(
  state: ReservationConversationState,
  text: string,
  services: Array<{ id: number; name: string; durationMinutes: number }>,
  resources: Array<{ id: number; name: string }>
) {
  const selectedByNumber = state.currentStage === 'asking_service' ? serviceFromSelectionText(text, services) : null;
  const service = selectedByNumber || findServiceByText(text, services as any);
  const selectedResource = state.currentStage === 'asking_resource' || !state.selectedResourceId
    ? resourceFromSelectionText(text, resources)
    : null;
  const phone = extractPhone(text);
  const email = extractEmail(text);
  const name = ['asking_service', 'asking_resource', 'asking_time'].includes(state.currentStage) ? null : extractName(text);
  const date = extractDate(text);
  const isPureChoice = /^\d{1,2}$/.test(clean(text, 20));
  const time = state.currentStage === 'asking_service' || state.currentStage === 'asking_resource' || serviceSelectionNumber(text) || resourceSelectionNumber(text) || isPureChoice ? null : extractTime(text);

  return {
    ...state,
    selectedServiceId: service?.id || state.selectedServiceId || null,
    selectedResourceId: selectedResource?.id || state.selectedResourceId || null,
    requestedDate: date || state.requestedDate || null,
    requestedTime: time || state.requestedTime || null,
    customerName: name || state.customerName || null,
    customerPhone: phone || state.customerPhone || null,
    customerEmail: email || state.customerEmail || null,
  } satisfies ReservationConversationState;
}

async function appendAndSave(state: ReservationConversationState, responseText: string, userText: string, action: string) {
  await saveReservationConversationState({
    ...state,
    lastUserMessage: clean(userText, 2000),
    lastAiMessage: responseText,
    metadata: { ...(state.metadata || {}), last_action: action, agent_context_preview: clean((state.metadata as any)?.agent_context_preview || '', 120) },
  }).catch(() => null);
  return { handled: true, responseText, action };
}

export function buildReservationSystemPrompt(settings: {
  agentName?: string;
  instructions?: string;
  businessName?: string;
  businessDescription?: string;
  agentPersonality?: string;
  bookingPolicy?: string;
}) {
  return [
    `Eres ${settings.agentName || 'Auto Cita IA'}, agente especializado en gestionar citas.`,
    settings.businessName ? `Empresa: ${settings.businessName}.` : '',
    settings.businessDescription ? `Contexto del negocio: ${settings.businessDescription}.` : '',
    `Tu trabajo es conversar de forma natural, dar seguimiento, consultar disponibilidad, crear, reprogramar o cancelar reservas.`,
    `No vendas productos, no crees órdenes y no proceses pagos. Si el cliente pide compra, entrega o tracking, deja que Ventas IA responda.`,
    settings.agentPersonality ? `Estilo: ${settings.agentPersonality}.` : 'Estilo: profesional, amable, claro, humano y breve.',
    settings.bookingPolicy ? `Reglas de reserva: ${settings.bookingPolicy}.` : 'Reglas de reserva: una pregunta a la vez, mantener continuidad, recordar datos ya recibidos, confirmar servicio, fecha, hora, nombre y contacto antes de crear la cita.',
    settings.instructions || '',
  ].filter(Boolean).join(' ').trim();
}

function greetingPrefix(settings: Awaited<ReturnType<typeof getReservationAgentSettings>>) {
  const agent = settings.agentName || 'Auto Cita IA';
  const business = settings.businessName ? ` de ${settings.businessName}` : '';
  return `${agent}${business}`;
}


function bookingSummaryText(input: {
  serviceName?: string | null;
  resourceName?: string | null;
  startAt: string;
  timezone?: string | null;
  timeFormat?: ReservationTimeFormat;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  pending?: boolean;
}) {
  const when = formatReservationDateTime(input.startAt, input.timezone || 'America/Santo_Domingo', input.timeFormat || '12h');
  return [
    'Perfecto, confirmo los datos de la cita:',
    '',
    `Servicio: ${input.serviceName || 'Servicio seleccionado'}`,
    `Especialista: ${input.resourceName || 'Agenda disponible'}`,
    `Fecha y hora: ${when}`,
    `Nombre: ${input.customerName || 'Pendiente'}`,
    `Contacto: ${contactSummary(input.customerPhone, input.customerEmail)}`,
    '',
    input.pending ? 'Responde “sí” para enviar la solicitud de reserva.' : 'Responde “sí” para confirmar la cita.',
  ].join('\n');
}

function clearSelectedSlot(state: ReservationConversationState) {
  const pending = { ...(state.pendingPayload || {}) } as Record<string, unknown>;
  delete pending.selectedSlotStartAt;
  delete pending.selectedSlotEndAt;
  delete pending.selectedSlotLabel;
  return {
    ...state,
    requestedTime: null,
    pendingPayload: pending,
  } satisfies ReservationConversationState;
}

export async function tryHandleReservationAiMessage(params: {
  teamId: number;
  chatId: number;
  text: string;
  channel?: string | null;
  contactId?: number | null;
  force?: boolean | null;
}): Promise<ReservationAgentResult> {
  const text = clean(params.text, 4000);
  if (!text) return { handled: false, reason: 'empty_message' };

  if (!(await canRunReservationAgent(params.teamId))) return { handled: false, reason: 'agent_inactive' };
  if (!(await reservationConversationStateTableExists())) {
    await logReservationAgentEvent(params.teamId, 'reservation_ai.state_missing', 'Auto Cita IA requiere preparar el estado conversacional.', { chatId: params.chatId }).catch(() => null);
    return { handled: false, reason: 'conversation_state_missing' };
  }

  const settings = await getReservationAgentSettings(params.teamId);
  const timeFormat = normalizeTimeFormat(settings.timeFormat);
  const agentContext = buildReservationSystemPrompt(settings);
  const { services, resources } = await getReservationCatalog(params.teamId);
  let state = await getReservationConversationState(params.teamId, params.chatId) || emptyReservationConversationState(params.teamId, params.chatId);
  state.contactId = params.contactId || state.contactId || null;
  state.metadata = { ...(state.metadata || {}), agent_context_preview: clean(agentContext, 120) };

  if (resetIntent(text)) {
    state = await resetReservationConversationState(params.teamId, params.chatId, text) || emptyReservationConversationState(params.teamId, params.chatId);
  }

  const routerDecision = await routeInboxMessageIntent({ teamId: params.teamId, text });
  const hasActiveReservationFlow = state.currentStage && state.currentStage !== 'idle';

  if (state.currentStage === 'booking_created' && asksRegisteredName(text)) {
    const registeredName = clean(state.customerName || (state.metadata as any)?.last_customer_name || '', 120);
    if (registeredName) return appendAndSave(state, `S\u00ed, qued\u00f3 registrado como ${registeredName}.`, text, 'confirm_registered_name');
    return appendAndSave(state, 'S\u00ed, el nombre qued\u00f3 actualizado en tu solicitud de cita.', text, 'confirm_registered_name');
  }

  if (!params.force && !hasActiveReservationFlow && routerDecision.route !== 'reservation_ai') {
    return { handled: false, reason: `route_${routerDecision.route}` };
  }

  const normalized = normalize(text);
  const wantsHuman = settings.handoffKeywords.some((keyword) => normalized.includes(normalize(keyword)));
  if (wantsHuman) {
    state.currentStage = 'human_handoff_required';
    state.humanRequired = true;
    return appendAndSave(state, 'Claro, te paso con una persona del equipo para ayudarte con tu cita.', text, 'handoff');
  }

  const activeResourceTimezone = resources.find((item) => item.id === state.selectedResourceId)?.timezone || settings.timezone || 'America/Santo_Domingo';
  const previousCustomerName = clean(state.customerName || '', 120);
  state = applySlotSelectionFromText(state, text, activeResourceTimezone);
  const extraction = await extractReservationConversationData({
    teamId: params.teamId,
    text,
    timezone: activeResourceTimezone,
    services,
    resources,
    state,
    settings: {
      businessName: settings.businessName,
      businessDescription: settings.businessDescription,
      bookingPolicy: settings.bookingPolicy,
    },
  });
  const brain = decideReservationConversation({ state, extraction, services, resources, text });
  state = updateStateFromText({ ...brain.state, detectedIntent: extraction.intent }, text, services as any, resources as any);
  if (brain.modeGuardMessage) {
    state.currentStage = state.currentStage === 'idle' ? 'asking_date' : state.currentStage;
    return appendAndSave(state, brain.modeGuardMessage, text, 'reservation_mode_guard');
  }
  const updatedCustomerName = clean(state.customerName || '', 120);
  const changedCustomerName = Boolean(updatedCustomerName && updatedCustomerName !== previousCustomerName && nameChangeIntent(text));
  const confirmedIntent = extraction.confirmation === true || yesIntent(text);
  const activeIntent = extraction.intent === 'cancel_appointment'
    ? 'cancel_reservation'
    : extraction.intent === 'reschedule_appointment'
      ? 'reschedule_reservation'
      : routerDecision.intent;

  if (activeIntent === 'cancel_reservation' || state.currentStage === 'cancelling') {
    if (!settings.canCancel) {
      state.currentStage = 'human_handoff_required';
      state.humanRequired = true;
      return appendAndSave(state, 'Puedo ayudarte con esa solicitud. Un asesor revisará tu cita para confirmar la cancelación.', text, 'cancel_handoff');
    }
    const booking = await findNextReservationBookingForChat(params.teamId, params.chatId);
    if (!booking?.id) {
      state.currentStage = 'cancelling';
      return appendAndSave(state, 'Puedo ayudarte a cancelar. Indícame el nombre, teléfono o la fecha de la cita para ubicarla.', text, 'ask_cancel_booking');
    }
    await cancelReservationBookingFromAi(params.teamId, Number(booking.id), 'Cancelada por el cliente desde Auto Cita IA');
    state.currentStage = 'idle';
    return appendAndSave(state, 'Listo, tu cita fue cancelada correctamente.', text, 'cancel_booking');
  }

  if (activeIntent === 'reschedule_reservation' || state.currentStage === 'rescheduling') {
    if (!settings.canReschedule) {
      state.currentStage = 'human_handoff_required';
      state.humanRequired = true;
      return appendAndSave(state, 'Puedo ayudarte con esa solicitud. Un asesor revisará tu cita para reprogramarla.', text, 'reschedule_handoff');
    }
    const booking = await findNextReservationBookingForChat(params.teamId, params.chatId);
    if (!booking?.id) {
      state.currentStage = 'rescheduling';
      return appendAndSave(state, 'Claro, dime la fecha y hora nueva que prefieres para reprogramar tu cita.', text, 'ask_reschedule_datetime');
    }
    if (!state.requestedDate) {
      state.currentStage = 'rescheduling';
      return appendAndSave(state, 'Perfecto. ¿Para qué fecha quieres mover tu cita?', text, 'ask_reschedule_date');
    }
    if (!state.requestedTime) {
      const availability = await checkReservationAvailability({ teamId: params.teamId, serviceId: Number(booking.service_id), resourceId: Number(booking.resource_id), date: state.requestedDate, limit: 5, timeFormat });
      const response = availability.slots.length
        ? `Tengo estos horarios disponibles:\n${formatSlots(availability.slots)}\n\n¿Cuál prefieres?`
        : 'No veo horarios disponibles en esa fecha. Indícame otra fecha para revisar.';
      state.currentStage = 'rescheduling';
      return appendAndSave(state, response, text, 'ask_reschedule_time');
    }
    const timezone = String(booking.timezone || 'America/Santo_Domingo');
    const result = await rescheduleReservationBookingFromAi({
      teamId: params.teamId,
      bookingId: Number(booking.id),
      serviceId: Number(booking.service_id),
      resourceId: Number(booking.resource_id),
      startAt: startIsoFromDateTime(state.requestedDate, state.requestedTime, timezone),
      timezone,
    });
    if (!result.ok) return appendAndSave(state, result.message || 'Ese horario no está disponible. Indícame otro horario.', text, 'reschedule_unavailable');
    state.currentStage = 'idle';
    return appendAndSave(state, `Listo, tu cita fue reprogramada para ${formatReservationDateTime(result.startAt || '', timezone, timeFormat)}.`, text, 'reschedule_booking');
  }

  if (!services.length) {
    state.currentStage = 'human_handoff_required';
    state.humanRequired = true;
    return appendAndSave(state, `${settings.closedMessage || 'Gracias por escribir. En este momento estamos preparando la agenda.'} Te pasaremos con una persona para ayudarte.`, text, 'no_services');
  }

  if (!state.selectedServiceId && services.length === 1) {
    state.selectedServiceId = services[0].id;
  }

  if (!state.selectedServiceId) {
    const response = `Hola, soy ${greetingPrefix(settings)}. Claro, te ayudo a coordinar la cita. ¿Qué servicio necesitas?\n${formatServiceList(services)}`;
    state.currentStage = 'asking_service';
    return appendAndSave(state, response, text, 'ask_service');
  }

  if (!resources.length) {
    state.currentStage = 'human_handoff_required';
    state.humanRequired = true;
    return appendAndSave(state, 'Tu agenda necesita una configuración final para recibir citas. Configura al menos un personal, consultor o recurso disponible.', text, 'no_resource');
  }

  if (!state.selectedResourceId) {
    if (resources.length === 1 || noResourcePreference(text)) {
      state.selectedResourceId = resources[0].id;
    } else {
      state.currentStage = 'asking_resource';
      return appendAndSave(state, resourceQuestion(settings, resources), text, 'ask_resource');
    }
  }

  const resource = resources.find((item) => item.id === state.selectedResourceId) || await getDefaultReservationResource(params.teamId, state.selectedServiceId);
  if (!resource?.id) {
    state.currentStage = 'human_handoff_required';
    state.humanRequired = true;
    return appendAndSave(state, 'Tu agenda necesita una configuración final para recibir citas. Configura al menos un recurso disponible o te pasamos con una persona del equipo.', text, 'no_resource');
  }
  state.selectedResourceId = state.selectedResourceId || resource.id;

  if (wantsAnotherSlot(text) && state.requestedDate) {
    const requestedDate = state.requestedDate;
    state = clearSelectedSlot(state);
    const availability = await checkReservationAvailability({
      teamId: params.teamId,
      serviceId: Number(state.selectedServiceId),
      resourceId: Number(state.selectedResourceId),
      date: requestedDate,
      limit: 5,
      timeFormat,
    });
    const suggestedSlots = availability.slots || [];
    if (!suggestedSlots.length) {
      state.currentStage = 'asking_date';
      return appendAndSave(state, 'Claro, revisamos otra opción. No veo más horarios disponibles en esa fecha. Dime otra fecha y busco nuevamente.', text, 'ask_another_date');
    }
    state.pendingPayload = { ...(state.pendingPayload || {}), slots: suggestedSlots };
    state.currentStage = 'asking_time';
    return appendAndSave(state, `Claro, tengo estos horarios disponibles:
${formatSlots(suggestedSlots)}

¿Cuál prefieres?`, text, 'ask_another_time');
  }

  if (!state.requestedDate) {
    state.currentStage = 'asking_date';
    return appendAndSave(state, `Perfecto, será con ${resource.name}. ¿Para qué fecha te gustaría la cita? Puedes decirme, por ejemplo, mañana, viernes o 25/06.`, text, 'ask_date');
  }

  if (!state.requestedTime) {
    const availability = await checkReservationAvailability({ teamId: params.teamId, serviceId: state.selectedServiceId, resourceId: state.selectedResourceId, date: state.requestedDate, limit: 5, timeFormat });
    const suggestedSlots = extraction.message === 'tarde'
      ? availability.slots.filter((slot) => {
          const local = localDateAndTimeFromIso(slot.startAt, resource.timezone || settings.timezone || 'America/Santo_Domingo');
          const hour = Number(String(local?.time || '').slice(0, 2));
          return Number.isFinite(hour) && hour >= 12;
        }).slice(0, 5)
      : availability.slots;
    if (!availability.slots.length) {
      state.currentStage = 'asking_date';
      return appendAndSave(state, 'No veo horarios disponibles en esa fecha. Dime otra fecha y busco una opción para ti.', text, 'no_slots');
    }
    state.pendingPayload = { ...(state.pendingPayload || {}), slots: availability.slots };
    state.currentStage = 'asking_time';
    return appendAndSave(state, `Tengo estos horarios disponibles:\n${formatSlots(suggestedSlots)}\n\n¿Cuál te funciona mejor?`, text, 'ask_time');
  }

  let slotAvailabilityMessage: string | null = null;
  if (!clean((state.pendingPayload as any)?.selectedSlotStartAt, 120) && state.requestedDate && state.requestedTime) {
    const validation = await validateRequestedReservationSlot({
      teamId: params.teamId,
      serviceId: state.selectedServiceId,
      resourceId: state.selectedResourceId,
      date: state.requestedDate,
      time: state.requestedTime,
      timezone: resource.timezone || settings.timezone || 'America/Santo_Domingo',
      timeFormat,
    });
    if (!validation.available) {
      state = clearSelectedSlot(state);
      state.pendingPayload = { ...(state.pendingPayload || {}), slots: validation.alternatives };
      state.currentStage = validation.alternatives.length ? 'asking_time' : 'asking_date';
      const response = validation.alternatives.length
        ? `Ese horario no está disponible. Tengo estas opciones cercanas:\n${formatSlots(validation.alternatives)}\n\n¿Cuál prefieres?`
        : 'Ese horario no está disponible. Dime otra fecha y busco opciones reales para ti.';
      return appendAndSave(state, response, text, 'requested_slot_unavailable');
    }
    if (validation.slot) {
      const selected = slotToConversationState(validation.slot, resource.timezone || settings.timezone || 'America/Santo_Domingo');
      state.requestedDate = selected.requestedDate || state.requestedDate;
      state.requestedTime = selected.requestedTime || state.requestedTime;
      state.pendingPayload = {
        ...(state.pendingPayload || {}),
        selectedSlotStartAt: selected.selectedSlotStartAt,
        selectedSlotEndAt: selected.selectedSlotEndAt,
        selectedSlotLabel: selected.selectedSlotLabel,
      };
      slotAvailabilityMessage = `Sí, tengo disponible ${formatReservationDateTime(validation.slot.startAt, resource.timezone, timeFormat)}.`;
    }
  }

  if (!state.customerName) {
    state.currentStage = 'asking_customer_name';
    return appendAndSave(state, `${slotAvailabilityMessage || 'Excelente.'} ¿A nombre de quién registro la cita?`, text, 'ask_customer_name');
  }

  if (!state.customerPhone && !state.customerEmail) {
    state.currentStage = 'asking_customer_contact';
    return appendAndSave(state, 'Perfecto, envíame un teléfono o correo de contacto para completar la reserva.', text, 'ask_customer_contact');
  }

  const service = services.find((item) => item.id === state.selectedServiceId);
  const selectedSlotStartAt = clean((state.pendingPayload as any)?.selectedSlotStartAt, 120);
  const startAt = selectedSlotStartAt || startIsoFromDateTime(state.requestedDate, state.requestedTime, resource.timezone || 'America/Santo_Domingo');

  if (!settings.canCreateBookings) {
    state.currentStage = 'human_handoff_required';
    state.humanRequired = true;
    return appendAndSave(state, `Gracias. Tengo los datos para la cita de ${service?.name || 'servicio'} el ${formatReservationDateTime(startAt, resource.timezone, timeFormat)}. Un asesor la confirmará contigo.`, text, 'booking_handoff');
  }

  if (state.currentStage !== 'confirming_booking') {
    state.currentStage = 'confirming_booking';
    return appendAndSave(state, bookingSummaryText({
      serviceName: service?.name,
      resourceName: resource.name,
      startAt,
      timezone: resource.timezone,
      timeFormat,
      customerName: state.customerName,
      customerPhone: state.customerPhone,
      customerEmail: state.customerEmail,
      pending: settings.requireHumanApproval,
    }), text, 'confirm_before_create');
  }

  if (state.currentStage === 'confirming_booking' && asksRegisteredName(text)) {
    const registeredName = clean(state.customerName || updatedCustomerName || '', 120);
    if (registeredName) return appendAndSave(state, `S\u00ed, qued\u00f3 registrado como ${registeredName}.`, text, 'confirm_registered_name');
  }

  if (state.currentStage === 'confirming_booking' && changedCustomerName && !confirmedIntent) {
    return appendAndSave(state, `Listo, actualic\u00e9 el nombre a ${updatedCustomerName}. \u00bfConfirmo la cita con ese nombre?`, text, 'confirm_name_change');
  }

  if (state.currentStage === 'confirming_booking' && !confirmedIntent) {
    return appendAndSave(state, 'Claro. Dime qu\u00e9 dato quieres cambiar: servicio, especialista, fecha, horario, nombre o contacto.', text, 'confirm_adjust_data');
  }

  const created = await createReservationBookingFromAi({
    teamId: params.teamId,
    chatId: params.chatId,
    serviceId: state.selectedServiceId,
    resourceId: state.selectedResourceId,
    customerName: state.customerName,
    customerPhone: state.customerPhone || null,
    customerEmail: state.customerEmail || null,
    startAt,
    skipAvailabilityRecheck: Boolean(selectedSlotStartAt),
    timezone: resource.timezone,
    requireHumanApproval: settings.requireHumanApproval,
    createCalendarEvent: settings.canCreateCalendarEvents,
    notes: 'Creada desde Auto Cita IA',
    idempotencyKey: `auto_cita:${params.chatId}:${state.selectedServiceId}:${state.selectedResourceId || resource.id}:${startAt}`,
  });

  if (!created.ok) {
    const availability = await checkReservationAvailability({
      teamId: params.teamId,
      serviceId: state.selectedServiceId,
      resourceId: state.selectedResourceId,
      date: state.requestedDate,
      limit: 5,
      timeFormat,
    });
    state = clearSelectedSlot(state);
    state.pendingPayload = { ...(state.pendingPayload || {}), slots: availability.slots };
    state.currentStage = availability.slots.length ? 'asking_time' : 'asking_date';
    const response = availability.slots.length
      ? `Ese horario acaba de ocuparse. Te muestro otras opciones disponibles:
${formatSlots(availability.slots)}

¿Cuál prefieres?`
      : 'Ese horario acaba de ocuparse y no veo más opciones en esa fecha. Dime otra fecha y busco nuevamente.';
    return appendAndSave(state, response, text, 'create_unavailable_alternatives');
  }

  state.currentStage = 'booking_created';
  const statusText = settings.requireHumanApproval ? 'recibida y queda pendiente de confirmación' : 'confirmada';
  const calendarText = !settings.requireHumanApproval && settings.canCreateCalendarEvents
    ? (created.calendarSynced ? ' También quedó sincronizada en el calendario.' : ' La cita quedó en AllSender; el calendario externo se revisará en segundo plano.')
    : '';
  const serviceName = created.booking?.serviceName || service?.name || 'servicio';
  const namePrefix = changedCustomerName && updatedCustomerName ? `Listo, actualic\u00e9 el nombre a ${updatedCustomerName}. ` : 'Listo, ';
  const response = settings.requireHumanApproval
    ? `${namePrefix}Tu solicitud de cita fue ${statusText} para ${serviceName} el ${formatReservationDateTime(created.booking?.startAt || startAt, resource.timezone, timeFormat)}.${calendarText}`
    : `${namePrefix}tu cita fue confirmada.${calendarText}`;
  state.metadata = {
    ...(state.metadata || {}),
    active_mode: 'auto_cita',
    last_customer_name: state.customerName,
    last_booking_id: created.booking?.id || null,
  };
  await appendAndSave(state, response, text, 'create_booking');
  return { handled: true, responseText: response, action: 'create_booking' };
}
