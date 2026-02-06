import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

const postSchema = z.object({
  caption: z.string(),
  type: z.enum(['text', 'image', 'video', 'flex_workout']).default('text'),
  mediaUrl: z.string().optional(),
  flexData: z.record(z.string(), z.unknown()).optional(),
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
  // System Messages (Announcements, etc.)
  app.get('/social/system-messages', { preHandler: authGuard }, async (req, reply) => {
    // Return empty list for now, or fetch from DB if table exists. 
    // Assuming empty is safe to fix 404.
    return [];
  });

  app.get('/social/feed', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
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
    const user = (req as AuthenticatedRequest).user;
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
    const user = (req as AuthenticatedRequest).user;
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
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'nearby users failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Failed to find nearby users' });
    }
  });

  // Update user location
  app.post('/social/location', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
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

  // ========== FRIEND GRAPH ==========
  const followSchema = z.object({
    targetId: z.string()
  });

  app.post('/social/follow', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { targetId } = followSchema.parse(req.body);

    if (user.userId === targetId) {
      return reply.status(400).send({ error: "Cannot follow yourself" });
    }

    await pool.query(
      `INSERT INTO friendships (follower_id, following_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [user.userId, targetId]
    );
    return reply.send({ success: true });
  });

  app.get('/social/squad', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.email, up.profile_data->>'avatar' as avatar, f.created_at
       FROM friendships f
       JOIN users u ON f.following_id = u.id
       LEFT JOIN user_profiles up ON u.id = up.user_id
       WHERE f.follower_id = $1 AND f.status = 'accepted'
       ORDER BY f.created_at DESC`,
      [user.userId]
    );
    return rows;
  });

  // Match Contacts (Privacy Preserved)
  const matchContactsSchema = z.object({
    hashes: z.array(z.string())
  });

  app.post('/social/match-contacts', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { hashes } = matchContactsSchema.parse(req.body);

    if (hashes.length === 0) return [];
    if (hashes.length > 2000) return reply.status(400).send({ error: "Too many contacts" });

    // 1. Find users with matching phone hashes
    const { rows: matches } = await pool.query(
      `SELECT up.user_id as id, up.profile_data->>'name' as name, up.profile_data->>'avatar' as avatar, up.phone_hash
       FROM user_profiles up
       WHERE up.phone_hash = ANY($1)
         AND up.user_id != $2`,
      [hashes, user.userId]
    );

    if (matches.length === 0) return [];

    // 2. Check friendship status
    // Optimization: Get all my followings in one go
    const { rows: following } = await pool.query(
      `SELECT following_id FROM friendships WHERE follower_id = $1`,
      [user.userId]
    );
    const followingSet = new Set(following.map(f => f.following_id));

    // 3. Map status
    const results = matches.map(m => ({
      ...m,
      isFriend: followingSet.has(m.id)
    }));

    return results;
  });

  // Search Users
  app.get('/social/users/search', { preHandler: authGuard }, async (req) => {
    const { q } = req.query as { q?: string };
    if (!q || q.length < 3) return [];

    const { rows } = await pool.query(
      `SELECT id, username, email, profile_data->>'avatar' as avatar 
       FROM users 
       WHERE username ILIKE $1 OR email ILIKE $1 
       LIMIT 10`,
      [`%${q}%`]
    );
    return rows;
  });
}
