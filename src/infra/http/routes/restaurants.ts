import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import fetch from 'node-fetch';
import { env } from '../../../config/env';

const restaurantSchema = z.object({
  id: z.string().uuid().optional(),
  placeId: z.string().optional(),
  name: z.string(),
  location: z.record(z.any()),
  tier: z.enum(['partner', 'verified_crowd', 'public']),
  cuisine: z.array(z.string()).default([])
});

const menuItemSchema = z.object({
  id: z.string().uuid().optional(),
  restaurantId: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number().optional(),
  estimatedMacros: z.record(z.any()),
  allergens: z.array(z.string()).default([])
});

export async function restaurantRoutes(app: FastifyInstance) {
  app.get('/restaurants', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query('SELECT * FROM restaurants');
    return rows;
  });

  app.post('/restaurants', { preHandler: authGuard }, async (req, reply) => {
    const body = restaurantSchema.parse(req.body);
    const id = body.id || (await pool.query('SELECT gen_random_uuid() as id')).rows[0].id;
    await pool.query(
      `INSERT INTO restaurants(id, place_id, name, location_data, tier, cuisine, created_at)
       VALUES($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET place_id=EXCLUDED.place_id, name=EXCLUDED.name, location_data=EXCLUDED.location_data, tier=EXCLUDED.tier, cuisine=EXCLUDED.cuisine`,
      [id, body.placeId || null, body.name, body.location, body.tier, body.cuisine]
    );
    return reply.send({ id });
  });

  app.post('/restaurants/menu', { preHandler: authGuard }, async (req, reply) => {
    const items = z.array(menuItemSchema).parse(req.body);
    const queries = items.map(async (item) => {
      const id = item.id || (await pool.query('SELECT gen_random_uuid() as id')).rows[0].id;
      await pool.query(
        `INSERT INTO menu_items(id, restaurant_id, name, description, price, estimated_macros, allergens, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, price=EXCLUDED.price, estimated_macros=EXCLUDED.estimated_macros, allergens=EXCLUDED.allergens`,
        [id, item.restaurantId, item.name, item.description || null, item.price || null, item.estimatedMacros, item.allergens]
      );
    });
    await Promise.all(queries);
    return reply.send({ success: true });
  });

  // Match planned meal to restaurant menu options
  app.post('/restaurants/match-meal', { preHandler: authGuard }, async (req, reply) => {
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });

    const body = z.object({
      targetMeal: z.object({
        name: z.string(),
        calories: z.number(),
        macros: z.record(z.any()).optional()
      }),
      restaurants: z.array(z.object({
        id: z.string(),
        name: z.string(),
        location: z.record(z.any()),
        tier: z.string(),
        cuisine: z.array(z.string()).optional()
      })),
      allergens: z.array(z.string()).default([]),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      // Get menu items for all restaurants
      const restaurantIds = body.restaurants.map(r => r.id);
      const { rows: menuRows } = await pool.query(
        `SELECT restaurant_id, name, description, price, estimated_macros, allergens
         FROM menu_items
         WHERE restaurant_id = ANY($1::uuid[])`,
        [restaurantIds]
      );

      // Group menu items by restaurant
      const menuByRestaurant: Record<string, any[]> = {};
      body.restaurants.forEach(r => { menuByRestaurant[r.id] = []; });
      menuRows.forEach((item: any) => {
        if (menuByRestaurant[item.restaurant_id]) {
          menuByRestaurant[item.restaurant_id].push({
            name: item.name,
            description: item.description,
            price: item.price,
            estimatedMacros: item.estimated_macros,
            allergens: item.allergens || []
          });
        }
      });

      // Build prompt for AI matching
      const restaurantsContext = body.restaurants.map(r => ({
        id: r.id,
        name: r.name,
        menuItems: menuByRestaurant[r.id] || []
      }));

      const prompt = `
      MATCH PLANNED MEAL TO RESTAURANT MENU OPTIONS.
      
      Target Meal:
      - Name: ${body.targetMeal.name}
      - Calories: ${body.targetMeal.calories} kcal
      - Macros: ${JSON.stringify(body.targetMeal.macros || {})}
      
      Available Restaurants and Menus:
      ${JSON.stringify(restaurantsContext, null, 2)}
      
      User Allergens to Avoid: ${body.allergens.join(', ') || 'None'}
      
      Task: For each restaurant, find the BEST matching menu item that:
      1. Matches the target meal's nutritional profile (calories ±100 kcal, similar macros)
      2. Avoids user allergens
      3. Has the highest similarity to the target meal name/type
      
      Return JSON array:
      [
        {
          "restaurant": { "id": "uuid", "name": "string" },
          "bestItem": {
            "name": "string",
            "description": "string",
            "price": number or null,
            "estimatedMacros": { "calories": number, "protein": number, "carbs": number, "fat": number },
            "allergens": ["string"]
          },
          "matchScore": number (0-100, higher = better match),
          "reason": "string (why this is a good match)"
        }
      ]
      
      Sort by matchScore descending. Only include matches with score >= 50.
      Language: ${body.lang}
      `;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${env.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      let matches: any[] = [];

      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        matches = JSON.parse(cleaned);
      } catch (e) {
        req.log.error({ error: 'Failed to parse match response', e, requestId: (req as any).requestId });
        return reply.status(500).send({ error: 'Failed to parse AI response' });
      }

      return reply.send(matches);
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'match-meal failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: isProduction ? 'Meal matching service unavailable' : (e.message || 'Match meal failed') });
    }
  });
  // Google Places Proxy with DB Enrichment
  app.get('/places/nearby', { preHandler: authGuard }, async (req, reply) => {
    const query = z.object({
      lat: z.coerce.number(),
      lng: z.coerce.number(),
      radius: z.coerce.number().default(5), // km
      keyword: z.string().optional()
    }).parse(req.query);

    const radiusMeters = Math.min(query.radius * 1000, 50000);
    const venues: any[] = [];
    const seenPlaceIds = new Set<string>();

    const lat = query.lat;
    const lng = query.lng;

    // 1. Search Local DB (Simple bounding box)
    // 1 degree lat ~ 111km. 1 degree lng ~ 111km * cos(lat)
    const latDelta = (query.radius + 2) / 111;
    const lngDelta = (query.radius + 2) / (111 * Math.cos(lat * (Math.PI / 180)));

    try {
      const { rows: dbRows } = await pool.query(
        `SELECT * FROM restaurants 
             WHERE lat BETWEEN $1 AND $2 
             AND lng BETWEEN $3 AND $4
             LIMIT 50`,
        [lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta]
      );

      dbRows.forEach((r: any) => {
        // Calculate distance roughly to filter precise radius if needed
        // For now, simple box is fine
        venues.push({
          id: r.id,
          placeId: r.google_place_id,
          name: r.name,
          location: {
            address: r.address,
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lng)
          },
          tier: r.tier,
          cuisine: r.cuisine || []
        });
        if (r.google_place_id) seenPlaceIds.add(r.google_place_id);
      });
    } catch (e) {
      req.log.error({ error: 'DB Search failed', e });
      // Continue to Google if DB fails
    }

    // 2. Search Google (if key exists)
    if (env.googlePlacesKey) {
      let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${query.lat},${query.lng}&radius=${radiusMeters}&type=restaurant&key=${env.googlePlacesKey}`;
      if (query.keyword) {
        url += `&keyword=${encodeURIComponent(query.keyword)}`;
      }

      try {
        const googleRes = await fetch(url);
        const data: any = await googleRes.json();

        if (data.status === 'OK' && data.results) {
          const googleVenues = data.results.map((p: any) => ({
            placeId: p.place_id,
            name: p.name,
            address: p.vicinity,
            lat: p.geometry.location.lat,
            lng: p.geometry.location.lng,
            types: p.types || [],
            rating: p.rating
          }));

          // 3. Upsert/Enrich into DB
          const enrichmentQueries = googleVenues.map(async (g: any) => {
            // Update DB if exists, or Insert new
            await pool.query(
              `INSERT INTO restaurants (google_place_id, name, address, lat, lng, cuisine, tier, updated_at)
                      VALUES ($1, $2, $3, $4, $5, $6, 'public', now())
                      ON CONFLICT (google_place_id) 
                      DO UPDATE SET 
                        name = EXCLUDED.name, 
                        address = EXCLUDED.address,
                        lat = EXCLUDED.lat,
                        lng = EXCLUDED.lng,
                        updated_at = now()`,
              [g.placeId, g.name, g.address, g.lat, g.lng, g.types]
            );

            // Add to result if not already from DB
            if (!seenPlaceIds.has(g.placeId)) {
              venues.push({
                id: `google_${g.placeId}`, // temporary ID until next fetch
                placeId: g.placeId,
                name: g.name,
                location: {
                  address: g.address,
                  lat: g.lat,
                  lng: g.lng
                },
                tier: 'public',
                cuisine: g.types,
                rating: g.rating
              });
              seenPlaceIds.add(g.placeId);
            }
          });

          // Run upserts in background (don't block response too long)
          // But usually we want to return fast. 
          // We'll await strict processing for now to ensure consistency, 
          // or Promise.allSettled.
          await Promise.allSettled(enrichmentQueries);
        }
      } catch (e: any) {
        req.log.error({ error: 'Google Search failed', e });
      }
    }

    return reply.send(venues);
  });
}
