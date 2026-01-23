import { pool } from '../src/infra/db/pool.js';

async function main() {
    const movementId = '00e0b1ec-8fa4-4528-97b7-58019d281480';
    
    console.log('📊 Checking generated assets for Bird Dog exercise...\n');
    
    // Check all assets
    const assets = await pool.query(`
        SELECT 
            a.key, 
            a.asset_type, 
            a.status,
            CASE 
                WHEN a.asset_type = 'image' THEN COALESCE(LENGTH(b.data::text), LENGTH(a.value))
                ELSE LENGTH(a.value)
            END as size
        FROM cached_assets a
        LEFT JOIN asset_blob_storage b ON a.key = b.key
        WHERE a.key LIKE $1
        ORDER BY a.key
    `, [`ex_${movementId}%`]);
    
    console.log(`Found ${assets.rows.length} assets:\n`);
    for (const row of assets.rows) {
        const sizeKB = Math.round(parseInt(row.size || '0') / 1024);
        console.log(`  ${row.asset_type.padEnd(6)} | ${row.status.padEnd(10)} | ${sizeKB.toString().padStart(6)} KB | ${row.key}`);
    }
    
    // Check meta content
    const meta = await pool.query(`
        SELECT value 
        FROM cached_assets 
        WHERE key = $1 AND asset_type = 'json'
    `, [`ex_${movementId}_meta`]);
    
    if (meta.rows.length > 0) {
        try {
            const content = JSON.parse(meta.rows[0].value);
            console.log('\n📝 Text Content Structure:');
            console.log(`   Description: ${content.description ? '✓' : '✗'}`);
            console.log(`   Instructions: ${content.instructions?.length || 0}`);
            console.log(`   Safety Warnings: ${content.safety_warnings?.length || 0}`);
            console.log(`   Pro Tips: ${content.pro_tips?.length || 0}`);
            console.log(`   Common Mistakes: ${content.common_mistakes?.length || 0}`);
        } catch (e) {
            console.log('\n⚠️  Meta content exists but couldn\'t parse JSON');
        }
    }
    
    // Check reference images
    console.log('\n🖼️  Reference Images Status:');
    const atlasRef = await pool.query(`SELECT key, CASE WHEN b.data IS NOT NULL THEN LENGTH(b.data::text) ELSE 0 END as size FROM cached_assets a LEFT JOIN asset_blob_storage b ON a.key = b.key WHERE a.key = 'system_coach_atlas_ref'`);
    const novaRef = await pool.query(`SELECT key, CASE WHEN b.data IS NOT NULL THEN LENGTH(b.data::text) ELSE 0 END as size FROM cached_assets a LEFT JOIN asset_blob_storage b ON a.key = b.key WHERE a.key = 'system_coach_nova_ref'`);
    
    console.log(`   Atlas Ref: ${atlasRef.rows.length > 0 ? 'EXISTS' : 'MISSING'} ${atlasRef.rows[0]?.size > 0 ? `(${Math.round(parseInt(atlasRef.rows[0].size) / 1024)} KB)` : '(NO BUFFER DATA)'}`);
    console.log(`   Nova Ref: ${novaRef.rows.length > 0 ? 'EXISTS' : 'MISSING'} ${novaRef.rows[0]?.size > 0 ? `(${Math.round(parseInt(novaRef.rows[0].size) / 1024)} KB)` : '(NO BUFFER DATA)'}`);
    
    // Check translations
    const translations = await pool.query(`
        SELECT COUNT(*) as count
        FROM translation_jobs
        WHERE asset_key = $1
    `, [`ex_${movementId}_meta`]);
    
    console.log(`\n🌍 Translation Jobs: ${translations.rows[0]?.count || 0}`);
    
    await pool.end();
}

main().catch(console.error);
