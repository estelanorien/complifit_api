import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../../../application/services/authService.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

const authService = new AuthService();

// Admin role cache with 5-minute TTL to avoid N+1 DB queries
const adminRoleCache = new Map<string, { role: string; expires: number }>();
const ROLE_CACHE_TTL = 5 * 60 * 1000;

export async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const token = header.substring('Bearer '.length);
    const payload = authService.verifyToken(token);
    (req as AuthenticatedRequest).user = payload;
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

export async function adminGuard(req: FastifyRequest, reply: FastifyReply) {
  await authGuard(req, reply);
  if (reply.sent) return;

  try {
    const user = (req as AuthenticatedRequest).user;
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Check cache first
    const cached = adminRoleCache.get(user.userId);
    if (cached && cached.expires > Date.now()) {
      if (cached.role !== 'admin' && cached.role !== 'owner') {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      return;
    }

    const { rows } = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [user.userId]
    );

    const userRole = rows[0]?.role || 'user';
    adminRoleCache.set(user.userId, { role: userRole, expires: Date.now() + ROLE_CACHE_TTL });

    if (userRole !== 'admin' && userRole !== 'owner') {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  } catch (e: unknown) {
    const error = e as Error;
    const isProduction = process.env.NODE_ENV === 'production';
    req.log?.error(e);
    return reply.status(500).send({
      error: isProduction ? 'Authorization check failed' : (error.message || 'Authorization check failed')
    });
  }
}

