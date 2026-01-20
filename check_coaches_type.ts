import pg from 'pg';
const pool = new pg.Pool({
    connectionString: 'postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db',
    ssl: { rejectUnauthorized: false }
});

async function check() {
    // Check the asset_type of coach refs
    const result = await pool.query(`
        SELECT key, 
               length(value) as len, 
               status,
               asset_type
        FROM cached_assets 
        WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref');
    `);
    console.log("COACHES:");
    for (const row of result.rows) {
        console.log(`  ${row.key}: len=${row.len}, status=${row.status}, type=${row.asset_type}`);
    }
    await pool.end();
}

check();
