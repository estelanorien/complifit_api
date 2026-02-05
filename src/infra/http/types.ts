import { FastifyRequest, FastifyReply } from 'fastify';

// ============================================================================
// Authentication Types
// ============================================================================

/**
 * JWT payload type from AuthService
 */
export interface JwtPayload {
  userId: string;
  email: string;
}

/**
 * Extended FastifyRequest with authenticated user
 */
export interface AuthenticatedRequest extends FastifyRequest {
  user: JwtPayload;
  requestId?: string;
}

/**
 * Type guard to check if request is authenticated
 */
export function isAuthenticatedRequest(req: FastifyRequest): req is AuthenticatedRequest {
  return 'user' in req && typeof (req as any).user === 'object' && 'userId' in (req as any).user;
}

// ============================================================================
// Gemini API Types
// ============================================================================

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
  safetyRatings?: Array<{
    category: string;
    probability: string;
  }>;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
    blockReason?: string;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiErrorDetail {
  '@type'?: string;
  retryDelay?: string;
  reason?: string;
}

export interface GeminiErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GeminiErrorDetail[];
  };
}

// ============================================================================
// Exercise & Meal Types
// ============================================================================

export interface Exercise {
  id: string;
  name: string;
  category?: string;
  muscleGroups?: string[];
  equipment?: string[];
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  instructions?: string[];
  sets?: string | number;
  reps?: string | number;
  duration?: string | number;
  movementId?: string;
  original_name?: string;
  language?: string;
}

export interface Meal {
  id: string;
  name: string;
  category?: string;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  ingredients?: string[];
  instructions?: string[];
  servingSize?: string;
  prepTime?: number;
  cookTime?: number;
  movementId?: string;
  original_name?: string;
  language?: string;
}

export interface MacroNutrients {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
}

// ============================================================================
// Profile Types
// ============================================================================

export interface UserProfile {
  user_id: string;
  profile_data: ProfileData;
  created_at?: Date;
  updated_at?: Date;
}

export interface ProfileData {
  name?: string;
  username?: string;
  avatar?: string;
  age?: number;
  height?: number;
  weight?: number;
  gender?: 'male' | 'female' | 'other';
  fitnessLevel?: 'beginner' | 'intermediate' | 'advanced';
  goals?: string[];
  dietaryRestrictions?: string[];
  coachSettings?: {
    persona?: 'atlas' | 'nova';
    voiceEnabled?: boolean;
    language?: string;
  };
  [key: string]: unknown; // Allow additional properties
}

// ============================================================================
// Asset Types
// ============================================================================

export type AssetStatus = 'active' | 'generating' | 'failed' | 'rejected' | 'auto' | 'draft';
export type AssetType = 'image' | 'video' | 'json';

export interface AssetMetadata {
  prompt?: string;
  persona?: 'atlas' | 'nova';
  source?: string;
  movementId?: string;
  stepIndex?: number;
  textContext?: string;
  textContextSimple?: string;
  [key: string]: unknown;
}

// ============================================================================
// Route Handler Types
// ============================================================================

/**
 * Standard route handler function type
 */
export type RouteHandler<TBody = unknown, TParams = unknown, TQuery = unknown> = (
  req: FastifyRequest<{
    Body: TBody;
    Params: TParams;
    Querystring: TQuery;
  }>,
  reply: FastifyReply
) => Promise<unknown>;

/**
 * Authenticated route handler function type
 */
export type AuthenticatedRouteHandler<TBody = unknown, TParams = unknown, TQuery = unknown> = (
  req: AuthenticatedRequest & FastifyRequest<{
    Body: TBody;
    Params: TParams;
    Querystring: TQuery;
  }>,
  reply: FastifyReply
) => Promise<unknown>;

// ============================================================================
// Database Row Types
// ============================================================================

export interface DbRow {
  [key: string]: unknown;
}

export interface UserRow {
  id: string;
  email: string;
  username?: string;
  password_hash?: string;
  role?: string;
  created_at?: Date;
}

export interface ProfileRow {
  user_id: string;
  profile_data: ProfileData | string;
  created_at?: Date;
  updated_at?: Date;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  message?: string;
  code?: string;
  details?: unknown;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;
