import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import fetch from 'node-fetch';
import { env } from '../../../config/env';

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
      
      // Placeholder: Return empty array for now
      // TODO: Integrate with Google Places API or OpenStreetMap Nominatim
      return reply.send([]);
    } catch (e: any) {
      req.log.error({ error: 'nearby-places failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Find nearby places failed' });
    }
  });

  // Geocode address to coordinates
  app.post('/location/geocode', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      query: z.string().min(1)
    }).parse(req.body);

    try {
      const { query } = body;
      
      // Use Google Geocoding API if available
      // For now, return empty array
      // TODO: Integrate with Google Geocoding API or OpenStreetMap Nominatim
      
      // Placeholder implementation
      return reply.send([]);
    } catch (e: any) {
      req.log.error({ error: 'geocode failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Geocode failed' });
    }
  });
}

