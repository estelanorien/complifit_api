import { FastifyRequest } from 'fastify';

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
