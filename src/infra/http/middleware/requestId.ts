import { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';

/**
 * Request ID middleware
 * Generates a unique request ID for each request and adds it to response headers
 */
export async function requestIdMiddleware(
  req: FastifyRequest,
  reply: FastifyReply
) {
  // Use existing request ID from header if present, otherwise generate new one
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  
  // Store in request object for use in handlers and error handler
  (req as any).requestId = requestId;
  
  // Add to response headers
  reply.header('X-Request-ID', requestId);
  
  // Also add to log context
  req.log = req.log.child({ requestId });
}

