import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../../../application/services/authService.js';
import { pool } from '../../db/pool.js';

const authService = new AuthService();

export async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const token = header.substring('Bearer '.length);
    const payload = authService.verifyToken(token);
    (req as any).user = payload;
  } catch (e) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

export async function adminGuard(req: FastifyRequest, reply: FastifyReply) {
  // First check authentication
  await authGuard(req, reply);
  if (reply.sent) return; // If authGuard already sent a response, stop here

  try {
    const user = (req as any).user;
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Role-based authorization using the dedicated database column
    const { rows } = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [user.userId]
    );

    const userRole = rows[0]?.role || 'user';

    // Only 'admin' and 'owner' roles have access to admin endpoints
    if (userRole !== 'admin' && userRole !== 'owner') {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  } catch (e: any) {
    const isProduction = process.env.NODE_ENV === 'production';
    req.log?.error(e);
    return reply.status(500).send({
      error: isProduction ? 'Authorization check failed' : (e.message || 'Authorization check failed')
    });
  }
}

