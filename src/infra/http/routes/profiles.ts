import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

const saveSchema = z.object({
  profile: z.record(z.any()),
  metrics: z.record(z.any())
});

export async function profileRoutes(app: FastifyInstance) {
  app.get('/profiles/me', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    // Check if biometric columns exist, if not use fallback query
    let rows;
    try {
      const { rows: testRows } = await pool.query(
        `SELECT up.profile_data, up.health_metrics, up.age, up.gender, up.height_cm, up.weight_kg, up.avatar_url, u.username, u.email
         FROM users u
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE u.id = $1`,
        [user.userId]
      );
      rows = testRows;
    } catch (e: any) {
      // If columns don't exist, use fallback query without biometric columns
      if (e.code === '42703') {
        const { rows: fallbackRows } = await pool.query(
          `SELECT up.profile_data, up.health_metrics, u.username, u.email
           FROM users u
           LEFT JOIN user_profiles up ON up.user_id = u.id
           WHERE u.id = $1`,
          [user.userId]
        );
        rows = fallbackRows;
      } else {
        throw e;
      }
    }

    const row = rows[0];
    const profileData = (row?.profile_data && Object.keys(row.profile_data).length > 0)
      ? row.profile_data
      : {};

    // Sync biometric columns to profile_data if they exist
    if (row?.age !== null && row?.age !== undefined) profileData.age = row.age;
    if (row?.gender) profileData.gender = row.gender;
    if (row?.height_cm !== null && row?.height_cm !== undefined) profileData.height = row.height_cm;
    if (row?.weight_kg !== null && row?.weight_kg !== undefined) profileData.weight = parseFloat(row.weight_kg);

    // Sync avatar_url to profile_data (prefer column over JSONB)
    if (row?.avatar_url) {
      profileData.avatar = row.avatar_url;
    } else if (profileData.avatar) {
      // Keep JSONB avatar if column is empty (backward compatibility)
    }

    if (!profileData.name) profileData.name = row?.email || user.email;
    if (!profileData.email) profileData.email = row?.email || user.email;
    if (!profileData.username) profileData.username = row?.username || (row?.email ? row.email.split('@')[0] : 'user');

    const metrics = row?.health_metrics || {};
    return { profile: profileData, metrics };
  });

  app.post('/profiles/save', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = saveSchema.parse(req.body);

    // Extract biometric data from profile
    const age = body.profile?.age ? parseInt(body.profile.age) : null;
    const gender = body.profile?.gender || null;
    const height_cm = body.profile?.height ? parseInt(body.profile.height) : null;
    const weight_kg = body.profile?.weight ? parseFloat(body.profile.weight) : null;
    const avatar_url = body.profile?.avatar || null;
    const phone_number = body.profile?.phoneNumber || null;
    const phone_hash = body.profile?.phoneHash || null;

    const client = await pool.connect();
    // Prevent unhandled error event crash
    const errorHandler = (err: any) => {
      req.log?.error({ err }, 'Database client error in transaction');
    };
    client.on('error', errorHandler);

    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');

      // Try with biometric columns first, fallback if they don't exist
      try {
        await client.query(
          `INSERT INTO user_profiles(user_id, profile_data, health_metrics, age, gender, height_cm, weight_kg, avatar_url, phone_number, phone_hash, updated_at)
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
             ON CONFLICT (user_id) DO UPDATE SET 
               profile_data = EXCLUDED.profile_data, 
               health_metrics = EXCLUDED.health_metrics,
               age = EXCLUDED.age,
               gender = EXCLUDED.gender,
               height_cm = EXCLUDED.height_cm,
               weight_kg = EXCLUDED.weight_kg,
               avatar_url = EXCLUDED.avatar_url,
               phone_number = EXCLUDED.phone_number,
               phone_hash = EXCLUDED.phone_hash,
               updated_at = now()`,
          [user.userId, body.profile, body.metrics, age, gender, height_cm, weight_kg, avatar_url, phone_number, phone_hash]
        );
      } catch (e: any) {
        // If columns don't exist, use fallback query without biometric columns
        if (e.code === '42703') {
          await client.query(
            `INSERT INTO user_profiles(user_id, profile_data, health_metrics, updated_at)
             VALUES($1, $2, $3, now())
             ON CONFLICT (user_id) DO UPDATE SET 
               profile_data = EXCLUDED.profile_data, 
               health_metrics = EXCLUDED.health_metrics,
               updated_at = now()`,
            [user.userId, body.profile, body.metrics]
          );
        } else {
          throw e;
        }
      }

      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      req.log?.error(e);
      return reply.status(500).send({ error: isProduction ? 'Profile save service unavailable' : (e.message || 'Profile save failed') });
    } finally {
      client.off('error', errorHandler);
      client.release();
    }
  });
}

