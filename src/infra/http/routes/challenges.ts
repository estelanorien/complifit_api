import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

const challengeSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.enum(['workouts', 'distance', 'calories']),
  target: z.number(),
  durationDays: z.number(),
  xpReward: z.number(),
  participants: z.number().optional(),
  isActive: z.boolean().optional(),
  image: z.string().optional()
});

export async function challengesRoutes(app: FastifyInstance) {
  app.get('/challenges', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT id, title, description, type, target, duration_days, xp_reward, participants, is_active, image
       FROM challenges`
    );
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      type: r.type,
      target: r.target,
      durationDays: r.duration_days,
      xpReward: r.xp_reward,
      participants: r.participants || 0,
      isActive: r.is_active,
      image: r.image
    }));
  });

  app.post('/challenges', { preHandler: authGuard }, async (req, reply) => {
    const body = challengeSchema.parse(req.body);
    await pool.query(
      `INSERT INTO challenges(id, title, description, type, target, duration_days, xp_reward, participants, is_active, image)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title,
         description=EXCLUDED.description,
         type=EXCLUDED.type,
         target=EXCLUDED.target,
         duration_days=EXCLUDED.duration_days,
         xp_reward=EXCLUDED.xp_reward,
         participants=EXCLUDED.participants,
         is_active=EXCLUDED.is_active,
         image=EXCLUDED.image`,
      [
        body.id,
        body.title,
        body.description || null,
        body.type,
        body.target,
        body.durationDays,
        body.xpReward,
        body.participants || 0,
        body.isActive ?? true,
        body.image || null
      ]
    );
    return reply.send({ success: true });
  });
}

