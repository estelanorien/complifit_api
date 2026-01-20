
import { pool } from '../src/infra/db/pool.js';
import fs from 'fs';

async function main() {
    try {
        const res = await pool.query("SELECT key, status, length(key) as klen, length(value) as vlen FROM cached_assets WHERE key LIKE '%arnold_press%' ORDER BY key");
        let output = `Found ${res.rows.length} assets\n`;
        for (const r of res.rows) {
            output += `KEY:[${r.key}] LEN:${r.klen} STATUS:[${r.status}] VLEN:${r.vlen}\n`;
        }
        fs.writeFileSync('scripts/arnold_extreme_check.txt', output);
        console.log("Done");
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
