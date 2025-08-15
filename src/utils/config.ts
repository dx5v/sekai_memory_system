import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

export interface Config {
  llm: {
    provider: 'openai' | 'anthropic';
    model: string;
    maxTokens: number;
    apiKey: string;
  };
  embedding: {
    provider: 'openai' | 'hash';
    model: string;
    dimension: number;
  };
  storage: {
    databasePath: string;
  };
  api: {
    port: number;
    host: string;
  };
  development: {
    nodeEnv: string;
    logLevel: string;
  };
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && !defaultValue) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value || defaultValue!;
}

function getEnvVarOptional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config: Config = {
  llm: {
    provider: getEnvVarOptional('LLM_PROVIDER', 'openai') as 'openai' | 'anthropic',
    model: getEnvVarOptional('LLM_MODEL', 'gpt-4'),
    maxTokens: parseInt(getEnvVarOptional('LLM_MAX_TOKENS', '1000'), 10),
    apiKey: getEnvVar('OPENAI_API_KEY') // Will need to handle anthropic key too
  },
  embedding: {
    provider: getEnvVarOptional('EMBEDDING_PROVIDER', 'openai') as 'openai' | 'hash',
    model: getEnvVarOptional('EMBEDDING_MODEL', 'text-embedding-3-small'),
    dimension: parseInt(getEnvVarOptional('EMBEDDING_DIMENSION', '1536'), 10)
  },
  storage: {
    databasePath: getEnvVarOptional('DATABASE_PATH', './data/memories.db')
  },
  api: {
    port: parseInt(getEnvVarOptional('PORT', '3000'), 10),
    host: getEnvVarOptional('HOST', '0.0.0.0')
  },
  development: {
    nodeEnv: getEnvVarOptional('NODE_ENV', 'development'),
    logLevel: getEnvVarOptional('LOG_LEVEL', 'info')
  }
};

// Ensure data directory exists
export function ensureDataDirectory(): void {
  const dataDir = path.dirname(config.storage.databasePath);
  const fs = require('fs');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}