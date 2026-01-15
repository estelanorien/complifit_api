import { FastifyInstance } from 'fastify';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';

export async function usersRoutes(app: FastifyInstance) {
  app.get('/users/search', { preHandler: authGuard }, async (req) => {
    const q = (req.query as any).q || '';
    if (!q || String(q).length < 1) return [];
    const { rows } = await pool.query(
      `SELECT user_id, profile_data
       FROM user_profiles
       WHERE profile_data->>'name' ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    return rows.map((r: any) => ({
      user_id: r.user_id,
      name: r.profile_data?.name,
      username: r.profile_data?.username,
      avatar: r.profile_data?.avatar
    }));
  });
}

