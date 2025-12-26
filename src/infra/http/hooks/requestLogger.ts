import { FastifyRequest, FastifyReply } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogFileName(): string {
  const today = new Date().toISOString().split('T')[0];
  return path.join(LOGS_DIR, `api-${today}.log`);
}

function sanitizeBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  
  const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'authorization', 'authToken'];
  const sanitized = { ...body };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '***REDACTED***';
    }
  }
  
  return sanitized;
}

function formatLogEntry(
  userId: string | null,
  method: string,
  url: string,
  statusCode: number,
  responseTime: number,
  requestBody?: any,
  error?: string
): string {
  const timestamp = new Date().toISOString();
  const log: any = {
    timestamp,
    userId: userId || 'anonymous',
    method,
    url,
    statusCode,
    responseTime: `${responseTime.toFixed(2)}ms`,
  };

  if (requestBody && Object.keys(requestBody).length > 0) {
    log.requestBody = sanitizeBody(requestBody);
  }

  if (error) {
    log.error = error;
  }

  return JSON.stringify(log) + '\n';
}

// Store request start times
const requestTimers = new Map<string, number>();

export async function requestLogger(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = `${req.id}-${Date.now()}`;
  const startTime = Date.now();
  requestTimers.set(requestId, startTime);
  (req as any).__requestId = requestId;
}

export async function responseLogger(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = (req as any).__requestId;
  if (!requestId) return;

  const startTime = requestTimers.get(requestId) || Date.now();
  const responseTime = Date.now() - startTime;
  requestTimers.delete(requestId);

  // Get userId from request (set by authGuard if authenticated)
  const userId = (req as any).user?.userId || (req as any).user?.id || (req as any).user?.sub || null;
  const method = req.method;
  const url = req.url;
  const statusCode = reply.statusCode;
  let requestBody: any = null;

  // Capture request body for POST/PUT/PATCH (body is parsed by Fastify at this point)
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    try {
      requestBody = req.body;
    } catch (e) {
      // Body might not be available
    }
  }

  const logEntry = formatLogEntry(
    userId,
    method,
    url,
    statusCode,
    responseTime,
    requestBody,
    statusCode >= 400 ? `HTTP ${statusCode}` : undefined
  );

  try {
    fs.appendFileSync(getLogFileName(), logEntry, 'utf8');
  } catch (error) {
    console.error('Failed to write log:', error);
  }
}

export async function errorLogger(
  req: FastifyRequest,
  reply: FastifyReply,
  error: Error
) {
  const requestId = (req as any).__requestId;
  if (!requestId) return;

  const startTime = requestTimers.get(requestId) || Date.now();
  const responseTime = Date.now() - startTime;
  requestTimers.delete(requestId);

  // Get userId from request (set by authGuard if authenticated)
  const userId = (req as any).user?.userId || (req as any).user?.id || (req as any).user?.sub || null;
  const method = req.method;
  const url = req.url;
  let requestBody: any = null;

  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    try {
      requestBody = req.body;
    } catch (e) {
      // Body might not be available
    }
  }

  const logEntry = formatLogEntry(
    userId,
    method,
    url,
    reply.statusCode || 500,
    responseTime,
    requestBody,
    error.message || 'Unknown error'
  );

  try {
    fs.appendFileSync(getLogFileName(), logEntry, 'utf8');
  } catch (logError) {
    console.error('Failed to write error log:', logError);
  }
}

