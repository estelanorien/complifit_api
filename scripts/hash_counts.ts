
import { pool } from '../src/infra/db/pool.js';
import crypto from 'crypto';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, value 
            FROM cached_assets 
            WHERE key LIKE 'ex_arnold_press%'
        `);
        const hashes: Record<string, number> = {};

        res.rows.forEach(r => {
            const hash = crypto.createHash('md5').update(r.value).digest('hex');
            hashes[hash] = (hashes[hash] || 0) + 1;
        });

        console.log(JSON.stringify(hashes, null, 2));
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
