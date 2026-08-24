import 'server-only';

import { morfGenerate } from '@/lib/morf-ai/runtime/generate';
import { findServiceByText, type ReservationResourceOption, type ReservationServiceOption } from '@/lib/modules/reservas/availability';
import type { ReservationConversationState } from '@/lib/modules/reservas/conversation-state';

export type ReservationExtractedIntent =
  | 'book_appointment'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'provide_info'
  | 'confirm'
  | 'unknown';

export type ReservationExtraction = {
  intent: ReservationExtractedIntent;
  service: string | null;
  resource: string | null;
  date: string | null;
  time: string | null;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  confirmation: boolean | null;
  message: string | null;
};

const EMPTY_EXTRACTION: ReservationExtraction = {
  intent: 'unknown',
  service: null,
  resource: null,
  date: null,
  time: null,
  customer_name: null,
  phone: null,
  email: null,
  confirmation: null,
  message: null,
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

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function toDateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function currentDateInTimezone(timezone = 'America/Santo_Domingo') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value || '0');
    return new Date(part('year'), part('month') - 1, part('day'), 12, 0, 0, 0);
  } catch {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  }
}

function extractPhone(text: string) {
  const match = text.match(/(?:\+?1[\s\-.]?)?(?:809|829|849)[\s\-.]?\d{3}[\s\-.]?\d{4}/) || text.match(/\+?\d[\d\s().-]{6,}\d/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function extractEmail(text: string) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function extractName(text: string) {
  const direct = text.match(/(?:mi nombre es|me llamo|soy|nombre(?:\s+es)?|a nombre de)\s*:?[\s]+([a-záéíóúñü.' -]{3,90})/i);
  if (direct?.[1]) return titleCase(direct[1].replace(/[.,;].*$/, '').trim());

  const withoutContact = text
    .replace(/(?:\+?1[\s\-.]?)?(?:809|829|849)[\s\-.]?\d{3}[\s\-.]?\d{4}/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/\b(confirmo|si|sí|ok|dale|perfecto)\b/gi, '')
    .trim()
    .replace(/^[,.\s]+|[,.\s]+$/g, '');

  const normalized = normalize(withoutContact);
  if (!withoutContact || /\b(cita|reserva|agenda|hora|manana|mañana|hoy|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|servicio|precio|producto|departamento|soporte)\b/.test(normalized)) {
    return null;
  }
  const words = withoutContact.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5 && /^[a-záéíóúñü.' -]+$/i.test(withoutContact)) {
    return titleCase(withoutContact);
  }
  return null;
}

function extractDate(text: string, timezone = 'America/Santo_Domingo') {
  const normalized = normalize(text);
  const today = currentDateInTimezone(timezone);

  if (/\bhoy\b/.test(normalized)) return toDateString(today);
  if (/\bmanana\b/.test(normalized)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return toDateString(d);
  }
  if (/\bpasado manana\b/.test(normalized)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    return toDateString(d);
  }

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const numeric = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = Number(numeric[3] ? (numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : today.getFullYear());
    const d = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (Number.isFinite(d.getTime())) {
      if (!numeric[3] && d < today) d.setFullYear(d.getFullYear() + 1);
      return toDateString(d);
    }
  }

  const months: Record<string, number> = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
  };
  const monthPattern = new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s*)?(${Object.keys(months).join('|')})(?:\\s*(?:de\\s*)?(\\d{4}))?\\b`, 'i');
  const monthMatch = normalized.match(monthPattern);
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const month = months[monthMatch[2]];
    const year = Number(monthMatch[3] || today.getFullYear());
    const d = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (Number.isFinite(d.getTime())) {
      if (!monthMatch[3] && d < today) d.setFullYear(d.getFullYear() + 1);
      return toDateString(d);
    }
  }

  const dayOnly = normalized.match(/\b(?:para\s+el|el|dia|día)\s+(\d{1,2})\b/);
  if (dayOnly) {
    const d = new Date(today.getFullYear(), today.getMonth(), Number(dayOnly[1]), 12, 0, 0, 0);
    if (Number.isFinite(d.getTime())) {
      if (d < today) d.setMonth(d.getMonth() + 1);
      return toDateString(d);
    }
  }

  const weekDays: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
  for (const [name, target] of Object.entries(weekDays)) {
    if (normalized.includes(name)) {
      const d = new Date(today);
      const delta = (target - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + delta);
      return toDateString(d);
    }
  }

  return null;
}

function extractTime(text: string) {
  const normalized = normalize(text);
  if (/\btarde\b/.test(normalized) && !/\d/.test(normalized)) return null;
  if (/\bmanana\b/.test(normalized) && !/\d/.test(normalized)) return null;

  const match = text.match(/\b(?:a las\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const suffix = normalize(match[3] || '');
  if (hour > 23 || minute > 59) return null;
  if ((suffix.includes('pm') || /\btarde|noche\b/.test(normalized)) && hour < 12) hour += 12;
  if (suffix.includes('am') && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function detectIntent(text: string, state?: ReservationConversationState | null): ReservationExtractedIntent {
  const normalized = normalize(text);
  if (/\b(si|sí|confirmo|confirmar|correcto|dale|ok|perfecto|esta bien|está bien)\b/.test(normalized)) return 'confirm';
  if (/\b(cancelar|anular|eliminar)\b.*\b(cita|reserva|turno)\b/.test(normalized)) return 'cancel_appointment';
  if (/\b(reprogramar|mover|cambiar)\b.*\b(cita|reserva|turno|hora|fecha)\b/.test(normalized)) return 'reschedule_appointment';
  if (/\b(cita|reserva|reservar|agenda|agendar|turno|programar)\b/.test(normalized)) return 'book_appointment';
  if (state?.currentStage && state.currentStage !== 'idle') return 'provide_info';
  return 'unknown';
}

function coerceExtraction(value: unknown): ReservationExtraction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<ReservationExtraction>;
  const allowed: ReservationExtractedIntent[] = ['book_appointment', 'reschedule_appointment', 'cancel_appointment', 'provide_info', 'confirm', 'unknown'];
  return {
    intent: allowed.includes(item.intent as ReservationExtractedIntent) ? item.intent as ReservationExtractedIntent : 'unknown',
    service: clean(item.service || '', 180) || null,
    resource: clean(item.resource || '', 180) || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(clean(item.date, 20)) ? clean(item.date, 20) : null,
    time: /^\d{2}:\d{2}$/.test(clean(item.time, 20)) ? clean(item.time, 20) : null,
    customer_name: clean(item.customer_name || '', 180) || null,
    phone: clean(item.phone || '', 40) || null,
    email: clean(item.email || '', 220).toLowerCase() || null,
    confirmation: typeof item.confirmation === 'boolean' ? item.confirmation : null,
    message: clean(item.message || '', 500) || null,
  };
}

async function extractWithAi(input: {
  teamId: number;
  text: string;
  timezone: string;
  services: ReservationServiceOption[];
  resources: ReservationResourceOption[];
  state?: ReservationConversationState | null;
  businessName?: string | null;
  businessDescription?: string | null;
  bookingPolicy?: string | null;
}) {
  try {
    const result = await morfGenerate({
      teamId: input.teamId,
      moduleCode: 'auto_calendar',
      capability: 'structured_output',
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Extrae datos de una conversacion de citas. Devuelve solo JSON estricto.',
            'No inventes servicio, recurso, fecha ni hora.',
            'Usa fecha ISO YYYY-MM-DD y hora HH:mm 24h.',
            `Zona horaria: ${input.timezone}.`,
            input.businessName ? `Empresa: ${input.businessName}.` : '',
            input.businessDescription ? `Negocio: ${input.businessDescription}.` : '',
            input.bookingPolicy ? `Reglas: ${input.bookingPolicy}.` : '',
            `Servicios reales: ${input.services.map((item) => item.name).join(', ') || 'ninguno'}.`,
            `Recursos reales: ${input.resources.map((item) => item.name).join(', ') || 'ninguno'}.`,
            `JSON: {"intent":"book_appointment|reschedule_appointment|cancel_appointment|provide_info|confirm|unknown","service":string|null,"resource":string|null,"date":string|null,"time":string|null,"customer_name":string|null,"phone":string|null,"email":string|null,"confirmation":boolean|null,"message":string|null}`,
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            message: input.text,
            previous_state: input.state || null,
            today: toDateString(currentDateInTimezone(input.timezone)),
          }),
        },
      ],
    });
    if (!result.ok || result.text == null) return null;
    const parsed = JSON.parse(result.text);
    return coerceExtraction(parsed);
  } catch (error) {
    console.warn('[reservation-ai-extractor] fallback', error);
    return null;
  }
}

function extractFallback(input: {
  text: string;
  timezone: string;
  services: ReservationServiceOption[];
  resources: ReservationResourceOption[];
  state?: ReservationConversationState | null;
}): ReservationExtraction {
  const normalized = normalize(input.text);
  const service = findServiceByText(input.text, input.services)?.name || null;
  const resource = input.resources.find((item) => {
    const name = normalize(item.name);
    return name && (normalized.includes(name) || name.split(/\s+/).some((word) => word.length >= 4 && normalized.includes(word)));
  })?.name || null;
  const confirmation = /\b(si|sí|confirmo|confirmar|correcto|dale|ok|perfecto|esta bien|está bien)\b/.test(normalized) ? true : null;

  return {
    ...EMPTY_EXTRACTION,
    intent: detectIntent(input.text, input.state),
    service,
    resource,
    date: extractDate(input.text, input.timezone),
    time: extractTime(input.text),
    customer_name: extractName(input.text),
    phone: extractPhone(input.text),
    email: extractEmail(input.text),
    confirmation,
    message: /\btarde\b/.test(normalized) && !extractTime(input.text) ? 'tarde' : null,
  };
}

export async function extractReservationConversationData(input: {
  teamId: number;
  text: string;
  timezone?: string | null;
  services: ReservationServiceOption[];
  resources: ReservationResourceOption[];
  state?: ReservationConversationState | null;
  settings?: {
    businessName?: string | null;
    businessDescription?: string | null;
    bookingPolicy?: string | null;
  } | null;
}): Promise<ReservationExtraction> {
  const timezone = clean(input.timezone || 'America/Santo_Domingo', 80) || 'America/Santo_Domingo';
  const fallback = extractFallback({ text: input.text, timezone, services: input.services, resources: input.resources, state: input.state });
  const ai = await extractWithAi({
    teamId: input.teamId,
    text: input.text,
    timezone,
    services: input.services,
    resources: input.resources,
    state: input.state,
    businessName: input.settings?.businessName,
    businessDescription: input.settings?.businessDescription,
    bookingPolicy: input.settings?.bookingPolicy,
  });

  return {
    intent: ai?.intent && ai.intent !== 'unknown' ? ai.intent : fallback.intent,
    service: ai?.service || fallback.service,
    resource: ai?.resource || fallback.resource,
    date: ai?.date || fallback.date,
    time: ai?.time || fallback.time,
    customer_name: ai?.customer_name || fallback.customer_name,
    phone: ai?.phone || fallback.phone,
    email: ai?.email || fallback.email,
    confirmation: ai?.confirmation ?? fallback.confirmation,
    message: ai?.message || fallback.message,
  };
}
