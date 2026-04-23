import { Options } from '../types/requestBody';
import conf from '../../conf.json';

type CredentialMap = Record<string, unknown>;

const CONF_INTEGRATIONS: Array<{
  provider: string;
  slug?: string;
  credentials?: CredentialMap;
}> =
  ((conf as { integrations?: unknown[] }).integrations as Array<{
    provider: string;
    slug?: string;
    credentials?: CredentialMap;
  }>) ?? [];

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '';

type EnvFieldMap = Partial<Record<keyof Options, string>>;

const ENV_MAP: Record<string, EnvFieldMap> = {
  bedrock: {
    awsAccessKeyId: 'AWS_ACCESS_KEY_ID',
    awsSecretAccessKey: 'AWS_SECRET_ACCESS_KEY',
    awsSessionToken: 'AWS_SESSION_TOKEN',
    awsRegion: 'AWS_REGION',
    awsRoleArn: 'AWS_ROLE_ARN',
    awsExternalId: 'AWS_EXTERNAL_ID',
    apiKey: 'BEDROCK_API_KEY',
  },
  sagemaker: {
    awsAccessKeyId: 'AWS_ACCESS_KEY_ID',
    awsSecretAccessKey: 'AWS_SECRET_ACCESS_KEY',
    awsSessionToken: 'AWS_SESSION_TOKEN',
    awsRegion: 'AWS_REGION',
    awsRoleArn: 'AWS_ROLE_ARN',
  },
  openai: {
    apiKey: 'OPENAI_API_KEY',
    openaiOrganization: 'OPENAI_ORGANIZATION',
    openaiProject: 'OPENAI_PROJECT',
  },
  openrouter: {
    apiKey: 'OPENROUTER_API_KEY',
  },
  anthropic: {
    apiKey: 'ANTHROPIC_API_KEY',
  },
  groq: { apiKey: 'GROQ_API_KEY' },
  cerebras: { apiKey: 'CEREBRAS_API_KEY' },
  mistral: { apiKey: 'MISTRAL_API_KEY' },
  cohere: { apiKey: 'COHERE_API_KEY' },
  deepseek: { apiKey: 'DEEPSEEK_API_KEY' },
  fireworks: { apiKey: 'FIREWORKS_API_KEY' },
  'fireworks-ai': { apiKey: 'FIREWORKS_API_KEY' },
  together: { apiKey: 'TOGETHER_API_KEY' },
  'together-ai': { apiKey: 'TOGETHER_API_KEY' },
  perplexity: { apiKey: 'PERPLEXITY_API_KEY' },
  'perplexity-ai': { apiKey: 'PERPLEXITY_API_KEY' },
  xai: { apiKey: 'XAI_API_KEY' },
  google: { apiKey: 'GOOGLE_API_KEY' },
  'azure-openai': {
    apiKey: 'AZURE_OPENAI_API_KEY',
    resourceName: 'AZURE_OPENAI_RESOURCE_NAME',
    deploymentId: 'AZURE_OPENAI_DEPLOYMENT_ID',
    apiVersion: 'AZURE_OPENAI_API_VERSION',
  },
  'azure-ai': {
    apiKey: 'AZURE_AI_API_KEY',
    azureApiVersion: 'AZURE_AI_API_VERSION',
    azureFoundryUrl: 'AZURE_AI_FOUNDRY_URL',
    azureDeploymentName: 'AZURE_AI_DEPLOYMENT_NAME',
  },
  'vertex-ai': {
    vertexProjectId: 'VERTEX_PROJECT_ID',
    vertexRegion: 'VERTEX_REGION',
    vertexStorageBucketName: 'VERTEX_STORAGE_BUCKET',
  },
  'workers-ai': {
    apiKey: 'CLOUDFLARE_API_KEY',
    workersAiAccountId: 'CLOUDFLARE_ACCOUNT_ID',
  },
  huggingface: {
    apiKey: 'HUGGINGFACE_API_KEY',
    huggingfaceBaseUrl: 'HUGGINGFACE_BASE_URL',
  },
  'stability-ai': { apiKey: 'STABILITY_API_KEY' },
  oracle: { apiKey: 'ORACLE_API_KEY' },
  cortex: { apiKey: 'CORTEX_API_KEY' },
};

function applyConfFallback(
  provider: string,
  result: Partial<Options>
): Partial<Options> {
  const integration = CONF_INTEGRATIONS.find((i) => i.provider === provider);
  if (!integration?.credentials) return result;

  for (const [key, value] of Object.entries(integration.credentials)) {
    const field = key as keyof Options;
    if (isEmpty(result[field]) && !isEmpty(value)) {
      (result as Record<string, unknown>)[field] = value;
    }
  }
  return result;
}

function applyEnvFallback(
  provider: string,
  result: Partial<Options>
): Partial<Options> {
  const fieldMap = ENV_MAP[provider];
  if (!fieldMap) return result;

  for (const [field, envVar] of Object.entries(fieldMap) as Array<
    [keyof Options, string]
  >) {
    if (isEmpty(result[field]) && process.env[envVar]) {
      (result as Record<string, unknown>)[field] = process.env[envVar];
    }
  }
  return result;
}

export function resolveCredentials(
  provider: string | undefined,
  headerCreds: Partial<Options>
): Partial<Options> {
  if (!provider) return headerCreds;

  const result: Partial<Options> = { ...headerCreds };
  applyConfFallback(provider, result);
  applyEnvFallback(provider, result);
  return result;
}
