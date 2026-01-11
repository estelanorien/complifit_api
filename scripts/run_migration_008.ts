import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars from the API project
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase URL or Key in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runMigration() {
    console.log('Running Migration 008: Add FCM Token...');
    const migrationPath = path.resolve(__dirname, '../migrations/008_add_fcm_token.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    const { error } = await supabase.rpc('exec_sql', { sql_query: sql });

    // Fallback if exec_sql RPC doesn't exist (using raw query if using service role, or just log error)
    if (error) {
        console.error('Migration Failed via RPC:', error.message);
        console.log('Attempting direct SQL execution is not supported via JS client solely without proper RPC setup for DDL.');
        console.log('Please run the contents of 008_add_fcm_token.sql in your Supabase SQL Editor.');
    } else {
        console.log('Migration 008 Applied Successfully!');
    }
}

runMigration().catch(console.error);
