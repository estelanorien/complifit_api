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

const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(1).max(500).default(50)
});

// Haversine distance calculation
const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Program similarity score (0-100)
const calculateSimilarity = (userProfile: any, otherProfile: any): number => {
  let score = 0;
  if (userProfile.primaryGoal === otherProfile.primaryGoal) score += 40;
  if (userProfile.trainingStyle === otherProfile.trainingStyle) score += 30;
  if (userProfile.fitnessLevel === otherProfile.fitnessLevel) score += 20;
  if (userProfile.dietaryPreference === otherProfile.dietaryPreference) score += 10;
  return score;
};

export async function socialRoutes(app: FastifyInstance) {
  app.get('/social/feed', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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

  // ========== SPOTTER RADAR - Nearby Users ==========
  app.get('/social/users/nearby', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const query = nearbySchema.parse(req.query);
    const { lat, lng, radiusKm } = query;

    try {
      // Get requesting user's profile for similarity matching
      const userProfileRes = await pool.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
        [user.userId]
      );
      const userProfile = userProfileRes.rows[0]?.profile_data || {};

      // Query users with spotter enabled
      const { rows } = await pool.query(
        `SELECT up.user_id, up.profile_data, ul.lat, ul.lng
         FROM user_profiles up
         LEFT JOIN user_locations ul ON up.user_id = ul.user_id
         WHERE up.user_id != $1
           AND (up.profile_data->'spotterSettings'->>'isActive')::boolean = true
           AND ul.lat IS NOT NULL
           AND ul.lng IS NOT NULL`,
        [user.userId]
      );

      // Filter by distance and calculate similarity scores
      const nearbyUsers = rows
        .map((row: any) => {
          const distance = calculateDistance(lat, lng, row.lat, row.lng);
          const similarity = calculateSimilarity(userProfile, row.profile_data || {});
          return {
            user_id: row.user_id,
            profile: row.profile_data || {},
            distance: Math.round(distance * 10) / 10, // Round to 1 decimal
            similarityScore: similarity,
            location: { lat: row.lat, lng: row.lng }
          };
        })
        .filter((u: any) => u.distance <= radiusKm)
        .sort((a: any, b: any) => b.similarityScore - a.similarityScore); // Most similar first

      return reply.send(nearbyUsers);
    } catch (e: any) {
      req.log.error({ error: 'nearby users failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Failed to find nearby users' });
    }
  });

  // Update user location
  app.post('/social/location', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180)
    }).parse(req.body);

    await pool.query(
      `INSERT INTO user_locations (user_id, lat, lng, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET lat = $2, lng = $3, updated_at = now()`,
      [user.userId, body.lat, body.lng]
    );

    return reply.send({ success: true });
  });
}
