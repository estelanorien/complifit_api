import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';

// Input validation schema for search
const searchQuerySchema = z.object({
    q: z.string()
        .min(2, 'Search query must be at least 2 characters')
        .max(100, 'Search query too long')
        .transform(val => val.trim())
});

// Sanitize search input to prevent SQL injection via LIKE patterns
const sanitizeSearchInput = (input: string): string => {
    // Escape special LIKE pattern characters: %, _, \
    return input
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
};

export async function usersRoutes(app: FastifyInstance) {
  app.get('/users/search', { preHandler: authGuard }, async (req, reply) => {
    // Validate and sanitize input
    const parseResult = searchQuerySchema.safeParse(req.query);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid search query',
        details: parseResult.error.issues.map(i => i.message)
      });
    }

    const sanitizedQuery = sanitizeSearchInput(parseResult.data.q);

    const { rows } = await pool.query(
      `SELECT user_id, profile_data
       FROM user_profiles
       WHERE profile_data->>'name' ILIKE $1
       LIMIT 10`,
      [`%${sanitizedQuery}%`]
    );

    return rows.map((r: { user_id: string; profile_data: { name?: string; username?: string; avatar?: string } | null }) => ({
      user_id: r.user_id,
      name: r.profile_data?.name,
      username: r.profile_data?.username,
      avatar: r.profile_data?.avatar
    }));
  });
}

