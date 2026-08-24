import type { MorfProviderCode, MorfProviderRecord } from './types';

/** Venta AI y Auto Calendario usan exclusivamente el gateway CodeMorf. */
export const SALES_AI_PROVIDER_CODE: MorfProviderCode = 'codemorf';
export const SALES_AI_MODEL = 'morf-ai-auto';

const CODEMORF_ONLY_MODULE_CODES = new Set([
  'sales_ai',
  'sales-ai',
  'ventas_ia',
  'venta-ai',
  'payment_proof',
  'auto_calendar',
  'auto-cita',
  'auto_cita',
]);

export function isSalesAiModuleCode(moduleCode: unknown): boolean {
  const normalized = String(moduleCode || '').trim().toLowerCase();
  return ['sales_ai', 'sales-ai', 'ventas_ia', 'venta-ai', 'payment_proof'].includes(normalized);
}

export function isCodeMorfOnlyModuleCode(moduleCode: unknown): boolean {
  return CODEMORF_ONLY_MODULE_CODES.has(String(moduleCode || '').trim().toLowerCase());
}

export function scopeSalesAiProviders(providers: MorfProviderRecord[]): MorfProviderRecord[] {
  return providers.filter((provider) => provider.code === SALES_AI_PROVIDER_CODE);
}

export function scopeCodeMorfProviders(providers: MorfProviderRecord[]): MorfProviderRecord[] {
  return providers.filter((provider) => provider.code === SALES_AI_PROVIDER_CODE);
}
