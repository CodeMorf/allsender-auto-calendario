import { db } from '@/lib/db/drizzle';
import { 
  automations, 
  automationSessions, 
  contacts, 
  contactTags, 
  messages, 
  evolutionInstances, 
  aiSessions, 
  chats 
} from '@/lib/db/schema';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { Node, Edge } from '@xyflow/react';
import fs from 'fs/promises';
import path from 'path';
import { pusherServer } from '@/lib/pusher-server';
import { sendMetaMediaMessage, sendMetaTextMessage, uploadMetaMediaFromBase64 } from '@/lib/meta/whatsapp';
import { tryHandleReservationAiMessage, type ReservationAgentResult } from '@/lib/modules/reservas/agent';
import { getReservationConversationState } from '@/lib/modules/reservas/conversation-state';
import { shouldRouteAutoCalendarMessage } from '@/lib/modules/reservas/routing-guard';
import { tryHandleSalesAiMessage } from '@/lib/modules/sales-ai/orchestrator';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const GRAPH_API_URL = "https://graph.facebook.com";
const GRAPH_API_VERSION = "v21.0";

type FlowData = {
  nodes: Node[];
  edges: Edge[];
};

type StartNodeData = {
    triggerType: 'exact_match' | 'contains' | 'first_message' | 'fallback';
    keywords?: string[];
    conditions?: {
        funnelStageId?: string;
        tagId?: string;
        assignedUserId?: string;
    }
};

type InstanceConfig = {
    instanceName: string;
    accessToken: string;
    metaToken?: string | null;
    metaPhoneNumberId?: string | null;
};

export type AutomationChannel = 'whatsapp' | 'webchat' | 'zernio';

/** Envío canal-específico (widget webchat, Zernio, etc.). Sin él se usa Evolution/Meta. */
export type AutomationSendFn = (
    remoteJid: string,
    endpoint: 'sendText' | 'sendMedia',
    contentPayload: any,
    teamId: number,
    chatId: number,
    localMediaUrl?: string
) => Promise<void>;

export type AutomationOptions = {
    channel?: AutomationChannel;
    send?: AutomationSendFn;
};

function replaceVariables(text: string, variables: Record<string, any> | null): string {
    if (!text || !variables) return text;
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        return variables[key] || "";
    });
}

async function fileToBase64(filePath: string): Promise<string | null> {
    try {
        const fileBuffer = await fs.readFile(filePath);
        return fileBuffer.toString('base64');
    } catch (error) {
        return null;
    }
}


function normalizeAutomationTemplateText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s:_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Dedup interno (Gap 2): processAutomation no depende del dedup del webhook. ──
// Ráfagas de mensajes IGUALES (mismo messageId o mismo texto normalizado) se
// tragan a propósito; ráfagas de mensajes DIFERENTES siguen procesándose (sería
// comerse preguntas reales). El claim solo se aplica cuando el equipo tiene
// contexto de automatización (sesión activa o automatizaciones activas).
const AUTOMATION_DEDUP_WINDOW_MS = 20_000;
const AUTOMATION_DEDUP_MAX_ENTRIES = 512;
const automationRecentClaims = new Map<string, number>();

function normalizeAutomationDedupText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneAutomationClaims() {
  const now = Date.now();
  for (const [key, ts] of automationRecentClaims) {
    if (now - ts > AUTOMATION_DEDUP_WINDOW_MS) automationRecentClaims.delete(key);
  }
}

/**
 * Marca/consulta la reclamación en memoria. Devuelve true si este mensaje ya fue
 * reclamado (redelivery). Cuando hay sesión activa el texto puede ser una
 * respuesta legítima repetida de un menú (p. ej. "1" en dos niveles seguidos),
 * así que solo se deduplica por texto en contexto de disparo fresco (sin sesión).
 */
function isDuplicateAutomationMessage(teamId: number, chatId: number, messageId: string | undefined, text: string, hasActiveSession: boolean): boolean {
  pruneAutomationClaims();
  const now = Date.now();
  const idKey = `${teamId}:${chatId}:id:${messageId || ''}`;
  if (messageId && automationRecentClaims.has(idKey)) return true;
  if (!hasActiveSession) {
    const textKey = `${teamId}:${chatId}:text:${normalizeAutomationDedupText(text)}`;
    if (automationRecentClaims.has(textKey)) return true;
    automationRecentClaims.set(textKey, now);
  }
  automationRecentClaims.set(idKey, now);
  if (automationRecentClaims.size > AUTOMATION_DEDUP_MAX_ENTRIES) pruneAutomationClaims();
  return false;
}

/**
 * Capa restart-safe: si ya existe una respuesta de automatización para este
 * mismo texto en los últimos segundos, es una redelivery (p. ej. proceso
 * reiniciado entre la primera y la segunda copia). Solo aplica en contexto de
 * disparo fresco, igual que el claim en memoria.
 */
async function hasRecentAutomationReply(teamId: number, chatId: number, text: string): Promise<boolean> {
  const normalized = normalizeAutomationDedupText(text);
  if (!normalized) return false;
  try {
    const result = await db.execute(sql`
      SELECT 1
      FROM messages m
      WHERE m.chat_id = ${chatId}
        AND m.from_me = false
        AND lower(btrim(m.text)) = ${normalized}
        AND m.timestamp >= now() - interval '20 seconds'
        AND EXISTS (
          SELECT 1 FROM messages o
          WHERE o.chat_id = m.chat_id
            AND o.from_me = true
            AND o.is_automation = true
            AND o.timestamp >= m.timestamp
        )
      LIMIT 1
    `);
    return automationRows(result).length > 0;
  } catch {
    return false;
  }
}

/** ¿El equipo tiene automatizaciones activas para este contexto (instancia o globales)? */
async function teamHasActiveAutomations(teamId: number, instanceId: number): Promise<boolean> {
  try {
    const rows = await db.select({ id: automations.id }).from(automations)
      .where(and(
        eq(automations.teamId, teamId),
        eq(automations.isActive, true),
        or(eq(automations.instanceId, instanceId), isNull(automations.instanceId))
      ))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resuelve la configuración de instancia. Con un `send` canal-específico se usa
 * una config virtual (webchat / zernio no tienen instancia Evolution con token);
 * sin `send` se exige una instancia Evolution/Meta real con token.
 */
async function resolveAutomationConfig(
  instanceData: { instanceName: string; accessToken: string },
  instanceId: number,
  channel: AutomationChannel,
  send?: AutomationSendFn
): Promise<InstanceConfig | null> {
  if (send) {
    return {
      accessToken: instanceData?.accessToken || 'channel-direct',
      instanceName: instanceData?.instanceName || channel,
    };
  }
  if (instanceId > 0) {
    const instance = await db.query.evolutionInstances.findFirst({
      where: eq(evolutionInstances.id, instanceId),
      columns: { accessToken: true, instanceName: true, metaToken: true, metaPhoneNumberId: true }
    });
    if (instance && (instance.accessToken || instance.metaToken)) {
      return {
        accessToken: instance.accessToken || 'meta-direct',
        instanceName: instance.instanceName,
        metaToken: instance.metaToken,
        metaPhoneNumberId: instance.metaPhoneNumberId
      };
    }
  }
  return null;
}

/** Envía por el canal inyectado si existe; si no, por Evolution/Meta (WhatsApp). */
async function sendAutomationMessage(
  send: AutomationSendFn | undefined,
  instance: InstanceConfig,
  remoteJid: string,
  endpoint: 'sendText' | 'sendMedia',
  contentPayload: any,
  teamId: number,
  chatId: number,
  localMediaUrl?: string
): Promise<void> {
  if (send) {
    await send(remoteJid, endpoint, contentPayload, teamId, chatId, localMediaUrl);
  } else {
    await sendEvolutionMessage(instance, remoteJid, endpoint, contentPayload, teamId, chatId, localMediaUrl);
  }
}

function isAutoCalendarAutomation(automation: any) {
  const name = normalizeAutomationTemplateText(automation?.name);
  const trigger = normalizeAutomationTemplateText(automation?.triggerKeyword || automation?.trigger_keyword);
  const nodesText = normalizeAutomationTemplateText(JSON.stringify(automation?.nodes || []));
  return (
    trigger.includes('auto_calendar')
    || trigger.includes('calendar')
    || name.includes('auto calendario')
    || name.includes('auto cita')
    || nodesText.includes('templatekey auto_calendar')
    || nodesText.includes('templatekey:auto_calendar')
  );
}

async function findActiveAutoCalendarAutomation(teamId: number, instanceId: number) {
  const activeAutomations = await db.query.automations.findMany({
    where: and(
      eq(automations.teamId, teamId),
      eq(automations.isActive, true),
      or(eq(automations.instanceId, instanceId), isNull(automations.instanceId))
    ),
    columns: { id: true, name: true, triggerKeyword: true, instanceId: true, nodes: true },
  }).catch(() => [] as any[]);

  const specific = activeAutomations.find((automation: any) => automation.instanceId === instanceId && isAutoCalendarAutomation(automation));
  if (specific) return specific;
  return activeAutomations.find((automation: any) => !automation.instanceId && isAutoCalendarAutomation(automation)) || null;
}

async function processAutoCalendarAutomationRouting(
  teamId: number,
  chatId: number,
  remoteJid: string,
  incomingText: string,
  instance: InstanceConfig,
  instanceId: number,
  send?: AutomationSendFn,
  messageId?: string
): Promise<boolean> {
  const activeAutoCalendar = await findActiveAutoCalendarAutomation(teamId, instanceId);
  if (!activeAutoCalendar) return false;

  const reservationState = await getReservationConversationState(teamId, chatId).catch(() => null);
  const hasActiveReservationFlow = Boolean(
    reservationState?.currentStage && reservationState.currentStage !== 'idle'
  );
  if (!shouldRouteAutoCalendarMessage(incomingText, hasActiveReservationFlow)) return false;

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.teamId, teamId), eq(contacts.chatId, chatId)),
    columns: { id: true },
  }).catch(() => null as any);

  const result: ReservationAgentResult = await tryHandleReservationAiMessage({
    teamId,
    chatId,
    text: incomingText,
    channel: 'automation',
    contactId: contact?.id || null,
    force: false,
  }).catch((error: any) => ({
    handled: false,
    reason: error?.message || 'reservation_agent_error',
  }));

  if (result?.handled && result.responseText) {
    await sendAutomationMessage(send, instance, remoteJid, 'sendText', { text: result.responseText }, teamId, chatId);
    return true;
  }

  if (result?.handled) return true;

  if (['agent_inactive', 'conversation_state_missing'].includes(String(result?.reason || ''))) {
    await sendAutomationMessage(
      send,
      instance,
      remoteJid,
      'sendText',
      { text: 'Gracias por escribir. El equipo confirmará la disponibilidad de la cita contigo.' },
      teamId,
      chatId
    );
    return true;
  }

  return false;
}



function isInternalSalesFlowLabel(text: unknown) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  // Labels from "Venta IA asistida avanzada" template must never reach WhatsApp
  if (/\b(buscar producto real|responder como vendedor|confirmar opci[oó]n|activar agente|entender intenci[oó]n|validar entrega|crear orden segura|postventa|flowStates|templateKey)\b/i.test(value)) return true;
  if (/^(Buscar|Responder|Confirmar|Activar|Entender|Validar|Crear|Mostrar|Pedir|Escalar)\b/.test(value) && value.length <= 90 && !/[?¿]/.test(value)) return true;
  // Branches template / system instructions must never reach WhatsApp
  if (/sucursales\s*ia|compara el mensaje|palabras clave y sucursales|si falta informaci[oó]n|detectar ubicaci[oó]n|transferir al equipo asignado|preguntar ciudad/i.test(value)) return true;
  if (/^(Preguntar|Detectar|Transferir|Comparar|Enrutar|Derivar|Activar|Validar|Consultar)\b/i.test(value) && value.length <= 140 && !/[?¿]/.test(value)) return true;
  if (/ia pausada|cola de sucursal|quien tome primero|sin ubicaci[oó]n clara|proveedor ia|templatekey|force_module|groq|ollama/i.test(value)) return true;
  // RestaPP AI conductor labels (seen leaked live: "Recomendar del menú real", "Personalizaciones y modificadores")
  if (/recomendar del men[uú] real|personalizaciones y modificadores|men[uú] real|armar pedido|confirmar resumen|validar cobertura|modalidad de entrega|cobertura delivery|extras y variantes/i.test(value)) return true;
  if (/^(Recomendar|Personalizar|Armar|Registrar|Ofrecer|Consultar men[uú]|Filtrar|Mostrar opciones|Enviar foto)\b/i.test(value) && value.length <= 120 && !/[?¿]/.test(value)) return true;
  if (/\b(restapp|templatekey restapp|exclusive_restapp|operatingMode|modificadores_extras|buscar_menu|recomendar_productos)\b/i.test(value)) return true;
  // Generic conductor labels (not customer-facing questions)
  if (value.length <= 100 && !/[?¿!.]/.test(value) && /\b(ia|automaci[oó]n|nodo|flujo|template|sistema)\b/i.test(value)) return true;
  // Short imperative labels without question marks are almost never customer copy
  if (value.length <= 80 && !/[?¿]/.test(value) && !/\b(hola|gracias|pedido|reserva|delivery|rd\$|dop)\b/i.test(value) && /^[A-ZÁÉÍÓÚÑ]/.test(value) && !/[.]{2,}/.test(value)) {
    if (/\b(y|del|de|la|el|los|las|para|con|sin)\b/i.test(value) && value.split(/\s+/).length <= 6) return true;
  }
  return false;
}

function shouldSilenceAutomationCustomerMessage(node: any, automation?: any) {
  const label = String(node?.data?.label || node?.data?.bodyText || '');
  if (isInternalSalesFlowLabel(label)) return true;
  if (automation && isSalesAiAutomation(automation)) {
    // sales_ai graph is a conductor only; never dump node labels as bot messages
    if (node?.type === 'message' || node?.type === 'options' || node?.type === 'collect') return true;
  }
  // Branches automation is UI-only conductor; Sucursales module owns customer messages
  if (automation && isBranchesAutomation(automation)) {
    if (node?.type === 'message' || node?.type === 'options' || node?.type === 'collect') return true;
  }
  // RestaPP template is conductor only — RestaPP module + Intelligence own WhatsApp copy
  if (automation && isRestappAiAutomation(automation)) {
    if (node?.type === 'message' || node?.type === 'options' || node?.type === 'collect') return true;
  }
  return false;
}

function isBranchesAutomation(automation: any) {
  const name = normalizeAutomationTemplateText(automation?.name);
  const trigger = normalizeAutomationTemplateText(automation?.triggerKeyword || automation?.trigger_keyword);
  const nodesText = normalizeAutomationTemplateText(JSON.stringify(automation?.nodes || []));
  return (
    trigger.includes('template:branches')
    || trigger.includes('branches:global')
    || name.includes('enrutamiento por sucursales')
    || name.includes('sucursales') && nodesText.includes('templatekey branches')
    || nodesText.includes('templatekey branches')
    || nodesText.includes('templatekey:branches')
  );
}

function isSalesAiAutomation(automation: any) {
  const name = normalizeAutomationTemplateText(automation?.name);
  const trigger = normalizeAutomationTemplateText(automation?.triggerKeyword || automation?.trigger_keyword);
  const nodesText = normalizeAutomationTemplateText(JSON.stringify(automation?.nodes || []));
  return (
    trigger.includes('sales_ai')
    || name.includes('venta ia')
    || name.includes('ventas ia')
    || nodesText.includes('templatekey sales_ai')
    || nodesText.includes('templatekey:sales_ai')
  );
}

function isRestappAiAutomation(automation: any) {
  const name = normalizeAutomationTemplateText(automation?.name);
  const trigger = normalizeAutomationTemplateText(automation?.triggerKeyword || automation?.trigger_keyword);
  const nodesText = normalizeAutomationTemplateText(JSON.stringify(automation?.nodes || []));
  return (
    trigger.includes('restapp_ai')
    || trigger.includes('restapp')
    || name.includes('restapp')
    || name.includes('restaurante')
    || name.includes('restaurapp')
    || nodesText.includes('templatekey restapp_ai')
    || nodesText.includes('templatekey:restapp_ai')
    || nodesText.includes('exclusive_restapp')
  );
}

async function findActiveRestappAiAutomation(teamId: number, instanceId: number) {
  const activeAutomations = await db.query.automations.findMany({
    where: and(
      eq(automations.teamId, teamId),
      eq(automations.isActive, true),
      or(eq(automations.instanceId, instanceId), isNull(automations.instanceId))
    ),
    columns: { id: true, name: true, triggerKeyword: true, instanceId: true, nodes: true },
  }).catch(() => [] as any[]);

  const specific = activeAutomations.find(
    (automation: any) => automation.instanceId === instanceId && isRestappAiAutomation(automation)
  );
  if (specific) return specific;
  return activeAutomations.find((automation: any) => !automation.instanceId && isRestappAiAutomation(automation)) || null;
}

/**
 * The external RestaPP/Intelligence motor was retired. Existing automation
 * records remain inert and cannot call the retired service.
 */
async function processRestappAiAutomationRouting(
  _teamId: number,
  _chatId: number,
  _remoteJid: string,
  _incomingText: string,
  _instance: InstanceConfig,
  _instanceId: number,
  _send?: AutomationSendFn,
  _messageId?: string,
): Promise<boolean> {
  return false;
}

async function findActiveSalesAiAutomation(teamId: number, instanceId: number) {
  const activeAutomations = await db.query.automations.findMany({
    where: and(
      eq(automations.teamId, teamId),
      eq(automations.isActive, true),
      or(eq(automations.instanceId, instanceId), isNull(automations.instanceId))
    ),
    columns: { id: true, name: true, triggerKeyword: true, instanceId: true, nodes: true },
  }).catch(() => [] as any[]);

  const specific = activeAutomations.find((automation: any) => automation.instanceId === instanceId && isSalesAiAutomation(automation));
  if (specific) return specific;
  return activeAutomations.find((automation: any) => !automation.instanceId && isSalesAiAutomation(automation)) || null;
}

function automationRows(result: unknown): Record<string, any>[] {
  if (Array.isArray(result)) return result as Record<string, any>[];
  const maybe = result as { rows?: Record<string, any>[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function jsonValue(value: unknown, fallback: unknown) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

async function getSalesAiAutomationState(teamId: number, chatId: number) {
  const result = await db.execute(sql`
    SELECT
      current_stage AS "currentStage",
      selected_product_id AS "selectedProductId",
      selected_product_name AS "selectedProductName",
      selected_product_price AS "selectedProductPrice",
      customer_name AS "customerName",
      customer_phone AS "customerPhone",
      customer_address AS "customerAddress",
      delivery_address_text AS "deliveryAddressText",
      delivery_maps_url AS "deliveryMapsUrl",
      delivery_lat AS "deliveryLat",
      delivery_lng AS "deliveryLng",
      delivery_notes AS "deliveryNotes",
      payment_status AS "paymentStatus",
      last_products_sent AS "lastProductsSent",
      pending_choice_type AS "pendingChoiceType",
      pending_choices AS "pendingChoices",
      missing_data AS "missingData",
      order_draft AS "orderDraft",
      memory_summary AS "memorySummary"
    FROM ai_sales_conversation_state
    WHERE team_id = ${teamId}
      AND chat_id = ${chatId}
    LIMIT 1
  `).catch(() => null);

  const row = automationRows(result)[0];
  if (!row) return null;

  return {
    chatId,
    currentStage: row.currentStage || null,
    selectedProductId: row.selectedProductId || null,
    selectedProductName: row.selectedProductName || null,
    selectedProductPrice: row.selectedProductPrice ? Number(row.selectedProductPrice) : null,
    customerName: row.customerName || null,
    customerPhone: row.customerPhone || null,
    customerAddress: row.customerAddress || null,
    deliveryAddressText: row.deliveryAddressText || null,
    deliveryMapsUrl: row.deliveryMapsUrl || null,
    deliveryLat: row.deliveryLat ? Number(row.deliveryLat) : null,
    deliveryLng: row.deliveryLng ? Number(row.deliveryLng) : null,
    deliveryNotes: row.deliveryNotes || null,
    paymentStatus: row.paymentStatus || null,
    lastProductsSent: jsonValue(row.lastProductsSent, []),
    pendingChoiceType: row.pendingChoiceType || null,
    pendingChoices: jsonValue(row.pendingChoices, []),
    missingData: jsonValue(row.missingData, []),
    orderDraft: jsonValue(row.orderDraft, {}),
    memorySummary: jsonValue(row.memorySummary, {}),
  };
}

async function processSalesAiAutomationRouting(
  teamId: number,
  chatId: number,
  remoteJid: string,
  incomingText: string,
  instance: InstanceConfig,
  instanceId: number,
  send?: AutomationSendFn,
  messageId?: string
): Promise<boolean> {
  const activeSalesAi = await findActiveSalesAiAutomation(teamId, instanceId);
  if (!activeSalesAi) return false;

  const state = await getSalesAiAutomationState(teamId, chatId);

  const result = await tryHandleSalesAiMessage({
    teamId,
    chatId,
    text: incomingText,
    intent: {} as any,
    state: state as any,
    hasImage: false,
    imageUrl: null,
    imageMimeType: null,
  }).catch((error: any) => {
    console.error('[Automation][SalesAI] handler failed', error);
    return null;
  });

  if (result?.handled && result.responseText) {
    // Phase 6: autonomous generation is handled by internal SaaS agents and configured providers.
    await sendAutomationMessage(send, instance, remoteJid, 'sendText', { text: result.responseText }, teamId, chatId);
    return true;
  }

  // A handled result without text may represent a deliberate no-reply action.
  if (result?.handled) return true;

  // Sales AI is disabled or unavailable. Do not send a generic response and do not
  // consume the message: release it for the normal human/routing pipeline.
  console.info('[Automation][SalesAI] released message', {
    teamId,
    chatId,
    instanceId,
    reason: 'sales_ai_disabled_or_unavailable',
  });
  return false;
}

export async function processAutomation(
  teamId: number,
  chatId: number,
  remoteJid: string,
  incomingText: string,
  instanceData: { instanceName: string; accessToken: string }, 
  instanceId: number,
  messageId?: string,
  options?: AutomationOptions
): Promise<boolean> {
  const text = incomingText.trim();
  const channel = options?.channel || 'whatsapp';
  const send = options?.send;

  const config = await resolveAutomationConfig(instanceData, instanceId, channel, send);
  if (!config) return false;

  // Sesión activa arriba: define contexto de dedup y propiedad exclusiva del chat.
  let session = await db.query.automationSessions.findFirst({
    where: and(
      eq(automationSessions.chatId, chatId),
      eq(automationSessions.status, 'active')
    ),
    with: { automation: true }
  });

  // Gate de contexto: sin sesión y sin automatizaciones activas del equipo, el
  // mensaje NO se reclama ni se traga (departamentos/IA deben seguir
  // respondiendo duplicados en equipos sin auto-chat).
  if (!session) {
    const hasContext = await teamHasActiveAutomations(teamId, instanceId);
    if (!hasContext) return false;
  }

  // Dedup interno (Gap 2): redeliveries del mismo messageId/texto dentro de la
  // ventana se tragan a propósito; ráfagas de textos DIFERENTES siguen su flujo.
  if (isDuplicateAutomationMessage(teamId, chatId, messageId, text, Boolean(session))) {
    console.info('[Automation] duplicate skipped (internal dedup)', { teamId, chatId, messageId, channel });
    return true;
  }

  // Capa restart-safe del dedup (p. ej. reinicio del proceso entre copias).
  if (!session && await hasRecentAutomationReply(teamId, chatId, text)) {
    console.info('[Automation] duplicate skipped (recent automation reply)', { teamId, chatId, messageId, channel });
    return true;
  }

  const autoCalendarHandled = await processAutoCalendarAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
  if (autoCalendarHandled) return true;

  const restappAiHandled = await processRestappAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
  if (restappAiHandled) return true;

  const salesAiHandled = await processSalesAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
  if (salesAiHandled) return true;

  // Active restapp_ai sessions must never walk message nodes (labels leak to WhatsApp)
  if (session?.automation && isRestappAiAutomation(session.automation)) {
    const forced = await processRestappAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
    if (forced) {
      await db.update(automationSessions).set({ status: 'completed', updatedAt: new Date() }).where(eq(automationSessions.id, session.id)).catch(() => null);
      return true;
    }
    await db.update(automationSessions).set({ status: 'completed', updatedAt: new Date() }).where(eq(automationSessions.id, session.id)).catch(() => null);
    return true;
  }

  // Active sales_ai sessions must never walk message nodes (labels leak to WhatsApp)
  if (session?.automation && isSalesAiAutomation(session.automation)) {
    const forced = await processSalesAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
    if (forced) return true;
    await db.update(automationSessions).set({ status: 'completed', updatedAt: new Date() }).where(eq(automationSessions.id, session.id)).catch(() => null);
    // The stale Sales AI session is closed, but the current message remains unhandled.
    return false;
  }

  // Branches template must NEVER own the WhatsApp chat (leaks node labels).
  // Close any active branches session and fall through so processBranchRouting handles it.
  if (session?.automation && isBranchesAutomation(session.automation)) {
    await db.update(automationSessions).set({ status: 'completed', updatedAt: new Date() }).where(eq(automationSessions.id, session.id)).catch(() => null);
    session = null as any;
  }

  if (session && session.automation.instanceId && session.automation.instanceId !== instanceId) return false;

  if (!session) {
    const activeAutomations = await db.query.automations.findMany({
      where: and(
        eq(automations.teamId, teamId),
        eq(automations.isActive, true),
        or(eq(automations.instanceId, instanceId), isNull(automations.instanceId))
      )
    });

    if (activeAutomations.length === 0) return false;

    const contactData = await db.query.contacts.findFirst({
        where: eq(contacts.chatId, chatId),
        with: { contactTags: true }
    });

    const messageCount = await db.$count(messages, eq(messages.chatId, chatId));
    const isFirstMessage = messageCount <= 1;

    let matchedAutomation = null;
    let fallbackAutomation = null;

    for (const automation of activeAutomations) {
        const nodes = automation.nodes as Node[];
        const startNode = nodes.find(n => n.type === 'start');
        if (!startNode) continue;

        const data = startNode.data as unknown as StartNodeData;
        
        if (data.conditions) {
            if (data.conditions.funnelStageId && (!contactData || contactData.funnelStageId?.toString() !== data.conditions.funnelStageId)) continue;
            if (data.conditions.assignedUserId && (!contactData || contactData.assignedUserId?.toString() !== data.conditions.assignedUserId)) continue;
            if (data.conditions.tagId && (!contactData || !contactData.contactTags.some(ct => ct.tagId.toString() === data.conditions?.tagId))) continue;
        }

        const keywords = data.keywords || [];
        let isMatch = false;

        switch (data.triggerType) {
            case 'exact_match': if (keywords.some(k => k.toLowerCase() === text.toLowerCase())) isMatch = true; break;
            case 'contains': if (keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) isMatch = true; break;
            case 'first_message': if (isFirstMessage) isMatch = true; break;
            case 'fallback': fallbackAutomation = automation; break;
            default: if (keywords.length === 0 || keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) isMatch = true;
        }

        if (isMatch) {
            // Never start branches automations: Sucursales module owns that conversation.
            if (isBranchesAutomation(automation)) {
                console.log('[Automation] skip branches template — processBranchRouting owns chat');
                continue;
            }
            // Never start restapp graph: RestaPP module + Intelligence own WhatsApp copy
            if (isRestappAiAutomation(automation)) {
                console.log('[Automation] skip restapp template — processRestappAiAutomationRouting owns chat');
                const forced = await processRestappAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
                if (forced) return true;
                continue;
            }
            // Never start sales graph labels either (handler already ran above; double-safe)
            if (isSalesAiAutomation(automation)) {
                console.log('[Automation] skip sales_ai template graph — Sales AI handler owns chat');
                const forced = await processSalesAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
                if (forced) return true;
                continue;
            }
            matchedAutomation = automation;
            break;
        }
    }

    // Do not use a branches / restapp / sales fallback graph either
    if (fallbackAutomation && isBranchesAutomation(fallbackAutomation)) {
      fallbackAutomation = null;
    }
    if (fallbackAutomation && isRestappAiAutomation(fallbackAutomation)) {
      const forced = await processRestappAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
      if (forced) return true;
      fallbackAutomation = null;
    }
    if (fallbackAutomation && isSalesAiAutomation(fallbackAutomation)) {
      const forced = await processSalesAiAutomationRouting(teamId, chatId, remoteJid, text, config, instanceId, send, messageId);
      if (forced) return true;
      fallbackAutomation = null;
    }

    const finalAutomation = matchedAutomation || fallbackAutomation;

    if (finalAutomation) {
        const flow = { nodes: finalAutomation.nodes as Node[], edges: finalAutomation.edges as Edge[] };
        const startNode = flow.nodes.find(n => n.type === 'start');
        
        if (startNode) {
            const [newSession] = await db.insert(automationSessions).values({
                teamId, automationId: finalAutomation.id, chatId, currentNodeId: startNode.id, status: 'active'
            }).returning();
            
            session = { ...newSession, automation: finalAutomation } as any;

            await pusherServer.trigger(`team-${teamId}`, 'chat-status-update', {
                chatId, type: 'automation', status: 'active'
            });

            const edge = flow.edges.find(e => e.source === startNode.id);
            if (edge) {
                await executeStep(session!, flow, edge.target, text, config, remoteJid, teamId, chatId, send);
            }
            return true;
        }
    }
    return false;
  }

  const flow = {
      nodes: session.automation.nodes as Node[],
      edges: session.automation.edges as Edge[]
  };

  const currentNode = flow.nodes.find(n => n.id === session?.currentNodeId);
  
  if (!currentNode) return false;

  let nextNodeId: string | undefined;

  if (currentNode.type === 'collect') {
      const variableName = currentNode.data.variable as string;
      if (variableName) {
          const currentVars = (session.variables as Record<string, string>) || {};
          const newVars = { ...currentVars, [variableName]: text };
          
          await db.update(automationSessions)
            .set({ variables: newVars, updatedAt: new Date() })
            .where(eq(automationSessions.id, session.id));
          
          session.variables = newVars;
      }
      const edge = flow.edges.find(e => e.source === currentNode.id);
      nextNodeId = edge?.target;
  } 
  else if (currentNode.type === 'options' || currentNode.type === 'button_message' || currentNode.type === 'list_message') {
      let selectedEdge: Edge | undefined;

      if (currentNode.type === 'options') {
          const options = (currentNode.data.options as string[]) || [];
          let selectedIndex = -1;

          if (!isNaN(Number(text)) && Number(text) > 0 && Number(text) <= options.length) {
              selectedIndex = Number(text) - 1;
          } else {
              selectedIndex = options.findIndex(opt => opt.toLowerCase() === text.toLowerCase());
          }

          if (selectedIndex !== -1) {
              const handleId = `option-${selectedIndex}`;
              selectedEdge = flow.edges.find(e => e.source === currentNode.id && e.sourceHandle === handleId);
          }
      } 
      else if (currentNode.type === 'button_message') {
          const buttons = (currentNode.data.buttons as any[]) || [];
          const buttonIndex = buttons.findIndex(b => b.text.toLowerCase() === text.toLowerCase() || b.value === text);
          if (buttonIndex !== -1) {
              const handleId = `btn-${buttons[buttonIndex].id || buttonIndex}`;
              selectedEdge = flow.edges.find(e => e.source === currentNode.id && e.sourceHandle === handleId);
          }
      }
      else if (currentNode.type === 'list_message') {
          const items = (currentNode.data.items as any[]) || [];
          const itemIndex = items.findIndex(i => i.title.toLowerCase() === text.toLowerCase() || i.rowId === text);
          if (itemIndex !== -1) {
              const handleId = `list-${items[itemIndex].id || itemIndex}`;
              selectedEdge = flow.edges.find(e => e.source === currentNode.id && e.sourceHandle === handleId);
          }
      }

      if (selectedEdge) {
          nextNodeId = selectedEdge.target;
      } else {
          await sendAutomationMessage(send, config, remoteJid, "sendText", { 
             text: "Opção inválida. Por favor, tente novamente." 
          }, teamId, chatId);
          return true;
      }
  } 
  else {
      const edge = flow.edges.find(e => e.source === currentNode.id);
      nextNodeId = edge?.target;
  }

  if (nextNodeId) {
      await executeStep(session, flow, nextNodeId, text, config, remoteJid, teamId, chatId, send);
      return true;
  }

  return false;
}

async function executeStep(
    session: typeof automationSessions.$inferSelect, 
    flow: FlowData, 
    nodeId: string,
    input: string, 
    instance: InstanceConfig,
    remoteJid: string,
    teamId: number,
    chatId: number,
    send?: AutomationSendFn
) {
    const nextNode = flow.nodes.find(n => n.id === nodeId);
    const variables = (session.variables as Record<string, string>) || {};

    await db.update(automationSessions)
        .set({ currentNodeId: nodeId, updatedAt: new Date() })
        .where(eq(automationSessions.id, session.id));
    
    const updatedSession = { ...session, currentNodeId: nodeId };

    if (!nextNode) {
        await db.update(automationSessions).set({ status: 'completed' }).where(eq(automationSessions.id, session.id));
        await pusherServer.trigger(`team-${teamId}`, 'chat-status-update', {
            chatId, type: 'automation', status: 'completed'
        });
        return;
    }

    if (nextNode.type === 'end') {
        await db.update(automationSessions)
            .set({ status: 'completed', updatedAt: new Date() })
            .where(eq(automationSessions.id, session.id));
        
        await pusherServer.trigger(`team-${teamId}`, 'chat-status-update', {
            chatId, type: 'automation', status: 'completed'
        });
        return;
    }

    if (nextNode.type === 'delay') {
        const seconds = Number(nextNode.data.seconds) || 2;
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        await moveToNextAuto(updatedSession, flow, nextNode.id, instance, remoteJid, teamId, chatId, send);
    }
    else if (nextNode.type === 'save_contact') {
        await processSaveContact(nextNode, updatedSession, teamId, chatId);
        await moveToNextAuto(updatedSession, flow, nextNode.id, instance, remoteJid, teamId, chatId, send);
    }
    else if (nextNode.type === 'message' || nextNode.type === 'options') {
        await processTextOutput(nextNode, instance, remoteJid, teamId, chatId, variables, (session as any)?.automation, send);
        if (nextNode.type === 'message') {
             await moveToNextAuto(updatedSession, flow, nextNode.id, instance, remoteJid, teamId, chatId, send);
        }
    }
    else if (nextNode.type === 'media') {
        await processMediaOutput(nextNode, instance, remoteJid, teamId, chatId, variables, send);
        await moveToNextAuto(updatedSession, flow, nextNode.id, instance, remoteJid, teamId, chatId, send);
    }
    else if (nextNode.type === 'collect') {
        let text = nextNode.data.label as string;
        text = replaceVariables(text, variables);
        if (shouldSilenceAutomationCustomerMessage(nextNode, (session as any)?.automation) || isInternalSalesFlowLabel(text)) {
          console.log('[Automation] silenced internal collect label');
        } else {
          await sendAutomationMessage(send, instance, remoteJid, "sendText", { text: text }, teamId, chatId);
        }
    }
    else if (nextNode.type === 'button_message' || nextNode.type === 'list_message') {
        await processMetaInteractiveOutput(nextNode, instance, remoteJid, teamId, chatId, variables, send);
    }
    else if (nextNode.type === 'call_to_action') {
        const body = replaceVariables(nextNode.data.bodyText as string || '', variables);
        const footer = nextNode.data.footerText as string;
        const btnText = nextNode.data.buttonText as string || "Visit";
        const url = replaceVariables(nextNode.data.url as string || '', variables);

        let finalMsg = `${body}`;
        if(url) finalMsg += `\n\n🔗 ${btnText}: ${url}`;
        if(footer) finalMsg += `\n\n_${footer}_`;

        await sendAutomationMessage(send, instance, remoteJid, "sendText", { text: finalMsg }, teamId, chatId);
        await moveToNextAuto(updatedSession, flow, nextNode.id, instance, remoteJid, teamId, chatId, send);
    }
    else if (nextNode.type === 'ai_control') {
        const action = nextNode.data.action as string || 'active';
        
        const existingAiSession = await db.query.aiSessions.findFirst({
            where: eq(aiSessions.chatId, chatId)
        });

        if (existingAiSession) {
            await db.update(aiSessions)
                .set({ status: action, updatedAt: new Date() })
                .where(eq(aiSessions.id, existingAiSession.id));
        } else {
            await db.insert(aiSessions).values({
                chatId,
                status: action,
                history: []
            });
        }

        await pusherServer.trigger(`team-${teamId}`, 'chat-status-update', {
            chatId, type: 'ai', status: action
        });

        await moveToNextAuto(updatedSession, flow, nextNode.id, instance, remoteJid, teamId, chatId, send);
    }
}

async function moveToNextAuto(session: any, flow: FlowData, currentNodeId: string, instance: InstanceConfig, remoteJid: string, teamId: number, chatId: number, send?: AutomationSendFn) {
    const edge = flow.edges.find(e => e.source === currentNodeId);
    if (edge) {
        await new Promise(r => setTimeout(r, 500)); 
        await executeStep(session, flow, edge.target, '', instance, remoteJid, teamId, chatId, send);
    } else {
        await db.update(automationSessions).set({ status: 'completed' }).where(eq(automationSessions.id, session.id));
        await pusherServer.trigger(`team-${teamId}`, 'chat-status-update', {
            chatId, type: 'automation', status: 'completed'
        });
    }
}

async function processTextOutput(node: Node, instance: InstanceConfig, remoteJid: string, teamId: number, chatId: number, variables: Record<string, any>, automation?: any, send?: AutomationSendFn) {
    if (node.type === 'message') {
        let text = node.data.label as string;
        text = replaceVariables(text, variables);
        if (shouldSilenceAutomationCustomerMessage(node, automation) || isInternalSalesFlowLabel(text)) {
            console.log('[Automation] silenced internal sales flow label');
            return;
        }
        await sendAutomationMessage(send, instance, remoteJid, "sendText", { text }, teamId, chatId);
    }
    else if (node.type === 'options') {
        let title = node.data.label as string;
        title = replaceVariables(title, variables);
        if (shouldSilenceAutomationCustomerMessage(node, automation) || isInternalSalesFlowLabel(title)) {
            console.log('[Automation] silenced internal sales options label');
            return;
        }
        const options = (node.data.options as string[]) || [];
        
        let message = `${title}\n\n`;
        options.forEach((opt, idx) => {
            message += `${idx + 1}. ${opt}\n`;
        });
        await sendAutomationMessage(send, instance, remoteJid, "sendText", { text: message }, teamId, chatId);
    }
}

async function processMediaOutput(node: Node, instance: InstanceConfig, remoteJid: string, teamId: number, chatId: number, variables: Record<string, any> = {}, send?: AutomationSendFn) {
    const data = node.data as any;
    if (!data.mediaUrl) return;

    try {
        const absolutePath = path.join(process.cwd(), 'public', data.mediaUrl);
        const base64 = await fileToBase64(absolutePath);
        if (!base64) return;

        const caption = replaceVariables(data.caption || '', variables);
        
        let mediaType = data.mediaType || 'image';
        const mimetype = data.mediaMimetype || 'application/octet-stream';

        const payload = {
            media: base64,
            mediatype: mediaType,
            mimetype: mimetype,
            caption: caption,
            fileName: data.fileName || "file"
        };

        await sendAutomationMessage(send, instance, remoteJid, "sendMedia", payload, teamId, chatId, data.mediaUrl);

    } catch (e) {
        console.error(e);
    }
}

async function processMetaInteractiveOutput(node: Node, instance: InstanceConfig, remoteJid: string, teamId: number, chatId: number, variables: Record<string, any>, send?: AutomationSendFn) {
    const data = node.data as any;
    const bodyText = replaceVariables(data.bodyText || '', variables);
    const footerText = replaceVariables(data.footerText || '', variables);
    const titleText = replaceVariables(data.title || '', variables);

    const metaAvailable = Boolean(instance.metaToken && instance.metaPhoneNumberId);

    // Botones/listas interactivas son exclusivos de Meta. En canales sin Meta
    // (webchat, zernio, o instancias Evolution sin token Meta) se degradan a
    // texto numerado para que el flujo siga siendo usable.
    if (node.type === 'button_message') {
        const buttons = (data.buttons as any[]) || [];

        if (metaAvailable) {
            let interactiveObject: any = {
                body: { text: bodyText }
            };
            if (footerText) interactiveObject.footer = { text: footerText };
            interactiveObject.type = "button";
            interactiveObject.action = {
                buttons: buttons.slice(0, 3).map((b, idx) => ({
                    type: "reply",
                    reply: {
                        id: b.value || `btn-${idx}`,
                        title: b.text?.substring(0, 20) || "Button"
                    }
                }))
            };
            await sendMetaMessage(instance, remoteJid, { type: "interactive", interactive: interactiveObject }, teamId, chatId);
            return;
        }

        let message = `${bodyText}\n\n`;
        buttons.slice(0, 3).forEach((b, idx) => {
            message += `${idx + 1}. ${b.text || `Opción ${idx + 1}`}\n`;
        });
        await sendAutomationMessage(send, instance, remoteJid, "sendText", { text: message }, teamId, chatId);
    }
    else if (node.type === 'list_message') {
        const buttonText = data.buttonText || "Options";
        const items = (data.items as any[]) || [];

        if (metaAvailable) {
            let interactiveObject: any = {
                body: { text: bodyText }
            };
            if (footerText) interactiveObject.footer = { text: footerText };
            if (titleText) interactiveObject.header = { type: "text", text: titleText };
            interactiveObject.type = "list";
            interactiveObject.action = {
                button: buttonText.substring(0, 20),
                sections: [
                    {
                        title: "Menu",
                        rows: items.slice(0, 10).map((item, idx) => ({
                            id: item.rowId || `row-${idx}`,
                            title: item.title?.substring(0, 24) || "Item",
                            description: item.description?.substring(0, 72) || ""
                        }))
                    }
                ]
            };
            await sendMetaMessage(instance, remoteJid, { type: "interactive", interactive: interactiveObject }, teamId, chatId);
            return;
        }

        let message = `${bodyText}\n\n`;
        items.slice(0, 10).forEach((item, idx) => {
            message += `${idx + 1}. ${item.title || `Opción ${idx + 1}`}\n`;
        });
        await sendAutomationMessage(send, instance, remoteJid, "sendText", { text: message }, teamId, chatId);
    }
}

async function sendEvolutionMessage(
    instance: InstanceConfig, 
    remoteJid: string, 
    endpoint: "sendText" | "sendMedia", 
    contentPayload: any, 
    teamId: number, 
    chatId: number, 
    localMediaUrl?: string
) {
    try {
        const number = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        
        const payload = {
            number: number,
            delay: 1000,
            linkPreview: true,
            mentionsEveryOne: false,
            ...contentPayload
        };

        let data: any = null;
        let responseOk = false;

        if (instance.metaToken && instance.metaPhoneNumberId) {
            if (endpoint === 'sendText') {
                const metaResult = await sendMetaTextMessage({
                    phoneNumberId: instance.metaPhoneNumberId,
                    accessToken: instance.metaToken,
                    to: number,
                    text: contentPayload.text,
                });
                responseOk = metaResult.ok;
                data = metaResult.ok ? { key: { id: metaResult.data?.messages?.[0]?.id } } : metaResult.data;
            } else if (endpoint === 'sendMedia' && contentPayload.media && contentPayload.mimetype) {
                const uploadResult = await uploadMetaMediaFromBase64({
                    phoneNumberId: instance.metaPhoneNumberId,
                    accessToken: instance.metaToken,
                    base64: contentPayload.media,
                    mimeType: contentPayload.mimetype,
                    fileName: contentPayload.fileName,
                });
                if (uploadResult.ok && uploadResult.data?.id) {
                    const sendResult = await sendMetaMediaMessage({
                        phoneNumberId: instance.metaPhoneNumberId,
                        accessToken: instance.metaToken,
                        to: number,
                        mediaId: uploadResult.data.id,
                        mediaType: (contentPayload.mediatype || 'document') as any,
                        caption: contentPayload.caption,
                        fileName: contentPayload.fileName,
                    });
                    responseOk = sendResult.ok;
                    data = sendResult.ok ? { key: { id: sendResult.data?.messages?.[0]?.id } } : sendResult.data;
                }
            }
        } else {
            const response = await fetch(
                `${EVOLUTION_API_URL}/message/${endpoint}/${instance.instanceName}`,
                {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'apikey': instance.accessToken 
                    },
                    body: JSON.stringify(payload)
                }
            );
            responseOk = response.ok;
            data = await response.json();
        }
        
        if (responseOk && data?.key?.id) {
            const messageId = data.key.id;
            const timestamp = new Date();
            
            let previewText = "Message";
            if (endpoint === 'sendText') previewText = contentPayload.text;
            else if (endpoint === 'sendMedia') previewText = contentPayload.caption || "Media";

            let messageType = 'conversation';
            if (endpoint === 'sendMedia') {
                messageType = `${contentPayload.mediatype}Message`;
            }

            let mediaDetails = {};
            if (localMediaUrl) {
                mediaDetails = {
                    mediaUrl: localMediaUrl,
                    mediaMimetype: contentPayload.mimetype,
                    mediaCaption: contentPayload.caption
                };
            }

            const newMessage = {
                id: messageId, 
                chatId: chatId, 
                fromMe: true, 
                messageType: messageType, 
                text: previewText, 
                timestamp, 
                status: 'sent' as const, 
                isInternal: false,
                isAutomation: true, 
                quotedMessageText: null, 
                ...mediaDetails
            };

            await db.insert(messages).values(newMessage).onConflictDoNothing();

            await db.update(chats).set({ 
                lastMessageText: previewText, 
                lastMessageTimestamp: timestamp, 
                lastMessageFromMe: true, 
                lastMessageStatus: 'sent' 
            }).where(eq(chats.id, chatId));

            const pusherChannel = `team-${teamId}`;
            
            await pusherServer.trigger(pusherChannel, 'new-message', { 
                ...newMessage,
                timestamp: timestamp.toISOString(),
                remoteJid, 
                instance: instance.instanceName,
            });

            await pusherServer.trigger(pusherChannel, 'chat-list-update', { 
                id: chatId, 
                lastMessageText: previewText, 
                lastMessageTimestamp: timestamp.toISOString(), 
                lastMessageFromMe: true, 
                lastMessageStatus: 'sent', 
                remoteJid 
            });
        }
    } catch (e) { 
        console.error(e); 
    }
}

async function sendMetaMessage(instance: InstanceConfig, remoteJid: string, messagePayload: any, teamId: number, chatId: number) {
    if (!instance.metaToken || !instance.metaPhoneNumberId) return;

    try {
        const cleanPhone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        const payload = {
            messaging_product: "whatsapp",
            to: cleanPhone,
            ...messagePayload
        };

        const response = await fetch(`${GRAPH_API_URL}/${GRAPH_API_VERSION}/${instance.metaPhoneNumberId}/messages`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${instance.metaToken}` 
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (response.ok && data?.messages?.[0]?.id) {
            const messageId = data.messages[0].id;
            const timestamp = new Date();
            
            let previewText = "Interactive Message";
            let interactiveMetadata = null;

            if (messagePayload.type === 'interactive') {
                const interactive = messagePayload.interactive;
                previewText = interactive.body.text;
                interactiveMetadata = JSON.stringify(interactive);
            }

            const newMessage = {
                id: messageId, 
                chatId: chatId, 
                fromMe: true, 
                messageType: 'interactiveMessage', 
                text: previewText, 
                timestamp, 
                status: 'sent' as const, 
                isInternal: false,
                quotedMessageText: interactiveMetadata
            };

            await db.insert(messages).values(newMessage).onConflictDoNothing();

            await db.update(chats).set({ 
                lastMessageText: previewText, 
                lastMessageTimestamp: timestamp, 
                lastMessageFromMe: true, 
                lastMessageStatus: 'sent' 
            }).where(eq(chats.id, chatId));

            const pusherChannel = `team-${teamId}`;
            
            await pusherServer.trigger(pusherChannel, 'new-message', { 
                ...newMessage,
                timestamp: timestamp.toISOString(),
                remoteJid, 
                instance: instance.instanceName,
            });

            await pusherServer.trigger(pusherChannel, 'chat-list-update', { 
                id: chatId, 
                lastMessageText: previewText, 
                lastMessageTimestamp: timestamp.toISOString(), 
                lastMessageFromMe: true, 
                lastMessageStatus: 'sent', 
                remoteJid 
            });
        }
    } catch (e) { 
        console.error(e); 
    }
}

async function processSaveContact(node: Node, session: any, teamId: number, chatId: number) {
    const data = node.data as any;
    const variables = (session.variables as Record<string, string>) || {};
    
    let contactName = 'New Contact';
    if (data.nameVariable && variables[data.nameVariable]) {
        contactName = variables[data.nameVariable];
    } else {
        const chat = await db.query.chats.findFirst({ where: eq(chats.id, chatId), columns: { name: true, pushName: true } });
        contactName = chat?.name || chat?.pushName || contactName;
    }

    await db.transaction(async (tx) => {
        const [contact] = await tx.insert(contacts)
            .values({
                teamId,
                chatId,
                name: contactName,
                assignedUserId: data.agentId && data.agentId !== 'null' ? parseInt(data.agentId) : null,
                funnelStageId: data.funnelStageId && data.funnelStageId !== 'null' ? parseInt(data.funnelStageId) : null,
                updatedAt: new Date()
            })
            .onConflictDoUpdate({
                target: [contacts.chatId],
                set: {
                    name: contactName,
                    assignedUserId: data.agentId && data.agentId !== 'null' ? parseInt(data.agentId) : undefined,
                    funnelStageId: data.funnelStageId && data.funnelStageId !== 'null' ? parseInt(data.funnelStageId) : undefined,
                    updatedAt: new Date()
                }
            })
            .returning();

        if (data.tagId && data.tagId !== 'null' && contact) {
            await tx.insert(contactTags).values({
                contactId: contact.id,
                tagId: parseInt(data.tagId)
            }).onConflictDoNothing();
        }
    });
}
