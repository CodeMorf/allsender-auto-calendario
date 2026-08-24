import { client } from '@/lib/db/drizzle';
import { AUTOMATION_TEMPLATES, AutomationTemplateKey, getAutomationTemplate } from '@/lib/automation/templates';

type RowCount = { count: string | number | bigint };

type ValidationFacts = {
  hasProvider: boolean;
  hasDepartmentsModule: boolean;
  hasDepartmentsData: boolean;
  hasCalendarModule: boolean;
  hasCalendarConnection: boolean;
  hasCalendarData: boolean;
  hasSalesModule: boolean;
  hasProductsModule: boolean;
  hasCatalog: boolean;
  hasPayments: boolean;
  hasRestappModule: boolean;
  hasRestappMenu: boolean;
  hasRestappBranch: boolean;
};

export type AutomationTemplateValidation = {
  templateKey: AutomationTemplateKey;
  status: 'ready' | 'needs_setup';
  commercialStatus: 'Lista para activar' | 'Requiere configuración';
  canActivate: boolean;
  missingMessages: string[];
  requirements: Array<{
    label: string;
    isReady: boolean;
    message: string;
    configureHref: string;
  }>;
};

function toNumber(value: string | number | bigint | null | undefined) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(value || 0);
}

async function countRows(sql: () => PromiseLike<RowCount[]>): Promise<number> {
  try {
    const rows = await sql();
    return toNumber(rows?.[0]?.count);
  } catch {
    return 0;
  }
}

async function hasActiveAiProvider(teamId: number) {
  const ownProviderCount = await countRows(() => client<RowCount[]>`
    SELECT COUNT(*)::int AS count
    FROM ai_configs
    WHERE team_id = ${teamId}
      AND is_active = true
      AND provider IS NOT NULL
      AND provider <> ''
      AND model IS NOT NULL
      AND model <> ''
      AND api_key IS NOT NULL
      AND length(trim(api_key)) > 0
  `);

  if (ownProviderCount > 0) return true;

  const morfProviderCount = await countRows(() => client<RowCount[]>`
    SELECT COUNT(*)::int AS count
    FROM morf_ai_wallets
    WHERE team_id = ${teamId}
      AND status = 'active'
  `);

  return morfProviderCount > 0;
}

async function hasModuleAccess(teamId: number, moduleCodes: string[]) {
  if (moduleCodes.length === 0) return false;

  const rows = await client<RowCount[]>`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT module_code
      FROM team_module_subscriptions
      WHERE team_id = ${teamId}
        AND status IN ('active', 'trialing')

      UNION

      SELECT pme.module_code
      FROM teams t
      INNER JOIN plan_module_entitlements pme ON pme.plan_id = t.plan_id
      WHERE t.id = ${teamId}
        AND pme.is_allowed = true
    ) allowed_modules
    WHERE module_code = ANY(${moduleCodes})
  `;

  return toNumber(rows?.[0]?.count) > 0;
}

async function hasPlanFlag(teamId: number, columnName: 'is_ai_enabled' | 'is_flow_builder_enabled' | 'is_ai_sales_enabled') {
  if (columnName === 'is_ai_sales_enabled') {
    const rows = await client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM teams t
      INNER JOIN plans p ON p.id = t.plan_id
      WHERE t.id = ${teamId}
        AND p.is_ai_sales_enabled = true
    `;
    return toNumber(rows?.[0]?.count) > 0;
  }

  if (columnName === 'is_flow_builder_enabled') {
    const rows = await client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM teams t
      INNER JOIN plans p ON p.id = t.plan_id
      WHERE t.id = ${teamId}
        AND p.is_flow_builder_enabled = true
    `;
    return toNumber(rows?.[0]?.count) > 0;
  }

  const rows = await client<RowCount[]>`
    SELECT COUNT(*)::int AS count
    FROM teams t
    INNER JOIN plans p ON p.id = t.plan_id
    WHERE t.id = ${teamId}
      AND p.is_ai_enabled = true
  `;
  return toNumber(rows?.[0]?.count) > 0;
}

async function getValidationFacts(teamId: number): Promise<ValidationFacts> {
  const [
    hasProvider,
    hasDepartmentsEntitlement,
    hasCalendarEntitlement,
    hasSalesEntitlement,
    hasProductsEntitlement,
    hasAiSalesFlag,
    departmentSettingsCount,
    departmentsCount,
    reservationSettingsCount,
    reservationServicesCount,
    reservationResourcesCount,
    reservationAvailabilityCount,
    reservationCalendarCount,
    salesSettingsCount,
    salesProductsCount,
    salesProductsWithImageCount,
    salesProductsWithStockCount,
    salesPaymentsCount,
    restappModuleEntitlement,
    restappSettingsCount,
    restappMenuCount,
    restappBranchCount,
  ] = await Promise.all([
    hasActiveAiProvider(teamId),
    hasModuleAccess(teamId, ['departments']),
    hasModuleAccess(teamId, ['reservas_ia', 'reservas', 'appointments']),
    hasModuleAccess(teamId, ['ventas_ia']),
    hasModuleAccess(teamId, ['productos', 'productos_ordenes']),
    hasPlanFlag(teamId, 'is_ai_sales_enabled').catch(() => false),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM department_settings
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM departments
      WHERE team_id = ${teamId}
        AND is_active = true
        AND deleted_at IS NULL
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM reservation_ai_settings
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM reservation_services
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM reservation_resources
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM reservation_availability_rules
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM reservation_calendar_connections
      WHERE team_id = ${teamId}
        AND status IN ('connected', 'active', 'ready')
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM ai_sales_settings
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM ai_sales_products
      WHERE team_id = ${teamId}
        AND is_active = true
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM ai_sales_products
      WHERE team_id = ${teamId}
        AND is_active = true
        AND image_url IS NOT NULL
        AND image_url <> ''
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM ai_sales_products
      WHERE team_id = ${teamId}
        AND is_active = true
        AND stock > 0
    `),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM ai_sales_settings
      WHERE team_id = ${teamId}
        AND is_active = true
        AND (
          cod_enabled = true
          OR transfer_enabled = true
          OR jsonb_array_length(payment_methods) > 0
          OR default_payment_method IS NOT NULL
        )
    `),
    hasModuleAccess(teamId, ['restapp_ai', 'restapp-ai', 'restapp']).catch(() => false),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM restapp_settings
      WHERE team_id = ${teamId}
        AND is_active = true
    `).catch(() => 0),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM restapp_menu_items
      WHERE team_id = ${teamId}
        AND is_available = true
    `).catch(() => 0),
    countRows(() => client<RowCount[]>`
      SELECT COUNT(*)::int AS count
      FROM restapp_branches
      WHERE team_id = ${teamId}
        AND is_active = true
    `).catch(() => 0),
  ]);

  const hasDepartmentsModule = Boolean(hasDepartmentsEntitlement);
  const hasDepartmentsData = departmentSettingsCount > 0 && departmentsCount > 0;

  const hasCalendarModule = Boolean(hasCalendarEntitlement);
  const hasCalendarConnection = reservationCalendarCount > 0;
  const hasCalendarData = reservationSettingsCount > 0 && reservationServicesCount > 0 && reservationResourcesCount > 0 && reservationAvailabilityCount > 0;

  const hasSalesModule = Boolean(hasSalesEntitlement || hasAiSalesFlag);
  const hasProductsModule = Boolean(hasProductsEntitlement);
  const hasCatalog = salesProductsCount > 0 && salesProductsWithImageCount > 0 && salesProductsWithStockCount > 0;
  const hasPayments = salesSettingsCount > 0 && salesPaymentsCount > 0;
  // Beta: module considered available if settings active OR plan entitlement (sidebar beta opens for all)
  const hasRestappModule = Boolean(restappSettingsCount > 0 || restappModuleEntitlement);
  const hasRestappMenu = restappMenuCount > 0;
  const hasRestappBranch = restappBranchCount > 0;

  return {
    hasProvider,
    hasDepartmentsModule,
    hasDepartmentsData,
    hasCalendarModule,
    hasCalendarConnection,
    hasCalendarData,
    hasSalesModule,
    hasProductsModule,
    hasCatalog,
    hasPayments,
    hasRestappModule,
    hasRestappMenu,
    hasRestappBranch,
  };
}

function requirementStatus(
  label: string,
  configureHref: string,
  isReady: boolean,
  readyMessage: string,
  missingMessage: string
) {
  return {
    label,
    configureHref,
    isReady,
    message: isReady ? readyMessage : missingMessage,
  };
}

export async function validateAutomationTemplate(teamId: number, templateKey: AutomationTemplateKey): Promise<AutomationTemplateValidation> {
  const template = getAutomationTemplate(templateKey) || AUTOMATION_TEMPLATES[0];
  const facts = await getValidationFacts(teamId);

  const requirements = template.requirements.map((requirement) => {
    if (requirement.key === 'provider') {
      return requirementStatus(
        requirement.label,
        requirement.configureHref,
        facts.hasProvider,
        requirement.readyLabel,
        requirement.missingLabel
      );
    }

    if (templateKey === 'departments') {
      const ready = facts.hasDepartmentsModule && facts.hasDepartmentsData;
      return requirementStatus(
        requirement.label,
        requirement.configureHref,
        ready,
        requirement.readyLabel,
        facts.hasDepartmentsModule ? 'Crea tus departamentos' : 'Requiere configuración'
      );
    }

    if (templateKey === 'auto_calendar') {
      if (requirement.key === 'module') {
        return requirementStatus(
          requirement.label,
          requirement.configureHref,
          facts.hasCalendarModule && facts.hasCalendarConnection,
          requirement.readyLabel,
          facts.hasCalendarModule ? 'Conecta tu calendario' : 'Requiere configuración'
        );
      }

      return requirementStatus(
        requirement.label,
        requirement.configureHref,
        facts.hasCalendarData,
        requirement.readyLabel,
        'Agrega servicios y horarios'
      );
    }

    if (templateKey === 'sales_ai') {
      if (requirement.key === 'catalog') {
        return requirementStatus(
          requirement.label,
          requirement.configureHref,
          facts.hasSalesModule && facts.hasProductsModule && facts.hasCatalog,
          requirement.readyLabel,
          facts.hasSalesModule && facts.hasProductsModule ? 'Agrega productos para vender con IA' : 'Requiere configuración'
        );
      }

      return requirementStatus(
        requirement.label,
        requirement.configureHref,
        facts.hasPayments,
        requirement.readyLabel,
        'Configura entrega y pagos'
      );
    }

    if (templateKey === 'restapp_ai') {
      if (requirement.key === 'module') {
        return requirementStatus(
          requirement.label,
          requirement.configureHref,
          facts.hasRestappModule,
          requirement.readyLabel,
          requirement.missingLabel
        );
      }
      if (requirement.key === 'catalog') {
        return requirementStatus(
          requirement.label,
          requirement.configureHref,
          facts.hasRestappMenu,
          requirement.readyLabel,
          requirement.missingLabel
        );
      }
      if (requirement.key === 'data') {
        return requirementStatus(
          requirement.label,
          requirement.configureHref,
          facts.hasRestappBranch,
          requirement.readyLabel,
          requirement.missingLabel
        );
      }
    }

    return requirementStatus(requirement.label, requirement.configureHref, false, requirement.readyLabel, requirement.missingLabel);
  });

  const missingMessages = Array.from(new Set(requirements.filter((item) => !item.isReady).map((item) => item.message)));
  const canActivate = missingMessages.length === 0;

  return {
    templateKey,
    status: canActivate ? 'ready' : 'needs_setup',
    commercialStatus: canActivate ? 'Lista para activar' : 'Requiere configuración',
    canActivate,
    missingMessages,
    requirements,
  };
}

export async function getAutomationTemplateValidationMap(teamId: number) {
  const entries = await Promise.all(
    AUTOMATION_TEMPLATES.map(async (template) => [template.key, await validateAutomationTemplate(teamId, template.key)] as const)
  );

  return Object.fromEntries(entries) as Record<AutomationTemplateKey, AutomationTemplateValidation>;
}
