import { Pool } from 'pg';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;

async function enrich() {
    if (!GOOGLE_KEY) {
        console.error("No GOOGLE_PLACES_KEY found in .env");
        process.exit(1);
    }

    console.log("Connecting to DB...");
    try {
        const { rows } = await pool.query(`
            SELECT id, name, address, lat, lng 
            FROM restaurants 
            WHERE google_place_id IS NULL 
            LIMIT 50
        `);

        console.log(`Found ${rows.length} restaurants to enrich.`);

        let processed = 0;
        let matched = 0;

        for (const r of rows) {
            processed++;
            console.log(`[${processed}/${rows.length}] Searching for: ${r.name}...`);

            try {
                let url = '';
                if (r.lat && r.lng) {
                    // Nearby search (more precise if we trust lat/lng)
                    url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${r.lat},${r.lng}&radius=500&keyword=${encodeURIComponent(r.name)}&key=${GOOGLE_KEY}`;
                } else {
                    // Text Search fallback
                    url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(r.name + ' ' + (r.address || ''))}&key=${GOOGLE_KEY}`;
                }

                const res = await fetch(url);
                const data: any = await res.json();

                if (data.status === 'OK' && data.results && data.results.length > 0) {
                    const match = data.results[0]; // Take best match
                    console.log(`   MATCH FOUND: ${match.name} (${match.place_id})`);

                    await pool.query(`
                        UPDATE restaurants 
                        SET google_place_id = $1,
                            lat = COALESCE(lat, $2),
                            lng = COALESCE(lng, $3),
                            address = COALESCE(address, $4),
                            updated_at = now()
                        WHERE id = $5
                    `, [match.place_id, match.geometry.location.lat, match.geometry.location.lng, match.vicinity || match.formatted_address, r.id]);

                    matched++;
                } else {
                    console.log(`   No match found (Status: ${data.status})`);
                }

                // Rate limit sleep (avoid 429)
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (e) {
                console.error(`   Error processing ${r.name}`, e);
            }
        }

        console.log(`\nDone! Processed: ${processed}, Matched: ${matched}`);
    } catch (e) {
        console.error("Fatal error:", e);
    } finally {
        await pool.end();
    }
}

enrich();
