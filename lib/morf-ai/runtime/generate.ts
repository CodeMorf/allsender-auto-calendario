// Morf AI — Runtime (Fase 3): morf.generate() server-side.
// Capa única para que cualquier módulo ejecute una capability LLM (§3.1):
//   1. valida el request;
//   2. valida acceso/wallet del tenant (§9.1, §47: sin llamadas billables si debe bloquearse);
//   3. resuelve candidatos del registro (fuente de verdad, §74);
//   4. ejecuta con fallback por provider (timeout §48, saneado §49);
//   5. registra usage con provider/model/tokens reales (§28).

import 'server-only';

import { getMorfAiAccess, isMorfBilledShadowApproved, recordMorfAiUsage } from '../core';
import { listMorfAiProviders } from '../providers/registry';
import { orderedMorfAiCandidates } from '../providers/registry-core';
import { isMorfCapability } from '../providers/validation';
import { callMorfAdapter } from './adapters';
import { runMorfWithFallback } from './runtime-core';
import { isCodeMorfOnlyModuleCode, SALES_AI_PROVIDER_CODE, scopeCodeMorfProviders } from '../providers/sales-policy';
import type { MorfGenerateFailure, MorfGenerateOptions, MorfGenerateResult, MorfRequest } from './types';

function failure(reason: MorfGenerateFailure['reason'], message: string, attempted: string[] = []): MorfGenerateFailure {
  return { ok: false, reason, message, attempted };
}

export async function morfGenerate(request: MorfRequest, options: MorfGenerateOptions = {}): Promise<MorfGenerateResult> {
  if (!request || typeof request !== 'object') return failure('invalid_request', 'Request inválido.');
  if (typeof request.teamId !== 'number' || !Number.isFinite(request.teamId)) {
    return failure('invalid_request', 'teamId requerido.');
  }
  if (typeof request.moduleCode !== 'string' || !request.moduleCode.trim()) {
    return failure('invalid_request', 'moduleCode requerido.');
  }
  if (!isMorfCapability(request.capability)) {
    return failure('invalid_request', `Capability inválida: ${String(request.capability)}.`);
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return failure('invalid_request', 'messages requerido.');
  }

  if (options.billingMode === 'shadow') {
    try {
      const approved = await isMorfBilledShadowApproved(request.teamId);
      if (!approved) {
        return failure('billing_blocked', 'Shadow facturable no aprobado para este tenant.');
      }
    } catch (error) {
      console.error('[morf.generate] billed shadow approval check failed', error);
      return failure('billing_blocked', 'No se pudo validar la aprobacion de shadow facturable.');
    }
  }

  if (!options.skipAccessCheck) {
    try {
      const access = await getMorfAiAccess(request.teamId);
      if (!access.allowed) {
        return {
          ok: false,
          reason: 'access_denied',
          accessReason: access.reason,
          message: access.message,
          attempted: [],
        };
      }
    } catch (error) {
      console.error('[morf.generate] access check failed', error);
      return failure('internal_error', 'No se pudo validar el acceso del equipo.');
    }
  }

  let providers;
  try {
    providers = await listMorfAiProviders();
  } catch (error) {
    console.error('[morf.generate] list providers failed', error);
    return failure('internal_error', 'No se pudo leer el registro de proveedores.');
  }

  // Venta AI y Auto Calendario son CodeMorf-only. Se filtra antes de validar y resolver para que
  // providers legacy (OpenRouter/OpenAI/Gemini) no puedan entrar como fallback,
  // aunque sigan registrados para otros módulos del SaaS.
  const codeMorfOnly = isCodeMorfOnlyModuleCode(request.moduleCode);
  const scopedProviders = codeMorfOnly ? scopeCodeMorfProviders(providers) : providers;
  const { candidates, attempted, issues } = orderedMorfAiCandidates({
    providers: scopedProviders,
    capability: request.capability,
    preferCode: codeMorfOnly ? SALES_AI_PROVIDER_CODE : options.preferCode,
    env: process.env as Record<string, string | undefined>,
  });

  if (issues.length > 0) {
    return { ok: false, reason: 'invalid_provider_set', message: issues.join('; '), attempted: [] };
  }
  if (candidates.length === 0) {
    const reason = attempted.length === 0 ? 'no_provider_ready' : 'capability_not_supported';
    const message =
      attempted.length === 0
        ? 'Ningún provider habilitado tiene key y modelo configurados.'
        : `Ningún provider ready soporta la capability ${request.capability}.`;
    return { ok: false, reason, message, attempted };
  }

  const result = await runMorfWithFallback({
    request,
    candidates,
    timeoutMs: options.timeoutMs,
    callAdapter: callMorfAdapter,
  });

  if (result.ok) {
    try {
      await recordMorfAiUsage({
        teamId: request.teamId,
        chatId: options.chatId,
        moduleCode: request.moduleCode,
        provider: result.provider.code,
        model: result.provider.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        requestKey: options.requestKey,
        metadata: {
          ...(request.metadata || {}),
          ...(options.metadata || {}),
          attempted: result.attempted,
        },
      });
    } catch (error) {
      console.error('[morf.generate] usage logging failed', error);
      // Fail-closed: el provider ya respondio, pero el modulo no puede tratar
      // la llamada como completada si no quedo registrada. El claim exterior
      // de Ventas IA impide reejecutarla y repetir consumo/cobro.
      return failure('metering_failed', 'La llamada se ejecuto pero no pudo registrarse el consumo.', result.attempted);
    }
  }

  return result;
}
