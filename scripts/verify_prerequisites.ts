/**
 * Complifit Pre-Batch Verification Script
 * Run: npx tsx scripts/verify_prerequisites.ts
 *
 * Checks all prerequisites before running a generation batch:
 * 1. Database connectivity
 * 2. Coach reference images in DB
 * 3. Migration 043 (failed status constraint)
 * 4. Gemini API key validity
 * 5. YouTube credentials (optional)
 * 6. GCS credentials (optional)
 * 7. FFmpeg availability
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const results: { check: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string }[] = [];

function log(check: string, status: 'PASS' | 'FAIL' | 'WARN', detail: string) {
    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${icon} ${check}: ${detail}`);
    results.push({ check, status, detail });
}

async function main() {
    console.log('\n🔍 COMPLIFIT PRE-BATCH VERIFICATION\n' + '='.repeat(50) + '\n');

    // 1. Check env vars exist
    const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET', 'GEMINI_API_KEY'];
    for (const envVar of requiredEnvVars) {
        if (process.env[envVar]) {
            log(`ENV ${envVar}`, 'PASS', `Set (${process.env[envVar]!.substring(0, 8)}...)`);
        } else {
            log(`ENV ${envVar}`, 'FAIL', 'NOT SET');
        }
    }

    // 2. Database connectivity
    const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000
    });

    try {
        await pool.query('SELECT 1');
        log('Database Connection', 'PASS', 'Connected successfully');

        // 3. Coach reference images in DB
        const coachRes = await pool.query(
            "SELECT key, length(value) as value_len, status FROM cached_assets WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref')"
        );

        const foundKeys = coachRes.rows.map((r: any) => r.key);

        if (foundKeys.includes('system_coach_atlas_ref')) {
            const atlas = coachRes.rows.find((r: any) => r.key === 'system_coach_atlas_ref');
            log('Coach Atlas Ref Image', 'PASS', `In DB (${Math.round(atlas.value_len / 1024)}KB, status: ${atlas.status})`);
        } else {
            log('Coach Atlas Ref Image', 'FAIL', 'NOT in database. Run: npx tsx scripts/seed_coaches.ts');
        }

        if (foundKeys.includes('system_coach_nova_ref')) {
            const nova = coachRes.rows.find((r: any) => r.key === 'system_coach_nova_ref');
            log('Coach Nova Ref Image', 'PASS', `In DB (${Math.round(nova.value_len / 1024)}KB, status: ${nova.status})`);
        } else {
            log('Coach Nova Ref Image', 'FAIL', 'NOT in database. Run: npx tsx scripts/seed_coaches.ts');
        }

        // 4. Check constraint includes 'failed'
        const constraintRes = await pool.query(
            "SELECT pg_get_constraintdef(oid) as def FROM pg_constraint WHERE conname = 'cached_assets_status_check'"
        );

        if (constraintRes.rows.length > 0) {
            const def = constraintRes.rows[0].def;
            if (def.includes("'failed'")) {
                log('Migration 043 (failed status)', 'PASS', `Constraint includes 'failed'`);
            } else {
                log('Migration 043 (failed status)', 'FAIL', `Constraint missing 'failed'. Run migration 043_fix_cached_assets_status.sql`);
            }
        } else {
            log('Migration 043 (failed status)', 'WARN', 'No status constraint found (may be unconstrained)');
        }

        // 5. Check migrations table
        const migTableRes = await pool.query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '_migrations'"
        );

        if (migTableRes.rows.length > 0) {
            const migCountRes = await pool.query("SELECT count(*) as cnt FROM _migrations");
            log('Migrations Table', 'PASS', `${migCountRes.rows[0].cnt} migrations applied`);
        } else {
            log('Migrations Table', 'WARN', 'No _migrations tracking table found');
        }

        // 6. Check key tables exist
        const tablesRes = await pool.query(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
            AND tablename IN ('cached_assets', 'asset_blob_storage', 'cached_asset_meta',
                              'video_jobs', 'video_source_clips', 'localized_videos',
                              'content_translations', 'translation_jobs', 'generation_jobs',
                              'pipeline_status', 'dead_letter_queue')
            ORDER BY tablename
        `);

        const foundTables = tablesRes.rows.map((r: any) => r.tablename);
        const requiredTables = [
            'cached_assets', 'asset_blob_storage', 'cached_asset_meta',
            'video_jobs', 'video_source_clips', 'localized_videos',
            'content_translations', 'translation_jobs', 'generation_jobs',
            'pipeline_status', 'dead_letter_queue'
        ];

        const missingTables = requiredTables.filter(t => !foundTables.includes(t));
        if (missingTables.length === 0) {
            log('Required Tables', 'PASS', `All ${requiredTables.length} tables present`);
        } else {
            log('Required Tables', 'FAIL', `Missing: ${missingTables.join(', ')}`);
        }

    } catch (e: any) {
        log('Database Connection', 'FAIL', e.message);
    } finally {
        await pool.end();
    }

    // 7. Gemini API key test
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
        );
        if (res.ok) {
            const data = await res.json() as any;
            const modelCount = data.models?.length || 0;
            log('Gemini API Key', 'PASS', `Valid (${modelCount} models available)`);
        } else {
            const err = await res.text();
            log('Gemini API Key', 'FAIL', `HTTP ${res.status}: ${err.substring(0, 100)}`);
        }
    } catch (e: any) {
        log('Gemini API Key', 'FAIL', e.message);
    }

    // 8. YouTube credentials
    const ytVars = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'];
    const ytSet = ytVars.filter(v => process.env[v]);
    if (ytSet.length === 3) {
        log('YouTube Credentials', 'PASS', 'All 3 YouTube env vars set');
    } else if (ytSet.length === 0) {
        log('YouTube Credentials', 'WARN', 'Not configured — videos will skip YouTube upload');
    } else {
        log('YouTube Credentials', 'FAIL', `Only ${ytSet.length}/3 set: missing ${ytVars.filter(v => !process.env[v]).join(', ')}`);
    }

    // 9. GCS credentials
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        if (fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
            log('GCS Credentials', 'PASS', `Service account file found at ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
        } else {
            log('GCS Credentials', 'FAIL', `File not found: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
        }
    } else {
        log('GCS Credentials', 'WARN', 'GOOGLE_APPLICATION_CREDENTIALS not set — will use default credentials (may work on Cloud Run)');
    }

    // 10. FFmpeg
    try {
        const ffmpegVersion = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
        log('FFmpeg', 'PASS', ffmpegVersion);
    } catch {
        log('FFmpeg', 'FAIL', 'FFmpeg not found in PATH');
    }

    try {
        const ffprobeVersion = execSync('ffprobe -version 2>&1').toString().split('\n')[0];
        log('FFprobe', 'PASS', ffprobeVersion);
    } catch {
        log('FFprobe', 'FAIL', 'FFprobe not found in PATH');
    }

    // 11. Coach image files on disk
    const atlasPath = path.resolve(__dirname, '..', 'src', 'assets', 'coach_atlas_ref.png');
    const novaPath = path.resolve(__dirname, '..', 'src', 'assets', 'coach_nova_ref.png');

    if (fs.existsSync(atlasPath)) {
        const size = fs.statSync(atlasPath).size;
        log('Atlas Image File', 'PASS', `${Math.round(size / 1024)}KB at ${atlasPath}`);
    } else {
        log('Atlas Image File', 'FAIL', `Not found at ${atlasPath}`);
    }

    if (fs.existsSync(novaPath)) {
        const size = fs.statSync(novaPath).size;
        log('Nova Image File', 'PASS', `${Math.round(size / 1024)}KB at ${novaPath}`);
    } else {
        log('Nova Image File', 'FAIL', `Not found at ${novaPath}`);
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    const fails = results.filter(r => r.status === 'FAIL');
    const warns = results.filter(r => r.status === 'WARN');
    const passes = results.filter(r => r.status === 'PASS');

    console.log(`\n📊 RESULTS: ${passes.length} passed, ${warns.length} warnings, ${fails.length} failed\n`);

    if (fails.length > 0) {
        console.log('❌ BLOCKERS (must fix before batch):');
        fails.forEach(f => console.log(`   - ${f.check}: ${f.detail}`));
    }

    if (warns.length > 0) {
        console.log('\n⚠️  WARNINGS (optional but recommended):');
        warns.forEach(w => console.log(`   - ${w.check}: ${w.detail}`));
    }

    if (fails.length === 0) {
        console.log('\n🚀 ALL CLEAR — Ready to run a test batch!');
    } else {
        console.log('\n🛑 FIX BLOCKERS BEFORE PROCEEDING');
    }

    console.log('');
}

main().catch(console.error);
