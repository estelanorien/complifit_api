
import { pool } from '../src/infra/db/pool.js';
import { AiService } from '../src/application/services/aiService.js';
import { SystemBlueprints } from '../src/types.js'; // Ensure generic types are available if needed or use any

const ai = new AiService();

async function main() {
    try {
        console.log("Starting Equipment Enrichment...");
        let processed = 0;

        while (true) {
            // Batch Select
            const res = await pool.query(`
                SELECT id, name 
                FROM training_exercises 
                WHERE equipment IS NULL 
                   OR equipment = '{}'
                   OR array_length(equipment, 1) IS NULL
                LIMIT 20
            `);

            if (res.rows.length === 0) {
                console.log("All exercises enriched!");
                break;
            }

            const batch = res.rows;
            console.log(`Processing batch of ${batch.length}...`);

            // Construct Prompt
            const list = batch.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
            const prompt = `
Analyze the following fitness exercises and identify the PRIMARY equipment required for each. 
Return a JSON object where the key is the exact Exercise Name provided, and the value is an ARRAY of strings listing the equipment.
If Bodyweight, return ["Bodyweight"].
If Dumbbell, return ["Dumbbell"].
If Barbell, return ["Barbell"].
If Machine, return ["Machine"].
If Cable, return ["Cable"].
If Band, return ["Resistance Band"].
Keep it generic (e.g. "Dumbbell" not "50lb Dumbbell").

Exercises:
${list}

Return ONLY VALID JSON. No markdown formatting.
            `;

            try {
                const { text } = await ai.generateText({
                    prompt,
                    model: 'models/gemini-3-flash-preview',
                    generationConfig: { responseMimeType: "application/json" }
                });

                const cleanJson = text.replace(/```json|```/g, '').trim();
                const mapping = JSON.parse(cleanJson);

                // Bulk Update
                for (const row of batch) {
                    const eq = mapping[row.name];
                    if (Array.isArray(eq)) {
                        // Standardize casing
                        const cleanEq = eq.map((e: string) => e.trim());
                        await pool.query(
                            `UPDATE training_exercises SET equipment = $1 WHERE id = $2`,
                            [cleanEq, row.id]
                        );
                        console.log(`Updated ${row.name}: [${cleanEq.join(', ')}]`);
                    } else {
                        console.warn(`Failed to parse equipment for ${row.name}, setting to Bodyweight default.`);
                        await pool.query(
                            `UPDATE training_exercises SET equipment = $1 WHERE id = $2`,
                            [['Bodyweight'], row.id]
                        );
                    }
                }

                processed += batch.length;
                console.log(`Total Processed: ${processed}`);

            } catch (err: any) {
                console.error("Batch AI Error:", err.message);
                // Fail-safe: Skip this batch to avoid infinite loop by marking them as 'Unknown' temporarily?
                // Or just wait and retry. For now, let's mark them as Bodyweight to progress.
                console.warn("Marking batch as Bodyweight to proceed...");
                for (const row of batch) {
                    await pool.query(
                        `UPDATE training_exercises SET equipment = $1 WHERE id = $2`,
                        [['Bodyweight'], row.id]
                    );
                }
            }

            // Rate Limit Buffer
            await new Promise(r => setTimeout(r, 1000));
        }

    } catch (e: any) {
        console.error("Critial Error:", e.message);
    }
    process.exit(0);
}
main();
