import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../../../application/services/authService.js';
import { pool } from '../../db/pool.js';

const authService = new AuthService();

export async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    // Support both Authorization header (Bearer token) and query parameter (for EventSource)
    let token: string | undefined;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      token = header.substring('Bearer '.length);
    } else {
      const query = (req as any).query as { token?: string };
      token = query?.token;
    }
    if (!token) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'false');
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const payload = authService.verifyToken(token);
    (req as any).user = payload;
  } catch (e) {
    if (!reply.sent) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'false');
      try {
        return reply.status(401).send({ error: 'Unauthorized' });
      } catch (sendErr) {
        if (!reply.sent) {
          try {
            reply.status(401).send({ error: 'Unauthorized' });
          } catch {
            // avoid rethrow so global handler does not double-respond with 500
          }
        }
      }
    }
  }
}

export async function adminGuard(req: FastifyRequest, reply: FastifyReply) {
  // First check authentication
  await authGuard(req, reply);
  if (reply.sent) return; // If authGuard already sent a response, stop here

  try {
    const user = (req as any).user;
    if (!user?.userId) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'false');
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
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'false');
      return reply.status(403).send({ error: 'Forbidden' });
    }
  } catch (e: any) {
    const isProduction = process.env.NODE_ENV === 'production';
    req.log?.error(e);
    if (!reply.sent) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'false');
      return reply.status(500).send({
        error: isProduction ? 'Authorization check failed' : (e.message || 'Authorization check failed')
      });
    }
  }
}

