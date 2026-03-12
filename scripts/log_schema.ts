
import { pool } from '../src/infra/db/pool.js';
import fs from 'fs';

async function main() {
    try {
        const res = await pool.query(`
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name IN ('training_exercises', 'meals', 'cached_assets', 'cached_asset_meta')
            ORDER BY table_name, ordinal_position
        `);
        const output = res.rows.map(r => `${r.table_name}.${r.column_name} (${r.data_type})`).join('\n');
        fs.writeFileSync('scripts/schema.txt', output);
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
