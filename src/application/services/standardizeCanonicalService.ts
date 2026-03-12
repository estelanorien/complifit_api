/**
 * Marks duplicate localized exercises as non-canonical so only one English
 * entry per logical exercise appears in admin/API. Requires migration 051.
 */

import { pool } from '../../infra/db/pool.js';
import { canonicalService } from './canonicalService.js';

export interface StandardizeResult {
    markedNonCanonical: number;
    groups: Array<{ canonicalName: string; kept: string; duplicates: string[] }>;
}

export async function standardizeCanonicalExercises(): Promise<StandardizeResult> {
    const client = await pool.connect();
    try {
        const hasColumn = await client.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'training_exercises' AND column_name = 'is_canonical'
        `);
        if (hasColumn.rows.length === 0) {
            throw new Error('Run migration 051_training_exercises_canonical.sql first.');
        }

        const all = await client.query(`
            SELECT id, name, created_at
            FROM training_exercises
            WHERE name IS NOT NULL AND name != ''
            ORDER BY name, created_at
        `);

        const byCanonicalId = new Map<string, Array<{ id: string; name: string; language: string; createdAt: Date }>>();

        const noLlm = process.env.STANDARDIZE_NO_LLM === '1';
        const forceLlm = process.env.STANDARDIZE_FORCE_LLM === '1'; // skip cache, use LLM so cross-language merges
        for (const row of all.rows) {
            const { canonicalId, language } = noLlm
                ? await canonicalService.getCanonicalIdNoLlm(row.name, 'exercise')
                : await canonicalService.getCanonicalId(row.name, 'exercise', forceLlm);
            const list = byCanonicalId.get(canonicalId) ?? [];
            list.push({ id: row.id, name: row.name, language, createdAt: row.created_at });
            byCanonicalId.set(canonicalId, list);
        }

        const toMarkNonCanonical: string[] = [];
        const groups: StandardizeResult['groups'] = [];

        const slugFromName = (name: string) =>
            name.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 0).join('_');

        for (const [canonicalId, list] of byCanonicalId) {
            if (list.length <= 1) continue;
            const slug = canonicalId.replace(/^movement_/, '');
            list.sort((a, b) => {
                const aEn = a.language === 'en' ? 0 : 1;
                const bEn = b.language === 'en' ? 0 : 1;
                if (aEn !== bEn) return aEn - bEn;
                const aMatchesSlug = slugFromName(a.name) === slug ? 0 : 1;
                const bMatchesSlug = slugFromName(b.name) === slug ? 0 : 1;
                if (aMatchesSlug !== bMatchesSlug) return aMatchesSlug - bMatchesSlug;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
            const [keep, ...duplicates] = list;
            for (const d of duplicates) toMarkNonCanonical.push(d.id);
            groups.push({
                canonicalName: keep.name,
                kept: keep.name,
                duplicates: duplicates.map(d => d.name)
            });
        }

        if (toMarkNonCanonical.length > 0) {
            await client.query(
                `UPDATE training_exercises SET is_canonical = false WHERE id = ANY($1::uuid[])`,
                [toMarkNonCanonical]
            );
        }

        return { markedNonCanonical: toMarkNonCanonical.length, groups };
    } finally {
        client.release();
    }
}
