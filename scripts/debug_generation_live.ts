
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const GROUP_NAME = "Agility Cones with Ball";

function normalizeToId(name: string): string {
    if (!name) return 'unknown';
    let clean = name.toLowerCase().trim();
    clean = clean.replace(/[^a-z0-9]+/g, ' ');
    // REPLICATE THE FIX: NO SORT
    const words = clean.split(' ').filter(w => w.length > 0);
    const key = words.join('_');
    return key;
}


const LOG_FILE = path.resolve(__dirname, 'debug_output.txt');
function log(msg: string) {
    fs.appendFileSync(LOG_FILE, msg + '\n');
    console.log(msg);
}

async function testGemini() {
    log("TS: Testing Gemini API (GenerateContent with 2.5-flash)...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        log("TS: ❌ GEMINI_API_KEY Missing");
        return;
    }
    const model = 'gemini-2.5-flash'; // UPDATED MODEL
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Hello" }] }]
            })
        });
        const data = await resp.json();
        if (data.candidates && data.candidates.length > 0) {
            log("TS: ✅ Gemini API Success (2.5-flash)");
        } else {
            log(`TS: ❌ Gemini API Failed Response: ${JSON.stringify(data)}`);
        }
    } catch (e) {
        log(`TS: ❌ Gemini API Exception: ${e}`);
    }
}

async function check() {
    fs.writeFileSync(LOG_FILE, "--- START DEBUG ---\n");
    const client = await pool.connect();
    try {
        // 1. Check Reference Assets
        const resAtlas = await client.query("SELECT key, length(value) as len FROM cached_assets WHERE key='system_coach_atlas_ref'");
        if (resAtlas.rows.length === 0) log("TS: Atlas Ref: MISSING");
        else log(`TS: Atlas Ref: FOUND (Size: ${resAtlas.rows[0].len})`);

        // 2. Check Target Asset Key (Unsorted)
        const movementId = normalizeToId(GROUP_NAME);
        const targetKey = `ex_${movementId}_atlas_main`;
        log(`TS: Target Key: ${targetKey}`);

        const resTarget = await client.query("SELECT key, status, updated_at FROM cached_assets WHERE key=$1", [targetKey]);
        if (resTarget.rows.length === 0) {
            log("TS: Target Asset: NOT FOUND (404 Confirmed)");
        } else {
            log(`TS: Target Asset: FOUND (${resTarget.rows[0].status})`);
        }

        // 3. Check SORTED (Bad) Key
        const sortedWords = GROUP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 0).sort();
        const sortedKey = `ex_${sortedWords.join('_')}_atlas_main`;
        log(`TS: Bad Key: ${sortedKey}`);
        const resBad = await client.query("SELECT key, status FROM cached_assets WHERE key=$1", [sortedKey]);
        if (resBad.rows.length > 0) {
            log(`TS: Bad Sorted Key: FOUND (${JSON.stringify(resBad.rows[0])})`);
        } else {
            log("TS: Bad Sorted Key: NOT FOUND");
        }

        // 4. Test Gemini
        await testGemini();

    } catch (e) {
        log(`TS: DEBUG ERROR: ${e}`);
    } finally {
        client.release();
        await pool.end();
        log("--- END DEBUG ---");
    }
}

check();
