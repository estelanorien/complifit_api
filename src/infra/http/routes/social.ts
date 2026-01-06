import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

const postSchema = z.object({
  caption: z.string(),
  type: z.enum(['text', 'image', 'video', 'flex_workout']).default('text'),
  mediaUrl: z.string().optional(),
  flexData: z.record(z.any()).optional(),
  visibility: z.enum(['public', 'friends']).optional()
});

export async function socialRoutes(app: FastifyInstance) {
  app.get('/social/feed', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    // Visibility kontrolü: public post'lar + kullanıcının kendi post'ları + friends post'ları (eğer friends sistemi varsa)
    // Şimdilik: public + kullanıcının kendi post'ları
    const { rows } = await pool.query(
      `SELECT * FROM social_posts 
       WHERE visibility = 'public' 
          OR user_id = $1
       ORDER BY timestamp DESC 
       LIMIT 50`,
      [user.userId]
    );
    return rows;
  });

  app.post('/social/posts', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = postSchema.parse(req.body);
    const id = `post_${Date.now()}`;
    await pool.query(
      `INSERT INTO social_posts(id, user_id, user_name, user_avatar, type, caption, media_url, timestamp, likes, comments, flex_data, visibility)
       VALUES($1,$2,$3,$4,$5,$6,$7, now(), $8, 0, $9, $10)`,
      [
        id,
        user.userId,
        user.email,
        null,
        body.type,
        body.caption,
        body.mediaUrl || null,
        [],
        body.flexData || {},
        body.visibility || 'public'
      ]
    );
    return reply.send({ id });
  });
}

