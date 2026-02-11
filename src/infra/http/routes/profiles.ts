import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

// Types for profile data
interface ProfileData {
  id?: string;
  email?: string;
  username?: string;
  name?: string;
  role?: string;
  age?: number;
  gender?: string;
  height?: number;
  weight?: number;
  avatar?: string;
  phoneNumber?: string;
  phoneHash?: string;
  [key: string]: unknown;
}

interface ProfileRow {
  id: string;
  email: string;
  username?: string;
  role?: string;
  profile_data?: ProfileData | null;
  health_metrics?: Record<string, unknown> | null;
  age?: number | null;
  gender?: string | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  avatar_url?: string | null;
}

interface DbError extends Error {
  code?: string;
}

const saveSchema = z.object({
  profile: z.record(z.unknown()),
  metrics: z.record(z.unknown())
});

export async function profileRoutes(app: FastifyInstance) {
  app.get('/profiles/me', { preHandler: authGuard }, async (req, reply) => {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    const safeProfile = () => ({
      profile: {
        id: user?.userId ?? user?.id ?? '',
        email: user?.email ?? '',
        username: (user?.email ?? '').split('@')[0] || 'user',
        name: user?.email ?? '',
        role: 'user',
      },
      metrics: {},
    });

    try {
      if (!user?.userId && !user?.id) {
        return reply.status(200).send(safeProfile());
      }
      const userId = user?.userId ?? user?.id;
      let rows: ProfileRow[] = [];
      try {
        const result = await pool.query<ProfileRow>(
          `SELECT up.profile_data, up.health_metrics, up.age, up.gender, up.height_cm, up.weight_kg, up.avatar_url, u.username, u.email, u.role, u.id
           FROM users u
           LEFT JOIN user_profiles up ON up.user_id = u.id
           WHERE u.id = $1`,
          [userId]
        );
        rows = result.rows ?? [];
      } catch (e: unknown) {
        const dbError = e as DbError;
        if (dbError.code === '42703') {
          const result = await pool.query<ProfileRow>(
            `SELECT up.profile_data, up.health_metrics, u.username, u.email, u.role, u.id
             FROM users u
             LEFT JOIN user_profiles up ON up.user_id = u.id
             WHERE u.id = $1`,
            [userId]
          );
          rows = result.rows ?? [];
        } else if (dbError.code === '42P01') {
          const result = await pool.query<ProfileRow>(
            `SELECT u.username, u.email, u.role, u.id FROM users u WHERE u.id = $1`,
            [userId]
          );
          rows = result.rows?.length ? [{ ...result.rows[0], profile_data: null, health_metrics: null }] : [];
        } else {
          req.log?.warn({ err: e }, '[profiles/me] DB error, returning minimal profile');
    
          return reply.status(200).send(safeProfile());
        }
      }

      const row = rows?.[0];
      const profileData: ProfileData =
        row?.profile_data && typeof row.profile_data === 'object' && Object.keys(row.profile_data).length > 0
          ? { ...row.profile_data }
          : {};

      if (row?.age != null) profileData.age = row.age;
      if (row?.gender) profileData.gender = row.gender;
      if (row?.height_cm != null) profileData.height = row.height_cm;
      if (row?.weight_kg != null) profileData.weight = parseFloat(String(row.weight_kg));
      if (row?.avatar_url) profileData.avatar = row.avatar_url;

      profileData.name = profileData.name || row?.email || user?.email || '';
      profileData.email = profileData.email || row?.email || user?.email || '';
      profileData.username = profileData.username || row?.username || (row?.email ? String(row.email).split('@')[0] : 'user');
      profileData.id = row?.id ?? user?.userId;
      profileData.role = row?.role || 'user';

      const metrics = row?.health_metrics && typeof row.health_metrics === 'object' ? row.health_metrics : {};

      return reply.status(200).send({ profile: profileData, metrics });
    } catch (e: unknown) {
      req.log?.warn({ err: e }, '[profiles/me] error - never 500, returning minimal profile');

      try {
        return reply.status(200).send(safeProfile());
      } catch {
        return reply.status(200).send({ profile: { id: '', email: '', username: 'user', name: '', role: 'user' }, metrics: {} });
      }
    }
  });

  app.post('/profiles/save', { preHandler: authGuard }, async (req, reply) => {
    const authReq = req as AuthenticatedRequest;
    const body = saveSchema.parse(req.body);
    const profile = body.profile as ProfileData;

    // Extract biometric data from profile
    const age = profile?.age ? Number(profile.age) : null;
    const gender = (profile?.gender as string) || null;
    const height_cm = profile?.height ? Number(profile.height) : null;
    const weight_kg = profile?.weight ? Number(profile.weight) : null;
    const avatar_url = (profile?.avatar as string) || null;
    const phone_number = (profile?.phoneNumber as string) || null;
    const phone_hash = (profile?.phoneHash as string) || null;

    const client = await pool.connect();
    // Prevent unhandled error event crash
    const errorHandler = (err: Error) => {
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
          [authReq.user.userId, body.profile, body.metrics, age, gender, height_cm, weight_kg, avatar_url, phone_number, phone_hash]
        );
      } catch (e: unknown) {
        const dbError = e as DbError;
        // If columns don't exist, use fallback query without biometric columns
        if (dbError.code === '42703') {
          await client.query(
            `INSERT INTO user_profiles(user_id, profile_data, health_metrics, updated_at)
             VALUES($1, $2, $3, now())
             ON CONFLICT (user_id) DO UPDATE SET
               profile_data = EXCLUDED.profile_data,
               health_metrics = EXCLUDED.health_metrics,
               updated_at = now()`,
            [authReq.user.userId, body.profile, body.metrics]
          );
        } else {
          throw e;
        }
      }

      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      const error = e as Error;
      req.log?.error(e);
      return reply.status(500).send({ error: isProduction ? 'Profile save service unavailable' : (error.message || 'Profile save failed') });
    } finally {
      client.off('error', errorHandler);
      client.release();
    }
  });

  // Trainer Profile Update
  app.post('/profiles/trainer', { preHandler: authGuard }, async (req, reply) => {
    const authReq = req as AuthenticatedRequest;
    const body = z.object({ updates: z.record(z.unknown()) }).parse(req.body);

    try {
      const { rows } = await pool.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
        [authReq.user.userId]
      );

      const existing = rows[0]?.profile_data || {};
      const merged = { ...existing, ...body.updates };

      await pool.query(
        `UPDATE user_profiles SET profile_data = $1::jsonb, updated_at = now() WHERE user_id = $2`,
        [JSON.stringify(merged), authReq.user.userId]
      );

      return reply.send({ success: true, profile: merged });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Trainer profile update failed', message: error.message });
      return reply.status(500).send({ error: 'Trainer profile update failed' });
    }
  });

  // FCM Token (for push notifications)
  app.post('/profiles/fcm-token', { preHandler: authGuard }, async (req, reply) => {
    const authReq = req as AuthenticatedRequest;
    const body = z.object({ fcmToken: z.string().min(1) }).safeParse(req.body);

    if (!body.success) {
      return reply.status(400).send({ error: 'fcmToken is required' });
    }

    try {
      await pool.query(
        `UPDATE user_profiles SET fcm_token = $1, updated_at = now() WHERE user_id = $2`,
        [body.data.fcmToken, authReq.user.userId]
      );
      return reply.send({ success: true });
    } catch (e: unknown) {
      req.log.error({ error: 'FCM token save failed', e });
      return reply.status(500).send({ error: 'Failed to save FCM token' });
    }
  });
}

