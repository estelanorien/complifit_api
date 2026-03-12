
import { pool } from '../src/infra/db/pool.js';
import crypto from 'crypto';
import fs from 'fs';

async function main() {
    try {
        const res = await pool.query("SELECT key, value FROM cached_assets WHERE key LIKE 'ex_arnold_press_%' AND asset_type = 'image'");
        let output = `Analyzing ${res.rows.length} images\n`;

        const hashes: Record<string, string[]> = {};

        for (const r of res.rows) {
            const hash = crypto.createHash('md5').update(r.value).digest('hex');
            if (!hashes[hash]) hashes[hash] = [];
            hashes[hash].push(r.key);
        }

        for (const [hash, keys] of Object.entries(hashes)) {
            output += `Hash ${hash} (${keys.length} assets):\n`;
            for (const k of keys) {
                output += `  - ${k}\n`;
            }
        }
        fs.writeFileSync('scripts/hashes_results.txt', output);
        console.log("Results in scripts/hashes_results.txt");
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
