import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// Get NODE_ENV first to determine validation strictness
const nodeEnv = (process.env.NODE_ENV || 'development') as 'development' | 'production' | 'test';
const isProduction = nodeEnv === 'production';

const envSchema = z.object({
  PORT: z.string().optional().transform(val => val ? Number(val) : 8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: isProduction
    ? z.string().min(32, 'JWT_SECRET must be at least 32 characters for production security')
    : z.string().min(1, 'JWT_SECRET is required'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GOOGLE_PLACES_KEY: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  ALLOWED_ORIGINS: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional()
});

const parseEnv = () => {
  try {
    const parsed = envSchema.parse({
      PORT: process.env.PORT,
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET: process.env.JWT_SECRET,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_PLACES_KEY: process.env.GOOGLE_PLACES_KEY,
      NODE_ENV: process.env.NODE_ENV,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
      YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
      YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN
    });
    return parsed;
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Environment validation failed: ${messages}`);
    }
    throw error;
  }
};

const envVars = parseEnv();

export const env = {
  port: envVars.PORT,
  databaseUrl: envVars.DATABASE_URL,
  jwtSecret: envVars.JWT_SECRET,
  geminiApiKey: envVars.GEMINI_API_KEY,
  googlePlacesKey: envVars.GOOGLE_PLACES_KEY,
  nodeEnv: envVars.NODE_ENV,
  allowedOrigins: envVars.ALLOWED_ORIGINS ? envVars.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : undefined,
  youtube: {
    clientId: envVars.YOUTUBE_CLIENT_ID,
    clientSecret: envVars.YOUTUBE_CLIENT_SECRET,
    refreshToken: envVars.YOUTUBE_REFRESH_TOKEN
  }
};

