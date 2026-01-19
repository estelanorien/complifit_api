
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

const GROUP_NAME = "25m Sprint 25m Slow"; // EXACT FAILING GROUP

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

async function testGemini(client: pg.PoolClient) {
    log("TS: Testing Alternate Models for Geo-Block Bypass...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        log("TS: ❌ GEMINI_API_KEY Missing");
        return;
    }

    // 1. Fetch Atlas Ref
    const resRef = await client.query("SELECT value FROM cached_assets WHERE key='system_coach_atlas_ref'");
    if (resRef.rows.length === 0) {
        log("TS: ❌ Cannot test Image Gen: Atlas Ref Missing");
        return;
    }
    const atlasRefBase64 = resRef.rows[0].value;
    const cleanBase64 = atlasRefBase64.replace(/^data:image\/\w+;base64,/, "");

    const candidates = ['gemini-2.5-flash-image', 'gemini-2.0-flash', 'gemini-1.5-pro'];

    for (const model of candidates) {
        log(`\nTS: Testing Model: ${model} ...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const parts: any[] = [];
        parts.push({ inlineData: { mimeType: "image/png", data: cleanBase64 } });
        parts.push({ text: "Portrait of Coach Atlas. High quality fitness photography." });

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: {
                        responseModalities: ['IMAGE']
                    }
                })
            });

            if (!resp.ok) {
                const errText = await resp.text();
                log(`TS: ❌ ${model} Failed: ${resp.status} ${errText}`);
                continue;
            }

            const data = await resp.json();
            const resParts = data?.candidates?.[0]?.content?.parts || [];
            const inline = resParts.find((p: any) => p.inlineData?.data);

            if (inline?.inlineData?.data) {
                log(`TS: ✅ ${model} SUCCESS! (Received Image)`);
                return; // Stop on first success
            } else {
                log(`TS: ❌ ${model} Failed (No Image Data): ${JSON.stringify(data)}`);
            }
        } catch (e) {
            log(`TS: ❌ ${model} Exception: ${e}`);
        }
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

        // 3. Check for the "Bad" sorted key
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
        await testGemini(client);

    } catch (e) {
        log(`TS: DEBUG ERROR: ${e}`);
    } finally {
        client.release();
        await pool.end();
        log("--- END DEBUG ---");
    }
}

check();
