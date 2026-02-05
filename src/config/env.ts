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
  YOUTUBE_REFRESH_TOKEN: z.string().optional(),
  // Push Notifications (VAPID)
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_EMAIL: z.string().optional(),
  // OAuth (Social Login)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  // Email (SMTP) configuration
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional().transform(val => val ? Number(val) : 587),
  SMTP_SECURE: z.string().optional().transform(val => val === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_FROM_NAME: z.string().optional().default('Vitality App'),
  // Frontend URL for password reset links
  FRONTEND_URL: z.string().optional().default('https://vitality.app'),
  // Google Application Credentials for Firebase
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Database SSL configuration
  // Accepts 'true', '1', 'false', '0', or undefined
  // Defaults to true in production, false in development
  DB_SSL_REJECT_UNAUTHORIZED: z.string().optional().transform(val => {
    if (val === undefined || val === null) return undefined;
    return val === 'true' || val === '1';
  })
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
      YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN,
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
      VAPID_EMAIL: process.env.VAPID_EMAIL,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
      FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
    APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
    APPLE_KEY_ID: process.env.APPLE_KEY_ID,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    EMAIL_FROM: process.env.EMAIL_FROM,
    EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME,
    FRONTEND_URL: process.env.FRONTEND_URL,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED
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
  },
  vapid: {
    publicKey: envVars.VAPID_PUBLIC_KEY,
    privateKey: envVars.VAPID_PRIVATE_KEY,
    email: envVars.VAPID_EMAIL
  },
  oauth: {
    google: {
      clientId: envVars.GOOGLE_CLIENT_ID,
      clientSecret: envVars.GOOGLE_CLIENT_SECRET
    },
    facebook: {
      appId: envVars.FACEBOOK_APP_ID,
      appSecret: envVars.FACEBOOK_APP_SECRET
    },
    apple: {
      clientId: envVars.APPLE_CLIENT_ID,
      teamId: envVars.APPLE_TEAM_ID,
      keyId: envVars.APPLE_KEY_ID
    }
  },
  email: {
    host: envVars.SMTP_HOST,
    port: envVars.SMTP_PORT,
    secure: envVars.SMTP_SECURE,
    user: envVars.SMTP_USER,
    pass: envVars.SMTP_PASS,
    from: envVars.EMAIL_FROM,
    fromName: envVars.EMAIL_FROM_NAME
  },
  frontendUrl: envVars.FRONTEND_URL,
  googleApplicationCredentials: envVars.GOOGLE_APPLICATION_CREDENTIALS,
  dbSslRejectUnauthorized: envVars.DB_SSL_REJECT_UNAUTHORIZED ?? (envVars.NODE_ENV === 'production' ? true : false)
};

