import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import fetch from 'node-fetch';
import { env } from '../../../config/env.js';

export async function locationRoutes(app: FastifyInstance) {
  // Find nearby places (gyms, restaurants, etc.)
  app.post('/location/nearby-places', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      type: z.string().default('gym'),
      radius: z.number().min(100).max(50000).default(5000) // meters
    }).parse(req.body);

    try {
      const { lat, lng, type, radius } = body;
      
      // Use Google Places API if available, otherwise return empty
      // For now, we'll use a simple geocoding approach or return mock data
      // In production, integrate with Google Places API or similar service
      
      // Location service not yet integrated - return 501 to indicate feature is planned
      return reply.status(501).send({ error: 'Nearby places feature coming soon', places: [] });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'nearby-places failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Find nearby places failed' });
    }
  });

  // Geocode address to coordinates
  app.post('/location/geocode', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      query: z.string().min(1)
    }).parse(req.body);

    try {
      const { query } = body;
      
      // Geocoding service not yet integrated - return 501 to indicate feature is planned
      return reply.status(501).send({ error: 'Geocoding feature coming soon', results: [] });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'geocode failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Geocode failed' });
    }
  });
}

