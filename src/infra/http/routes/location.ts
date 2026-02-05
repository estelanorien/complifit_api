import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import fetch from 'node-fetch';
import { env } from '../../../config/env.js';

// Type mapping for Google Places API
const PLACE_TYPE_MAP: Record<string, string> = {
  gym: 'gym',
  restaurant: 'restaurant',
  cafe: 'cafe',
  supermarket: 'supermarket',
  grocery: 'grocery_or_supermarket',
  park: 'park',
  pharmacy: 'pharmacy',
  hospital: 'hospital',
  health: 'health'
};

interface GooglePlace {
  place_id: string;
  name: string;
  vicinity?: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  rating?: number;
  user_ratings_total?: number;
  opening_hours?: {
    open_now?: boolean;
  };
  types?: string[];
  photos?: Array<{
    photo_reference: string;
    height: number;
    width: number;
  }>;
}

interface GoogleGeocodingResult {
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  place_id: string;
  types: string[];
}

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

      // Check if Google Places API key is configured
      if (!env.googlePlacesKey) {
        req.log.warn({ message: 'Google Places API key not configured' });
        return reply.status(503).send({
          error: 'Location services not configured',
          message: 'Set GOOGLE_PLACES_KEY environment variable'
        });
      }

      // Map user-friendly type to Google Places type
      const googleType = PLACE_TYPE_MAP[type.toLowerCase()] || type;

      // Call Google Places Nearby Search API
      const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
      url.searchParams.set('location', `${lat},${lng}`);
      url.searchParams.set('radius', radius.toString());
      url.searchParams.set('type', googleType);
      url.searchParams.set('key', env.googlePlacesKey);

      const response = await fetch(url.toString());
      const data = await response.json() as {
        status: string;
        results: GooglePlace[];
        error_message?: string;
      };

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        req.log.error({
          error: 'Google Places API error',
          status: data.status,
          message: data.error_message
        });
        return reply.status(500).send({
          error: 'Location search failed',
          details: data.error_message
        });
      }

      // Transform results to our format
      const places = (data.results || []).map((place: GooglePlace) => ({
        id: place.place_id,
        name: place.name,
        address: place.vicinity,
        location: {
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng
        },
        rating: place.rating,
        reviewCount: place.user_ratings_total,
        isOpen: place.opening_hours?.open_now,
        types: place.types,
        photoReference: place.photos?.[0]?.photo_reference
      }));

      req.log.info({
        message: 'Nearby places found',
        type,
        count: places.length,
        lat,
        lng
      });

      return reply.send(places);
    } catch (e: any) {
      req.log.error({ error: 'nearby-places failed', message: e.message });
      return reply.status(500).send({ error: e.message || 'Find nearby places failed' });
    }
  });

  // Geocode address to coordinates
  app.post('/location/geocode', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      query: z.string().min(1).max(500)
    }).parse(req.body);

    try {
      const { query } = body;

      // Check if Google Places API key is configured
      if (!env.googlePlacesKey) {
        req.log.warn({ message: 'Google Places API key not configured' });
        return reply.status(503).send({
          error: 'Location services not configured',
          message: 'Set GOOGLE_PLACES_KEY environment variable'
        });
      }

      // Call Google Geocoding API
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('address', query);
      url.searchParams.set('key', env.googlePlacesKey);

      const response = await fetch(url.toString());
      const data = await response.json() as {
        status: string;
        results: GoogleGeocodingResult[];
        error_message?: string;
      };

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        req.log.error({
          error: 'Google Geocoding API error',
          status: data.status,
          message: data.error_message
        });
        return reply.status(500).send({
          error: 'Geocoding failed',
          details: data.error_message
        });
      }

      // Transform results
      const results = (data.results || []).map((result: GoogleGeocodingResult) => ({
        address: result.formatted_address,
        location: {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng
        },
        placeId: result.place_id,
        types: result.types
      }));

      req.log.info({
        message: 'Geocoding completed',
        query,
        resultCount: results.length
      });

      return reply.send(results);
    } catch (e: any) {
      req.log.error({ error: 'geocode failed', message: e.message });
      return reply.status(500).send({ error: e.message || 'Geocode failed' });
    }
  });

  // Reverse geocode coordinates to address
  app.post('/location/reverse-geocode', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180)
    }).parse(req.body);

    try {
      const { lat, lng } = body;

      if (!env.googlePlacesKey) {
        return reply.status(503).send({
          error: 'Location services not configured'
        });
      }

      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('latlng', `${lat},${lng}`);
      url.searchParams.set('key', env.googlePlacesKey);

      const response = await fetch(url.toString());
      const data = await response.json() as {
        status: string;
        results: GoogleGeocodingResult[];
        error_message?: string;
      };

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        return reply.status(500).send({
          error: 'Reverse geocoding failed',
          details: data.error_message
        });
      }

      const results = (data.results || []).slice(0, 5).map((result: GoogleGeocodingResult) => ({
        address: result.formatted_address,
        placeId: result.place_id,
        types: result.types
      }));

      return reply.send(results);
    } catch (e: any) {
      req.log.error({ error: 'reverse-geocode failed', message: e.message });
      return reply.status(500).send({ error: e.message || 'Reverse geocode failed' });
    }
  });

  // Get place photo URL
  app.get('/location/photo/:photoReference', { preHandler: authGuard }, async (req, reply) => {
    const params = z.object({
      photoReference: z.string().min(1)
    }).parse(req.params);

    const query = z.object({
      maxWidth: z.string().optional().transform(v => v ? parseInt(v) : 400),
      maxHeight: z.string().optional().transform(v => v ? parseInt(v) : undefined)
    }).parse(req.query);

    if (!env.googlePlacesKey) {
      return reply.status(503).send({ error: 'Location services not configured' });
    }

    // Return the Google Places photo URL
    const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
    url.searchParams.set('photo_reference', params.photoReference);
    url.searchParams.set('maxwidth', query.maxWidth.toString());
    if (query.maxHeight) {
      url.searchParams.set('maxheight', query.maxHeight.toString());
    }
    url.searchParams.set('key', env.googlePlacesKey);

    // Redirect to the photo URL
    return reply.redirect(url.toString());
  });
}

