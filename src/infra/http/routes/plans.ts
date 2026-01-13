import { FastifyInstance } from 'fastify';
import { planArchiveRoutes } from './planArchives.js';
import { planActionsRoutes } from './planActions.js';

/**
 * Plans routes entry point. 
 * Coordinates archival management and generation/action logic.
 */
export async function plansRoutes(app: FastifyInstance) {
  // Register plan archives sub-routes
  await app.register(planArchiveRoutes);

  // Register plan actions (generate, reroll, save) sub-routes
  await app.register(planActionsRoutes);
}
