/**
 * Mark duplicate localized exercises as non-canonical so only one English entry
 * per logical exercise appears in admin/API. Run after migration 051.
 *
 * Usage: npx tsx scripts/standardize_exercises_canonical.ts
 */

import { standardizeCanonicalExercises } from '../src/application/services/standardizeCanonicalService.js';

async function main() {
    try {
        const result = await standardizeCanonicalExercises();
        for (const g of result.groups) {
            console.log(`Canonical: "${g.kept}"; non-canonical: ${g.duplicates.map(d => `"${d}"`).join(', ')}`);
        }
        console.log(`Marked ${result.markedNonCanonical} exercise(s) as non-canonical.`);
    } catch (e: any) {
        console.error(e.message || e);
        process.exit(1);
    }
    process.exit(0);
}

main();
