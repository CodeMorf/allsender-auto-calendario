import 'server-only';

export type NylasRuntimeConfig = {
  enabled: boolean;
  apiKey: string;
  clientId: string;
  apiUri: string;
  callbackUrl: string;
};

export type NylasTokenResponse = {
  access_token?: string;
  token_type?: string;
  id_token?: string;
  grant_id?: string;
  email?: string;
  email_address?: string;
  provider?: string;
  provider_user_id?: string;
  [key: string]: unknown;
};

export type NylasAvailabilitySlot = {
  start_time?: number;
  end_time?: number;
  emails?: string[];
  [key: string]: unknown;
};

export type NylasAvailabilityResponse = {
  request_id?: string;
  data?: {
    time_slots?: NylasAvailabilitySlot[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type NylasCreateEventInput = {
  grantId: string;
  calendarId?: string | null;
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  customerEmail?: string | null;
  customerName?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

function clean(value: string | undefined | null) {
  return String(value || '').trim();
}

function roundUnixToFiveMinutes(value: number, direction: 'floor' | 'ceil') {
  const step = 5 * 60;
  return direction === 'ceil' ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
}

function cleanMetadata(metadata?: Record<string, string | number | boolean | null>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === null || value === undefined) continue;
    // Nylas v3 Event metadata accepts string values only.
    // Convert internal numeric ids/booleans to strings to avoid:
    // "Invalid metadata. Got type number, expected type string".
    out[key] = String(value);
  }
  return out;
}

export function getNylasRuntimeConfig(): NylasRuntimeConfig {
  const apiUri = clean(process.env.NYLAS_API_URI) || 'https://api.us.nylas.com';
  const callbackUrl =
    clean(process.env.NYLAS_CALLBACK_URL) ||
    clean(process.env.NYLAS_REDIRECT_URI) ||
    `${clean(process.env.NEXT_PUBLIC_APP_URL) || clean(process.env.BASE_URL)}/api/reservas/nylas/callback`;

  return {
    enabled: clean(process.env.NYLAS_ENABLED).toLowerCase() !== 'false',
    apiKey: clean(process.env.NYLAS_API_KEY),
    clientId: clean(process.env.NYLAS_CLIENT_ID),
    apiUri: apiUri.replace(/\/$/, ''),
    callbackUrl,
  };
}

export function getNylasMissingConfig(config = getNylasRuntimeConfig()) {
  const missing: string[] = [];
  if (!config.enabled) missing.push('NYLAS_ENABLED');
  if (!config.apiKey) missing.push('NYLAS_API_KEY');
  if (!config.clientId) missing.push('NYLAS_CLIENT_ID');
  if (!config.callbackUrl) missing.push('NYLAS_CALLBACK_URL');
  return missing;
}

export function buildNylasOAuthUrl({
  provider = 'google',
  state,
  loginHint,
}: {
  provider?: string;
  state: string;
  loginHint?: string;
}) {
  const config = getNylasRuntimeConfig();
  const missing = getNylasMissingConfig(config);
  if (missing.length) {
    throw new Error(`Faltan variables Nylas: ${missing.join(', ')}`);
  }

  const url = new URL('/v3/connect/auth', config.apiUri);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('provider', provider);
  url.searchParams.set('state', state);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

export async function exchangeNylasCode(code: string): Promise<NylasTokenResponse> {
  const config = getNylasRuntimeConfig();
  const missing = getNylasMissingConfig(config);
  if (missing.length) {
    throw new Error(`Faltan variables Nylas: ${missing.join(', ')}`);
  }

  const response = await fetch(`${config.apiUri}/v3/connect/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.apiKey,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: 'nylas',
    }),
    cache: 'no-store',
  });

  const data = (await response.json().catch(() => ({}))) as NylasTokenResponse & { error?: unknown };
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : JSON.stringify(data || {});
    throw new Error(`Nylas token error ${response.status}: ${message}`);
  }
  return data;
}

export async function getNylasGrantInfo(grantId: string) {
  const config = getNylasRuntimeConfig();
  if (!config.apiKey || !grantId) return null;
  const response = await fetch(`${config.apiUri}/v3/grants/${encodeURIComponent(grantId)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    cache: 'no-store',
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as any;
}

export async function getNylasAvailability(input: {
  participantEmail: string;
  calendarId?: string | null;
  startTime: number;
  endTime: number;
  durationMinutes: number;
  intervalMinutes?: number;
  timezone: string;
  openHours: Array<{ days: number[]; start: string; end: string; timezone: string; exdates?: string[] }>;
  bufferBefore?: number;
  bufferAfter?: number;
}) {
  const config = getNylasRuntimeConfig();
  if (!config.enabled || !config.apiKey) {
    throw new Error('Nylas no está configurado.');
  }

  const response = await fetch(`${config.apiUri}/v3/calendars/availability`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      participants: [
        {
          email: input.participantEmail,
          calendar_ids: [input.calendarId || 'primary'],
          open_hours: input.openHours,
        },
      ],
      start_time: roundUnixToFiveMinutes(input.startTime, 'floor'),
      end_time: roundUnixToFiveMinutes(input.endTime, 'ceil'),
      interval_minutes: input.intervalMinutes || 30,
      duration_minutes: input.durationMinutes,
      round_to: 15,
      availability_rules: {
        availability_method: 'collective',
        buffer: {
          before: input.bufferBefore || 0,
          after: input.bufferAfter || 0,
        },
        default_open_hours: input.openHours,
      },
    }),
    cache: 'no-store',
  });

  const data = (await response.json().catch(() => ({}))) as NylasAvailabilityResponse & { error?: unknown };
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : JSON.stringify(data || {});
    throw new Error(`Nylas availability error ${response.status}: ${message}`);
  }
  return data;
}

export async function createNylasCalendarEvent(input: NylasCreateEventInput) {
  const config = getNylasRuntimeConfig();
  if (!config.enabled || !config.apiKey) {
    throw new Error('Nylas no está configurado.');
  }

  const startTime = roundUnixToFiveMinutes(Math.floor(new Date(input.startAt).getTime() / 1000), 'floor');
  const endTime = roundUnixToFiveMinutes(Math.floor(new Date(input.endAt).getTime() / 1000), 'ceil');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error('Rango de fecha/hora inválido para crear evento.');
  }

  const url = new URL(`${config.apiUri}/v3/grants/${encodeURIComponent(input.grantId)}/events`);
  url.searchParams.set('calendar_id', input.calendarId || 'primary');
  url.searchParams.set('notify_participants', input.customerEmail ? 'true' : 'false');

  const participants = input.customerEmail
    ? [
        {
          name: input.customerName || input.customerEmail,
          email: input.customerEmail,
        },
      ]
    : [];

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      description: input.description || 'Reserva creada desde AllSender Reservas IA.',
      when: {
        start_time: startTime,
        end_time: endTime,
        start_timezone: input.timezone,
        end_timezone: input.timezone,
      },
      busy: true,
      participants,
      metadata: cleanMetadata(input.metadata),
    }),
    cache: 'no-store',
  });

  const data = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : JSON.stringify(data || {});
    throw new Error(`Nylas create event error ${response.status}: ${message}`);
  }
  return data;
}

export type NylasUpdateEventInput = {
  grantId: string;
  eventId: string;
  calendarId?: string | null;
  title?: string;
  description?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  customerEmail?: string | null;
  customerName?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

function buildEventPayload(input: {
  title?: string;
  description?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  customerEmail?: string | null;
  customerName?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const payload: Record<string, unknown> = {};
  if (input.title) payload.title = input.title;
  if (input.description !== undefined) payload.description = input.description || 'Reserva creada desde AllSender Reservas IA.';

  if (input.startAt && input.endAt) {
    const startTime = roundUnixToFiveMinutes(Math.floor(new Date(input.startAt).getTime() / 1000), 'floor');
    const endTime = roundUnixToFiveMinutes(Math.floor(new Date(input.endAt).getTime() / 1000), 'ceil');
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      throw new Error('Rango de fecha/hora inválido para evento Nylas.');
    }
    payload.when = {
      start_time: startTime,
      end_time: endTime,
      start_timezone: input.timezone || 'America/Santo_Domingo',
      end_timezone: input.timezone || 'America/Santo_Domingo',
    };
  }

  if (input.customerEmail !== undefined) {
    payload.participants = input.customerEmail
      ? [
          {
            name: input.customerName || input.customerEmail,
            email: input.customerEmail,
          },
        ]
      : [];
  }

  payload.busy = true;
  if (input.metadata) payload.metadata = cleanMetadata(input.metadata);
  return payload;
}

export async function updateNylasCalendarEvent(input: NylasUpdateEventInput) {
  const config = getNylasRuntimeConfig();
  if (!config.enabled || !config.apiKey) {
    throw new Error('Nylas no está configurado.');
  }
  if (!input.grantId || !input.eventId) {
    throw new Error('Falta grant_id o event_id para actualizar evento Nylas.');
  }

  const url = new URL(`${config.apiUri}/v3/grants/${encodeURIComponent(input.grantId)}/events/${encodeURIComponent(input.eventId)}`);
  url.searchParams.set('calendar_id', input.calendarId || 'primary');
  url.searchParams.set('notify_participants', input.customerEmail ? 'true' : 'false');

  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildEventPayload(input)),
    cache: 'no-store',
  });

  const data = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : JSON.stringify(data || {});
    throw new Error(`Nylas update event error ${response.status}: ${message}`);
  }
  return data;
}

export async function deleteNylasCalendarEvent(input: { grantId: string; eventId: string; calendarId?: string | null; notifyParticipants?: boolean }) {
  const config = getNylasRuntimeConfig();
  if (!config.enabled || !config.apiKey) {
    throw new Error('Nylas no está configurado.');
  }
  if (!input.grantId || !input.eventId) {
    throw new Error('Falta grant_id o event_id para eliminar evento Nylas.');
  }

  const url = new URL(`${config.apiUri}/v3/grants/${encodeURIComponent(input.grantId)}/events/${encodeURIComponent(input.eventId)}`);
  url.searchParams.set('calendar_id', input.calendarId || 'primary');
  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  const data = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : JSON.stringify(data || {});
    throw new Error(`Nylas delete event error ${response.status}: ${message}`);
  }
  return data;
}

export function encodeNylasState(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ ...payload, ts: Date.now() }), 'utf8').toString('base64url');
}

export function decodeNylasState(state: string | null) {
  if (!state) return null;
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
