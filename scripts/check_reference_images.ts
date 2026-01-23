import { pool } from '../src/infra/db/pool.js';

async function main() {
    console.log('🔍 Checking Reference Images...\n');
    
    const res = await pool.query(`
        SELECT 
            a.key, 
            a.asset_type, 
            a.status,
            CASE WHEN LENGTH(a.value) > 0 THEN LENGTH(a.value) ELSE 0 END as value_size,
            CASE WHEN b.data IS NOT NULL THEN LENGTH(b.data::text) ELSE 0 END as buffer_size
        FROM cached_assets a
        LEFT JOIN asset_blob_storage b ON a.key = b.key
        WHERE a.key IN ('system_coach_atlas_ref', 'system_coach_nova_ref')
    `);
    
    console.log('Reference Images Status:');
    for (const row of res.rows) {
        const valueKB = Math.round(parseInt(row.value_size || '0') / 1024);
        const bufferKB = Math.round(parseInt(row.buffer_size || '0') / 1024);
        console.log(`\n${row.key}:`);
        console.log(`  Status: ${row.status}`);
        console.log(`  Value size: ${valueKB} KB`);
        console.log(`  Buffer size: ${bufferKB} KB`);
        console.log(`  Has data: ${(valueKB > 0 || bufferKB > 0) ? 'YES' : 'NO'}`);
    }
    
    // Check generated assets
    console.log('\n\n📊 Checking Generated Assets for Bird Dog...\n');
    const assets = await pool.query(`
        SELECT 
            a.key, 
            a.asset_type, 
            a.status,
            CASE WHEN LENGTH(a.value) > 0 THEN LENGTH(a.value) ELSE 0 END as value_size,
            CASE WHEN b.data IS NOT NULL THEN LENGTH(b.data::text) ELSE 0 END as buffer_size
        FROM cached_assets a
        LEFT JOIN asset_blob_storage b ON a.key = b.key
        WHERE a.key LIKE 'ex_00e0b1ec-8fa4-4528-97b7-58019d281480%'
        ORDER BY a.key
    `);
    
    console.log(`Found ${assets.rows.length} assets:\n`);
    for (const row of assets.rows) {
        const valueKB = Math.round(parseInt(row.value_size || '0') / 1024);
        const bufferKB = Math.round(parseInt(row.buffer_size || '0') / 1024);
        const totalKB = valueKB + bufferKB;
        console.log(`  ${row.asset_type.padEnd(6)} | ${row.status.padEnd(10)} | ${totalKB.toString().padStart(6)} KB | ${row.key}`);
    }
    
    await pool.end();
}

main().catch(console.error);
