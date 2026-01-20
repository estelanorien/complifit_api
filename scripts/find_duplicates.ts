
import { pool } from '../src/infra/db/pool.js';
import crypto from 'crypto';
import fs from 'fs';

async function main() {
    try {
        const res = await pool.query("SELECT key, value FROM cached_assets WHERE key LIKE '%arnold_press%' AND asset_type = 'image'");
        const hashes: Record<string, string[]> = {};

        for (const r of res.rows) {
            const hash = crypto.createHash('md5').update(r.value).digest('hex');
            if (!hashes[hash]) hashes[hash] = [];
            hashes[hash].push(r.key);
        }

        let output = `Total Arnold Press Images: ${res.rows.length}\n`;
        output += `Unique Hashes: ${Object.keys(hashes).length}\n\n`;

        for (const [hash, keys] of Object.entries(hashes)) {
            if (keys.length > 1) {
                output += `DUPLICATES [${hash}]:\n  - ${keys.join('\n  - ')}\n\n`;
            } else {
                output += `UNIQUE [${hash}]: ${keys[0]}\n`;
            }
        }

        fs.writeFileSync('scripts/duplicate_audit.txt', output);
        console.log("Audit complete. See scripts/duplicate_audit.txt");
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
