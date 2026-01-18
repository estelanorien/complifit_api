require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function check() {
    try {
        console.log('Checking cached_asset_meta for recent entries...');
        const res = await pool.query(`
            SELECT * FROM cached_asset_meta 
            ORDER BY created_at DESC 
            LIMIT 20
        `);
        console.log(`Found ${res.rows.length} recent assets.`);
        res.rows.forEach(r => {
            console.log(`[${r.created_at}] Key: ${r.key}, Source: ${r.source}, MovID: ${r.movement_id}`);
        });

        console.log('\nChecking specifically for "nohut" or "bulgur"...');
        const res2 = await pool.query(`
            SELECT * FROM cached_asset_meta 
            WHERE key ILIKE '%nohut%' OR key ILIKE '%bulgur%' OR movement_id ILIKE '%nohut%'
            ORDER BY created_at DESC
        `);
        console.log(`Found ${res2.rows.length} matches for nohut/bulgur.`);
        res2.rows.forEach(r => {
            console.log(`[${r.created_at}] Key: ${r.key}, Type: ${r.asset_type}, Subtype: ${r.subtype}`);
        });

    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

check();
