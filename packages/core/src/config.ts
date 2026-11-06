/**
 * Server configuration, read once from the environment.
 *
 * Platform adapters supply `env` (process.env on Node and Firebase). Nothing
 * else in core reads the environment, so every setting is visible here.
 */

export type ComplianceTier = 'hipaa' | 'standard';

export interface CoreConfig {
  knackAppId: string;
  /** The master REST key. Bypasses every Knack permission. Never log or return it. */
  knackApiKey: string;
  knackApiHost: string;
  sessionSecret: string;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  tier: ComplianceTier;
  allowCommercialHostForDemo: boolean;
  auditValues: boolean;
  appName: string;
  passwordResetUrl: string;
  /** Minutes between automatic re-syncs of the Knack app structure. 0 = off. */
  syncMinutes: number;
  /** Knack's metadata endpoint base (GovCloud tenants may differ). */
  loaderUrl: string;
}

export class ConfigError extends Error {}

const COMMERCIAL_HOST = 'https://api.knack.com/v1';

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (value: string | undefined): boolean => value === 'true' || value === '1';

/**
 * Validate and freeze the configuration.
 *
 * Fails loudly at startup rather than at the first request: a server that
 * boots without a session secret, or on the wrong Knack host, is worse than one
 * that refuses to boot.
 */
export const loadConfig = (env: Record<string, string | undefined>): CoreConfig => {
  const problems: string[] = [];

  const knackAppId = env.KNACK_APP_ID?.trim() ?? '';
  const knackApiKey = env.KNACK_API_KEY?.trim() ?? '';
  const knackApiHost = (env.KNACK_API_HOST?.trim() || COMMERCIAL_HOST).replace(/\/+$/, '');
  const sessionSecret = env.SESSION_SECRET ?? '';
  const tier: ComplianceTier = env.COMPLIANCE_TIER === 'standard' ? 'standard' : 'hipaa';
  const allowCommercialHostForDemo = bool(env.ALLOW_COMMERCIAL_HOST_FOR_DEMO);

  if (!/^[a-f0-9]{24}$/i.test(knackAppId)) problems.push('KNACK_APP_ID is missing or malformed.');
  if (!knackApiKey) problems.push('KNACK_API_KEY is not set.');
  if (sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters.');

  /*
   * The commercial host accepts writes for a GovCloud tenant, answers 200 and
   * drops them. On the HIPAA tier the GovCloud host is the expected one, so the
   * commercial host is refused unless someone has said, in config, that this
   * deployment holds synthetic demo data only.
   */
  if (tier === 'hipaa' && knackApiHost === COMMERCIAL_HOST && !allowCommercialHostForDemo) {
    problems.push(
      'COMPLIANCE_TIER=hipaa but KNACK_API_HOST is the commercial host. Use your HIPAA ' +
        'tenant host (https://usgc-api.knack.com/v1), or set ALLOW_COMMERCIAL_HOST_FOR_DEMO=true ' +
        'for a deployment that holds synthetic demo data only.',
    );
  }

  if (problems.length) throw new ConfigError(`Configuration invalid:\n  - ${problems.join('\n  - ')}`);

  return Object.freeze({
    knackAppId,
    knackApiKey,
    knackApiHost,
    sessionSecret,
    sessionIdleMinutes: num(env.SESSION_IDLE_MINUTES, 15),
    sessionMaxHours: num(env.SESSION_MAX_HOURS, 12),
    tier,
    allowCommercialHostForDemo,
    auditValues: bool(env.AUDIT_VALUES),
    appName: env.APP_NAME?.trim() || 'Patient Portal',
    passwordResetUrl: env.PASSWORD_RESET_URL?.trim() ?? '',
    syncMinutes: env.SYNC_MINUTES === '0' ? 0 : num(env.SYNC_MINUTES, 5),
    loaderUrl: env.KNACK_LOADER_URL?.trim() || 'https://loader.knack.com/v1',
  });
};
