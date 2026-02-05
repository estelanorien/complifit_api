/**
 * Video Admin Routes - Phase 2 Video Pipeline Management
 *
 * Endpoints for:
 * - Triggering Phase 2 video generation
 * - Reviewing pending videos
 * - Approving/rejecting videos
 * - Monitoring video job status
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { authGuard } from '../hooks/auth.js';
import { videoOrchestrator } from '../../../application/services/VideoOrchestrator.js';
import { AuthenticatedRequest } from '../types.js';

export default async function videoAdminRoutes(app: FastifyInstance) {
  // =====================================================
  // Phase 2 Video Generation
  // =====================================================

  /**
   * Trigger Phase 2 video generation for an asset
   */
  app.post('/admin/video/generate-phase2', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Check admin permission
    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const schema = z.object({
      assetKey: z.string().min(1),
      coachId: z.enum(['atlas', 'nova']),
      languages: z.array(z.string()).default(['en']),
      options: z.object({
        musicUri: z.string().optional(),
        transitionType: z.enum(['cut', 'xfade']).default('cut'),
        transitionDuration: z.number().min(0.1).max(1).default(0.3)
      }).optional()
    });

    const body = schema.parse(req.body);

    req.log.info({ assetKey: body.assetKey, coachId: body.coachId }, 'Starting Phase 2 video generation');

    // Run async - don't block the request
    videoOrchestrator.executePhase2({
      assetKey: body.assetKey,
      coachId: body.coachId,
      languages: body.languages,
      options: body.options
    }).then(result => {
      req.log.info({ result }, 'Phase 2 video generation completed');
    }).catch(err => {
      req.log.error({ error: err.message }, 'Phase 2 video generation failed');
    });

    return reply.send({
      success: true,
      message: 'Phase 2 video generation started',
      assetKey: body.assetKey,
      coachId: body.coachId,
      languages: body.languages
    });
  });

  // =====================================================
  // Video Review Queue
  // =====================================================

  /**
   * Get videos pending review
   */
  app.get('/admin/videos/pending-review', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { limit = 50, offset = 0 } = req.query as { limit?: number; offset?: number };

    const result = await pool.query(`
      SELECT
        lv.id,
        lv.parent_id,
        lv.language_code,
        lv.gcs_path,
        lv.youtube_url,
        lv.status,
        lv.verification_status,
        lv.verification_notes,
        lv.review_status,
        lv.review_notes,
        lv.created_at,
        ps.entity_name
      FROM localized_videos lv
      LEFT JOIN pipeline_status ps ON ps.entity_key = lv.parent_id
      WHERE lv.review_status = 'ready_for_review'
      ORDER BY lv.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM localized_videos
      WHERE review_status = 'ready_for_review'
    `);

    return reply.send({
      videos: result.rows,
      total: parseInt(countResult.rows[0].total, 10),
      limit,
      offset
    });
  });

  /**
   * Get all videos for an asset
   */
  app.get('/admin/videos/by-asset/:assetKey', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { assetKey } = req.params as { assetKey: string };

    const result = await pool.query(`
      SELECT
        lv.*,
        ps.entity_name
      FROM localized_videos lv
      LEFT JOIN pipeline_status ps ON ps.entity_key = lv.parent_id
      WHERE lv.parent_id = $1
      ORDER BY lv.language_code
    `, [assetKey]);

    return reply.send({ videos: result.rows });
  });

  /**
   * Approve a video
   */
  app.post('/admin/videos/:id/approve', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { id } = req.params as { id: string };

    await pool.query(`
      UPDATE localized_videos
      SET
        review_status = 'approved',
        reviewed_at = NOW()
      WHERE id = $1
    `, [id]);

    req.log.info({ videoId: id, action: 'approved' }, 'Video approved');

    return reply.send({ success: true, message: 'Video approved' });
  });

  /**
   * Request revision for a video
   */
  app.post('/admin/videos/:id/request-revision', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { id } = req.params as { id: string };
    const { notes } = req.body as { notes?: string };

    await pool.query(`
      UPDATE localized_videos
      SET
        review_status = 'revision_requested',
        review_notes = $2,
        reviewed_at = NOW()
      WHERE id = $1
    `, [id, notes || 'Revision requested']);

    req.log.info({ videoId: id, action: 'revision_requested', notes }, 'Video revision requested');

    return reply.send({ success: true, message: 'Revision requested' });
  });

  /**
   * Bulk approve videos
   */
  app.post('/admin/videos/bulk-approve', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const schema = z.object({
      videoIds: z.array(z.string().uuid()).min(1)
    });

    const { videoIds } = schema.parse(req.body);

    await pool.query(`
      UPDATE localized_videos
      SET
        review_status = 'approved',
        reviewed_at = NOW()
      WHERE id = ANY($1)
    `, [videoIds]);

    req.log.info({ count: videoIds.length, action: 'bulk_approved' }, 'Videos bulk approved');

    return reply.send({ success: true, approvedCount: videoIds.length });
  });

  // =====================================================
  // Video Source Clips Management
  // =====================================================

  /**
   * Get source clips for an asset
   */
  app.get('/admin/videos/source-clips/:parentId', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { parentId } = req.params as { parentId: string };

    const result = await pool.query(`
      SELECT *
      FROM video_source_clips
      WHERE parent_id = $1
      ORDER BY coach_id, step_index NULLS FIRST, shot_type
    `, [parentId]);

    return reply.send({ clips: result.rows });
  });

  /**
   * Regenerate a specific source clip
   */
  app.post('/admin/videos/source-clips/:clipId/regenerate', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { clipId } = req.params as { clipId: string };

    // Mark clip for regeneration by deleting it
    // VeoDirector will regenerate on next ensureScenePack call
    await pool.query(`
      DELETE FROM video_source_clips
      WHERE id = $1
    `, [clipId]);

    req.log.info({ clipId, action: 'marked_for_regeneration' }, 'Clip marked for regeneration');

    return reply.send({ success: true, message: 'Clip will be regenerated on next pipeline run' });
  });

  // =====================================================
  // Video Job Status & Monitoring
  // =====================================================

  /**
   * Get video job status
   */
  app.get('/admin/videos/jobs', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const { status, limit = 50 } = req.query as { status?: string; limit?: number };

    let query = `
      SELECT *
      FROM video_jobs
    `;
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query(query, params);

    return reply.send({ jobs: result.rows });
  });

  /**
   * Get video generation statistics
   */
  app.get('/admin/videos/stats', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    // Admin check - verify user exists (authGuard already validates token)
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Authentication required' });
    }

    const [videoStats, clipStats, reviewStats] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'processing') as processing,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM video_jobs
      `),
      pool.query(`
        SELECT
          COUNT(*) as total_clips,
          COUNT(DISTINCT parent_id) as unique_assets,
          COUNT(*) FILTER (WHERE coach_id = 'atlas') as atlas_clips,
          COUNT(*) FILTER (WHERE coach_id = 'nova') as nova_clips
        FROM video_source_clips
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE review_status = 'ready_for_review') as pending_review,
          COUNT(*) FILTER (WHERE review_status = 'approved') as approved,
          COUNT(*) FILTER (WHERE review_status = 'revision_requested') as revision_requested,
          COUNT(*) FILTER (WHERE verification_status = 'passed') as verification_passed,
          COUNT(*) FILTER (WHERE verification_status = 'failed') as verification_failed
        FROM localized_videos
      `)
    ]);

    return reply.send({
      jobs: videoStats.rows[0],
      clips: clipStats.rows[0],
      review: reviewStats.rows[0]
    });
  });
}
