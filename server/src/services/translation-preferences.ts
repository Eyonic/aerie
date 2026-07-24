import { config } from '../config.js';
import { db } from '../lib/db.js';
import { adminPolicy } from './policy.js';

export type TranslationProvider = 'local' | 'external';
export interface TranslationPreferences {
  provider: TranslationProvider;
  languages: string[];
}

const MAX_LANGUAGES = 12;

export function normalizeLanguage(value: unknown): string {
  const raw = String(value || '').trim().replace(/_/g, '-');
  if (!raw || raw.length > 35 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(raw)) {
    throw Object.assign(new Error('translation_language_invalid'), { status: 400 });
  }
  try { return Intl.getCanonicalLocales(raw)[0]; }
  catch { throw Object.assign(new Error('translation_language_invalid'), { status: 400 }); }
}

export function normalizeLanguages(value: unknown, options: { allowEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(value)) throw Object.assign(new Error('translation_languages_invalid'), { status: 400 });
  if (value.length > MAX_LANGUAGES) throw Object.assign(new Error('translation_language_limit'), { status: 400 });
  const unique: string[] = [];
  for (const item of value) {
    const language = normalizeLanguage(item);
    if (!unique.some(existing => existing.toLowerCase() === language.toLowerCase())) unique.push(language);
  }
  if (!unique.length && !options.allowEmpty) throw Object.assign(new Error('translation_language_required'), { status: 400 });
  return unique;
}

function defaultLanguages(settings: any): string[] {
  const candidates: string[] = [];
  if (typeof settings?.language === 'string') candidates.push(settings.language);
  candidates.push(...String(config.translateLang || '').split(/[,;\s]+/).filter(Boolean));
  const valid: string[] = [];
  for (const candidate of candidates) {
    try {
      const language = normalizeLanguage(candidate);
      if (!valid.some(existing => existing.toLowerCase() === language.toLowerCase())) valid.push(language);
    } catch { /* ignore an invalid legacy environment value */ }
  }
  return valid.slice(0, MAX_LANGUAGES);
}

export function translationPreferencesFromSettings(settings: any): TranslationPreferences {
  const raw = settings?.translation && typeof settings.translation === 'object' && !Array.isArray(settings.translation)
    ? settings.translation : {};
  const provider: TranslationProvider = raw.provider === 'external' ? 'external' : 'local';
  let languages: string[] = [];
  try { languages = normalizeLanguages(raw.languages, { allowEmpty: true }); } catch { /* use safe defaults */ }
  if (!languages.length) languages = defaultLanguages(settings);
  return { provider, languages };
}

export function validateTranslationPreferences(value: unknown): TranslationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('translation_preferences_invalid'), { status: 400 });
  }
  const provider = (value as any).provider;
  if (provider !== 'local' && provider !== 'external') {
    throw Object.assign(new Error('translation_provider_invalid'), { status: 400 });
  }
  return { provider, languages: normalizeLanguages((value as any).languages) };
}

function settingsForUser(userId: number): any {
  const row = db.prepare('SELECT settings FROM users WHERE id=?').get(userId) as any;
  try { return JSON.parse(row?.settings || '{}'); } catch { return {}; }
}

export function getTranslationPreferences(userId: number): TranslationPreferences {
  return translationPreferencesFromSettings(settingsForUser(userId));
}

export function translationCapabilities(user: { aiMode?: string; features?: { ai?: boolean } }) {
  const policy = adminPolicy();
  return {
    localConfigured: !!config.ollama.url,
    localName: `Local (${config.ollama.model})`,
    externalConfigured: !!config.deepseek.apiKey,
    externalAllowed: user.features?.ai !== false && policy.externalAiEnabled && !!config.deepseek.apiKey
      && user.aiMode !== 'local_only' && user.aiMode !== 'disabled',
    externalName: `DeepSeek (${config.deepseek.model})`,
  };
}

function activeUser(userId: number): any {
  const row = db.prepare('SELECT id,ai_mode,features,disabled_at FROM users WHERE id=?').get(userId) as any;
  if (!row || row.disabled_at) throw Object.assign(new Error('account_unavailable'), { status: 403 });
  return row;
}

function userFeatures(row: any): { ai?: boolean } {
  try {
    const value = typeof row?.features === 'string' ? JSON.parse(row.features || '{}') : row?.features;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

export function assertTranslationProviderAllowed(userId: number, provider: TranslationProvider): TranslationProvider {
  const user = activeUser(userId);
  const features = userFeatures(user);
  if (user.ai_mode === 'disabled' || features.ai === false) {
    throw Object.assign(new Error('ai_disabled'), { status: 403 });
  }
  // Translation jobs are durable and may span many batches. Requiring the
  // currently saved choice here means changing the engine immediately revokes
  // an older queued/running job's authority to contact its previous provider.
  if (getTranslationPreferences(userId).provider !== provider) {
    throw Object.assign(new Error('translation_provider_changed'), { status: 409 });
  }
  if (provider === 'local') {
    if (!config.ollama.url) throw Object.assign(new Error('local_translation_provider_unavailable'), { status: 409 });
    return provider;
  }
  const capabilities = translationCapabilities({ aiMode: user.ai_mode, features });
  if (!capabilities.externalAllowed) {
    throw Object.assign(new Error('external_translation_provider_unavailable'), { status: 409 });
  }
  return provider;
}

export function configuredTranslationTarget(userId: number, value: unknown): string {
  const target = normalizeLanguage(value);
  const configured = getTranslationPreferences(userId).languages;
  if (!configured.some(language => language.toLowerCase() === target.toLowerCase())) {
    throw Object.assign(new Error('translation_language_not_configured'), { status: 400 });
  }
  return configured.find(language => language.toLowerCase() === target.toLowerCase())!;
}

export function languageName(language: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language; }
  catch { return language; }
}

export const translationPreferenceTestApi = { defaultLanguages, MAX_LANGUAGES };
