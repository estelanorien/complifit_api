import { FastifyRequest, FastifyReply } from 'fastify';
import { authGuard } from './auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

// Subscription tier cache with 5-minute TTL to avoid N+1 DB queries
const tierCache = new Map<string, { tier: string; expires: number }>();
const TIER_CACHE_TTL = 5 * 60 * 1000;

export function invalidateTierCache(userId: string) {
  tierCache.delete(userId);
}

export async function proGuard(req: FastifyRequest, reply: FastifyReply) {
  await authGuard(req, reply);
  if (reply.sent) return;

  try {
    const user = (req as AuthenticatedRequest).user;
    if (!user?.userId) {
      return reply.status(403).send({
        error: 'Subscription Required',
        message: 'Please upgrade to Pro to access this feature.',
        isProContent: true
      });
    }

    // Check cache first
    const cached = tierCache.get(user.userId);
    if (cached && cached.expires > Date.now()) {
      if (cached.tier !== 'pro') {
        return reply.status(403).send({
          error: 'Subscription Required',
          message: 'Please upgrade to Pro to access this feature.',
          isProContent: true
        });
      }
      return;
    }

    const { rows } = await pool.query(
      `SELECT subscription_tier FROM profiles WHERE user_id = $1`,
      [user.userId]
    );

    const tier = rows[0]?.subscription_tier || 'free';
    tierCache.set(user.userId, { tier, expires: Date.now() + TIER_CACHE_TTL });

    if (tier !== 'pro') {
      return reply.status(403).send({
        error: 'Subscription Required',
        message: 'Please upgrade to Pro to access this feature.',
        isProContent: true
      });
    }
  } catch (e: unknown) {
    const error = e as Error;
    const isProduction = process.env.NODE_ENV === 'production';
    req.log?.error(e);
    return reply.status(500).send({
      error: isProduction ? 'Subscription check failed' : (error.message || 'Subscription check failed')
    });
  }
}
