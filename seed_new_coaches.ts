import pg from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new pg.Pool({
    connectionString: 'postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db',
    ssl: { rejectUnauthorized: false }
});

const IMAGES_DIR = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9';

async function seedCoaches() {
    console.log('[Seeder] Starting coach reference image seeding...');

    const coaches = [
        { key: 'system_coach_atlas_ref', file: 'atlas_reference_1768949958480.png' },
        { key: 'system_coach_nova_ref', file: 'nova_reference_1768949970441.png' }
    ];

    for (const coach of coaches) {
        const filePath = path.join(IMAGES_DIR, coach.file);

        if (!fs.existsSync(filePath)) {
            console.error(`[Seeder] File not found: ${filePath}`);
            continue;
        }

        const imageData = fs.readFileSync(filePath);
        const base64 = `data:image/png;base64,${imageData.toString('base64')}`;

        console.log(`[Seeder] Uploading ${coach.key} (${Math.round(base64.length / 1024)}KB)...`);

        await pool.query(`
            INSERT INTO cached_assets(key, value, asset_type, status)
            VALUES($1, $2, 'image', 'active')
            ON CONFLICT (key) DO UPDATE SET 
                value = EXCLUDED.value, 
                status = 'active',
                updated_at = NOW()
        `, [coach.key, base64]);

        console.log(`[Seeder] ✅ ${coach.key} seeded successfully`);
    }

    await pool.end();
    console.log('[Seeder] Done!');
}

seedCoaches().catch(e => {
    console.error('[Seeder] Error:', e);
    process.exit(1);
});
