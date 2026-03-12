
import { pool } from '../src/infra/db/pool.js';
import fs from 'fs';

let output = '';
function log(msg: string) {
    output += msg + '\n';
    console.log(msg);
}

async function simulate(key: string) {
    log(`\n--- Simulating fetch for: [${key}] ---`);
    const decodedKey = key;

    let { rows } = await pool.query(
        `SELECT value, asset_type, status FROM cached_assets WHERE key=$1 LIMIT 1`,
        [decodedKey]
    );

    if (rows.length === 0) {
        log("RESULT: NOT FOUND IN DB -> Smart Discovery would trigger");
        return;
    }

    let { value, asset_type, status } = rows[0];
    log(`DB STATUS: ${status}, TYPE: ${asset_type}, VALUE LEN: ${value?.length || 0}`);

    if (asset_type === 'image' && (status === 'active' || status === 'auto' || status === 'generating')) {
        const groupMetaKey = decodedKey
            .replace(/_(atlas|nova|mannequin)_(main|step_\d+|video_.*)$/, '_meta')
            .replace(/_(main|step_\d+|video_.*)$/, '_meta');
        log(`Looking for Meta: ${groupMetaKey}`);

        const metaRes = await pool.query(`SELECT value FROM cached_assets WHERE key=$1 LIMIT 1`, [groupMetaKey]);
        if (metaRes.rows.length > 0) {
            log("META FOUND");
        } else {
            log("META NOT FOUND");
        }
    }
}

async function main() {
    await simulate('ex_arnold_press_atlas_step_1');
    await simulate('ex_arnold_press_atlas_step_5');
    fs.writeFileSync('scripts/simulation_results.txt', output);
    process.exit(0);
}
main();
