import { OpenAIProvider } from '../models/openai-provider.js';
import { LocalModelProvider } from '../models/local-provider.js';

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function readMaxRepairAttempts(env) {
  const configured = env.FORGE_MAX_REPAIR_ATTEMPTS?.trim();
  if (!configured) return 3;
  const attempts = Number(configured);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new ConfigurationError('FORGE_MAX_REPAIR_ATTEMPTS must be a whole number from 1 to 10.');
  }
  return attempts;
}

export function loadConfig(env = process.env) {
  const maxRepairAttempts = readMaxRepairAttempts(env);
  const providerName = (env.FORGE_PROVIDER ?? env.MODEL_PROVIDER ?? 'openai').trim().toLowerCase();
  if (providerName === 'local') {
    const model = env.MODEL_NAME?.trim() || env.FORGE_MODEL?.trim();
    const baseUrl = env.MODEL_BASE_URL?.trim() || env.FORGE_BASE_URL?.trim();
    if (!model) {
      throw new ConfigurationError('Forge cannot start because the local model is not configured. Missing model name. Set MODEL_NAME or FORGE_MODEL.');
    }
    if (!baseUrl) {
      throw new ConfigurationError('Forge cannot start because the local model endpoint is not configured. Set MODEL_BASE_URL or FORGE_BASE_URL.');
    }

    return {
      provider: 'local',
      model,
      apiKey: env.OPENAI_API_KEY?.trim() || null,
      baseUrl,
      contextWindow: Number(env.MODEL_CONTEXT_WINDOW || env.FORGE_CONTEXT_WINDOW || 0) || null,
      fallback: env.FORGE_FALLBACK_MODEL?.trim() || null,
      maxRepairAttempts
    };
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigurationError('Forge cannot start because the required API key is not configured. Set OPENAI_API_KEY or configure a local model with MODEL_NAME and MODEL_BASE_URL.');
  }

  if (env.FORGE_PROVIDER || env.MODEL_PROVIDER) {
    return {
      provider: providerName,
      model: env.FORGE_MODEL?.trim() || 'gpt-4o-mini',
      apiKey,
      baseUrl: env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_BASE?.trim() || undefined,
      contextWindow: Number(env.MODEL_CONTEXT_WINDOW || env.FORGE_CONTEXT_WINDOW || 0) || null,
      fallback: env.FORGE_FALLBACK_MODEL?.trim() || null,
      maxRepairAttempts
    };
  }

  return {
    model: env.FORGE_MODEL?.trim() || 'gpt-4o-mini',
    apiKey,
    maxRepairAttempts
  };
}

export function createModelProvider(config = {}) {
  const normalized = { ...config };
  const providerName = (normalized.provider || 'openai').toLowerCase();
  if (providerName === 'local') {
    return new LocalModelProvider({
      model: normalized.model,
      baseUrl: normalized.baseUrl,
      apiKey: normalized.apiKey ?? null,
      contextWindow: normalized.contextWindow ?? null
    });
  }
  if (providerName === 'openai') {
    return new OpenAIProvider({
      apiKey: normalized.apiKey,
      model: normalized.model || 'gpt-4o-mini',
      contextWindow: normalized.contextWindow ?? 128000,
      baseUrl: normalized.baseUrl
    });
  }

  throw new ConfigurationError(`Unsupported model provider "${providerName}". Supported providers: openai, local.`);
}

export function getModelStatus(config = {}) {
  const providerName = (config.provider || 'openai').toLowerCase();
  const model = config.model || (providerName === 'openai' ? 'gpt-4o-mini' : 'unknown');
  if (providerName === 'local') {
    return {
      provider: 'local',
      model,
      available: [model],
      message: 'Using the configured local model endpoint.'
    };
  }
  return {
    provider: 'openai',
    model,
    available: [model],
    message: 'Using the configured OpenAI model.'
  };
}
