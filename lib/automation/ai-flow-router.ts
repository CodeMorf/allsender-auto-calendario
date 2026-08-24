import { client } from '@/lib/db/drizzle';
import { AutomationTemplateKey } from '@/lib/automation/templates';
import { validateAutomationTemplate } from '@/lib/automation/template-validation';
import { shouldRouteAutoCalendarMessage } from '@/lib/modules/reservas/routing-guard';

export type ResolvedAiFlow = {
  flow: 'department_basic' | 'auto_calendar' | 'sales_ai' | 'restapp_ai' | 'basic_ai' | 'human_handoff' | 'none';
  provider: 'openrouter' | 'openai' | 'gemini' | 'none';
  reason: string;
  requiredSetup: string[];
  safeMessage: string;
  canExecute: boolean;
};

const INTENT_PATTERNS = {
  auto_calendar: /(cita|reserv(a|ar)|agenda|turno|horario|disponible|calendario)/i,
  restapp_ai: /(restaurante|menu|men[uú]|pizza|hamburguesa|comida|pedido comida|delivery comida|mesa|reserva mesa|tengo hambre|carta|plato|combo|para llevar)/i,
  sales_ai: /(comprar|precio|producto|cat[aá]logo|orden|pedido|cotiz|env[ií]o|delivery|pago|contra entrega|transferencia|comprobante|bauche|voucher|ubicaci[oó]n|cobertura|tracking|rastreo|garant[ií]a|cambio|devoluci[oó]n|defectuoso|talla|color)/i,
  department_basic: /(soporte|facturaci[oó]n|ventas|asesor|departamento|ayuda|administraci[oó]n)/i,
};

async function getActiveProvider(teamId: number): Promise<ResolvedAiFlow['provider']> {
  try {
    const rows = await client<{ provider: string }[]>`
      SELECT provider
      FROM ai_configs
      WHERE team_id = ${teamId}
        AND is_active = true
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    const provider = rows[0]?.provider?.toLowerCase();
    if (provider?.includes('gemini')) return 'gemini';
    if (provider?.includes('openai') || provider?.includes('chatgpt')) return 'openai';
    if (provider?.includes('openrouter') || provider?.includes('morf')) return 'openrouter';
  } catch {
    return 'none';
  }

  try {
    const rows = await client<{ count: string | number | bigint }[]>`
      SELECT COUNT(*)::int AS count
      FROM morf_ai_wallets
      WHERE team_id = ${teamId}
        AND status = 'active'
    `;
    if (Number(rows?.[0]?.count || 0) > 0) return 'openrouter';
  } catch {
    return 'none';
  }

  return 'none';
}

function detectIntent(message: string): AutomationTemplateKey | 'basic_ai' {
  if (shouldRouteAutoCalendarMessage(message)) return 'auto_calendar';
  if (INTENT_PATTERNS.restapp_ai.test(message)) return 'restapp_ai';
  if (INTENT_PATTERNS.sales_ai.test(message)) return 'sales_ai';
  if (INTENT_PATTERNS.department_basic.test(message)) return 'departments';
  return 'basic_ai';
}

function flowFromTemplateKey(templateKey: AutomationTemplateKey): ResolvedAiFlow['flow'] {
  if (templateKey === 'auto_calendar') return 'auto_calendar';
  if (templateKey === 'restapp_ai') return 'restapp_ai';
  if (templateKey === 'sales_ai') return 'sales_ai';
  return 'department_basic';
}

export async function resolveAiFlowForMessage({
  teamId,
  message,
}: {
  teamId: number;
  chatId?: number;
  message: string;
  provider?: string;
  activeModules?: string[];
  activeAutomations?: string[];
  planPermissions?: string[];
}): Promise<ResolvedAiFlow> {
  const provider = await getActiveProvider(teamId);
  const intent = detectIntent(message);

  if (intent === 'basic_ai') {
    return {
      flow: provider === 'none' ? 'human_handoff' : 'basic_ai',
      provider,
      reason: provider === 'none' ? 'Sin proveedor IA configurado' : 'Mensaje general',
      requiredSetup: provider === 'none' ? ['Configura tu proveedor IA'] : [],
      safeMessage: provider === 'none'
        ? 'Claro, puedo ayudarte. Te pondré en contacto con el equipo para continuar.'
        : '',
      canExecute: provider !== 'none',
    };
  }

  const validation = await validateAutomationTemplate(teamId, intent);
  if (!validation.canActivate) {
    const safeMessage = intent === 'auto_calendar'
      ? 'Claro, puedo ayudarte a coordinarlo. Te pondré en contacto con el equipo para confirmar disponibilidad.'
      : intent === 'restapp_ai' || intent === 'sales_ai'
        ? 'Claro, puedo ayudarte. Un asesor confirmará las opciones disponibles para continuar.'
        : 'Claro, puedo ayudarte. Te pondré en contacto con el equipo para continuar.';

    return {
      flow: 'human_handoff',
      provider,
      reason: validation.commercialStatus,
      requiredSetup: validation.missingMessages,
      safeMessage,
      canExecute: false,
    };
  }

  return {
    flow: flowFromTemplateKey(intent),
    provider,
    reason: 'Lista para activar',
    requiredSetup: [],
    safeMessage: '',
    canExecute: true,
  };
}
