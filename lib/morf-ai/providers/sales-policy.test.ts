import assert from 'node:assert/strict';
import test from 'node:test';
import { SALES_AI_MODEL, SALES_AI_PROVIDER_CODE, isCodeMorfOnlyModuleCode, isSalesAiModuleCode, scopeSalesAiProviders } from './sales-policy';
import type { MorfProviderRecord } from './types';

function record(code: MorfProviderRecord['code']): MorfProviderRecord {
  return {
    code,
    display_name: code,
    base_url: `https://${code}.example.test/v1`,
    default_model: 'model',
    is_enabled: true,
    is_primary: code === 'codemorf',
    fallback_priority: code === 'codemorf' ? 1 : 2,
    capabilities: ['text', 'structured_output', 'vision', 'tool_calling', 'classification', 'reasoning'],
    metadata: {},
    last_test_status: 'ok',
    last_test_message_sanitized: null,
    last_test_at: null,
  };
}

test('SALES-POLICY-001: Venta AI reconoce todos sus module codes', () => {
  for (const code of ['sales_ai', 'sales-ai', 'ventas_ia', 'venta-ai', 'payment_proof']) {
    assert.equal(isSalesAiModuleCode(code), true);
  }
  assert.equal(isSalesAiModuleCode('marketing_ai'), false);
});

test('SALES-POLICY-002: Venta AI deja únicamente CodeMorf', () => {
  assert.equal(SALES_AI_PROVIDER_CODE, 'codemorf');
  assert.equal(SALES_AI_MODEL, 'morf-ai-auto');
  assert.deepEqual(scopeSalesAiProviders([record('openrouter'), record('openai'), record('codemorf')]).map((p) => p.code), ['codemorf']);
});

test('AUTO-CALENDAR-POLICY-001: Auto Calendario no usa fallback externo', () => {
  assert.equal(isCodeMorfOnlyModuleCode('auto_calendar'), true);
  assert.equal(isCodeMorfOnlyModuleCode('auto-cita'), true);
  assert.equal(isCodeMorfOnlyModuleCode('marketing_ai'), false);
});
