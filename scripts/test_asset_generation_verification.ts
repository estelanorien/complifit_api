/**
 * Comprehensive Asset Generation Verification Test
 * 
 * This script:
 * 1. Picks a test exercise/meal that doesn't have assets
 * 2. Generates all required assets (text, images, translations)
 * 3. Verifies all requirements are met
 * 4. Shows detailed results
 */

import { pool } from '../src/infra/db/pool.js';
import { AssetRepository } from '../src/infra/db/repositories/AssetRepository.js';
import { AssetPromptService } from '../src/application/services/assetPromptService.js';
import { AiService } from '../src/application/services/aiService.js';
import { translationService } from '../src/application/services/translationService.js';

const aiService = new AiService();

// Test exercise name - using a simple one that likely doesn't exist
const TEST_EXERCISE = "Test Plank Hold";
const TEST_MEAL = "Test Greek Salad";

interface VerificationResult {
    assetType: string;
    key: string;
    exists: boolean;
    hasContent: boolean;
    contentSize?: number;
    status?: string;
    details?: any;
}

async function findEmptyAsset(): Promise<{ type: 'exercise' | 'meal', name: string, movementId: string }> {
    console.log('🔍 Finding an empty asset to test...\n');

    // Check for exercises without assets
    const exCheck = await pool.query(`
        SELECT e.id::text as id, e.name, 
               COUNT(a.key) as asset_count
        FROM training_exercises e
        LEFT JOIN cached_asset_meta m ON m.movement_id = e.id::text
        LEFT JOIN cached_assets a ON a.key = m.key
        WHERE e.name IS NOT NULL
        GROUP BY e.id, e.name
        HAVING COUNT(a.key) = 0
        LIMIT 1
    `);

    if (exCheck.rows.length > 0) {
        const ex = exCheck.rows[0];
        console.log(`✅ Found empty exercise: "${ex.name}" (ID: ${ex.id})\n`);
        return { type: 'exercise', name: ex.name, movementId: ex.id };
    }

    // Check for meals without assets
    const mealCheck = await pool.query(`
        SELECT m.id::text as id, m.name,
               COUNT(a.key) as asset_count
        FROM meals m
        LEFT JOIN cached_asset_meta meta ON meta.movement_id = m.id::text
        LEFT JOIN cached_assets a ON a.key = meta.key
        WHERE m.name IS NOT NULL
        GROUP BY m.id, m.name
        HAVING COUNT(a.key) = 0
        LIMIT 1
    `);

    if (mealCheck.rows.length > 0) {
        const meal = mealCheck.rows[0];
        console.log(`✅ Found empty meal: "${meal.name}" (ID: ${meal.id})\n`);
        return { type: 'meal', name: meal.name, movementId: meal.id };
    }

    // If nothing found, use test names
    console.log(`⚠️  No empty assets found. Using test names: "${TEST_EXERCISE}" or "${TEST_MEAL}"\n`);
    return { type: 'exercise', name: TEST_EXERCISE, movementId: 'test_plank_hold' };
}

async function generateTextContent(name: string, type: 'exercise' | 'meal'): Promise<any> {
    console.log(`📝 Generating text content for ${type}: "${name}"...`);
    
    let instructions;
    try {
        instructions = await AssetPromptService.generateInstructions(name, type);
    } catch (e: any) {
        console.error(`   ⚠️  Text generation failed: ${e.message}`);
        // Return minimal structure if generation fails
        instructions = {
            description: `${name} - ${type}`,
            instructions: [],
            ...(type === 'exercise' ? {
                safety_warnings: [],
                pro_tips: [],
                common_mistakes: []
            } : {
                nutrition_science: '',
                prep_tips: [],
                allergens: []
            })
        };
    }
    
    console.log(`✅ Text content generated:`);
    console.log(`   - Description: ${instructions.description ? '✓' : '✗'}`);
    console.log(`   - Instructions count: ${instructions.instructions?.length || 0}`);
    console.log(`   - Has simple instructions: ${instructions.instructions?.[0]?.simple ? '✓' : '✗'}`);
    console.log(`   - Has detailed instructions: ${instructions.instructions?.[0]?.detailed ? '✓' : '✗'}`);
    
    if (type === 'exercise') {
        console.log(`   - Safety warnings: ${instructions.safety_warnings?.length || 0}`);
        console.log(`   - Pro tips: ${instructions.pro_tips?.length || 0}`);
        console.log(`   - Common mistakes: ${instructions.common_mistakes?.length || 0}`);
    } else {
        console.log(`   - Nutrition science: ${instructions.nutrition_science ? '✓' : '✗'}`);
        console.log(`   - Prep tips: ${instructions.prep_tips?.length || 0}`);
        console.log(`   - Allergens: ${instructions.allergens?.length || 0}`);
    }
    console.log('');
    
    return instructions;
}

async function generateMainImage(name: string, type: 'exercise' | 'meal', movementId: string, coach?: 'atlas' | 'nova'): Promise<string | null> {
    const baseKey = type === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;
    const imageKey = coach ? `${baseKey}_${coach}_main` : `${baseKey}_main`;
    
    console.log(`🖼️  Generating main image: ${imageKey}...`);
    
    try {
        const { prompt, referenceImage, referenceType } = await AssetPromptService.constructPrompt({
            key: imageKey,
            groupName: name,
            groupType: type,
            subtype: 'main',
            type: 'image'
        });

        console.log(`   - Prompt length: ${prompt.length}`);
        console.log(`   - Has reference image: ${referenceImage ? '✓' : '✗'}`);
        console.log(`   - Reference type: ${referenceType}`);

        const result = await aiService.generateImage({
            prompt,
            referenceImage,
            referenceType,
            model: 'models/gemini-2.5-flash-image'
        });

        if (result.base64) {
            // Save to database
            await AssetRepository.save(imageKey, {
                value: result.base64,
                buffer: Buffer.from(result.base64.replace(/^data:image\/\w+;base64,/, ""), 'base64'),
                status: 'active',
                type: 'image',
                metadata: { prompt, source: 'test_verification', movementId }
            });
            console.log(`   ✅ Image saved: ${imageKey}\n`);
            return result.base64;
        }
    } catch (e: any) {
        console.error(`   ❌ Failed: ${e.message}\n`);
    }
    return null;
}

async function generateStepImage(name: string, type: 'exercise' | 'meal', movementId: string, stepIndex: number, instruction: string, coach?: 'atlas' | 'nova'): Promise<string | null> {
    const baseKey = type === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;
    const stepKey = coach ? `${baseKey}_${coach}_step_${stepIndex}` : `${baseKey}_step_${stepIndex}`;
    
    try {
        const { prompt, referenceImage } = await AssetPromptService.constructPrompt({
            key: stepKey,
            groupName: name,
            groupType: type,
            subtype: 'step',
            label: instruction,
            type: 'image',
            context: instruction
        });

        const result = await aiService.generateImage({
            prompt,
            referenceImage,
            referenceType: 'identity',
            model: 'models/gemini-2.5-flash-image'
        });

        if (result.base64) {
            await AssetRepository.save(stepKey, {
                value: result.base64,
                buffer: Buffer.from(result.base64.replace(/^data:image\/\w+;base64,/, ""), 'base64'),
                status: 'active',
                type: 'image',
                metadata: { prompt, source: 'test_verification', movementId, step: stepIndex }
            });
            return result.base64;
        }
    } catch (e: any) {
        console.error(`   ❌ Step ${stepIndex} failed: ${e.message}`);
    }
    return null;
}

async function verifyRequirements(name: string, type: 'exercise' | 'meal', movementId: string): Promise<VerificationResult[]> {
    console.log(`\n🔍 Verifying all requirements for ${type}: "${name}"...\n`);
    
    const results: VerificationResult[] = [];
    const baseKey = type === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;

    // 1. Check text content (JSON meta)
    const metaKey = `${baseKey}_meta`;
    const metaAsset = await AssetRepository.findByKey(metaKey);
    results.push({
        assetType: 'text_content',
        key: metaKey,
        exists: !!metaAsset,
        hasContent: !!metaAsset?.value && metaAsset.value.length > 100,
        contentSize: metaAsset?.value?.length,
        status: metaAsset?.status,
        details: metaAsset ? JSON.parse(metaAsset.value) : null
    });

    // 2. Check main images
    if (type === 'exercise') {
        // Check Atlas main
        const atlasMain = await AssetRepository.findByKey(`${baseKey}_atlas_main`);
        results.push({
            assetType: 'main_image_atlas',
            key: `${baseKey}_atlas_main`,
            exists: !!atlasMain,
            hasContent: !!atlasMain?.buffer && atlasMain.buffer.length > 1000,
            contentSize: atlasMain?.buffer?.length,
            status: atlasMain?.status
        });

        // Check Nova main
        const novaMain = await AssetRepository.findByKey(`${baseKey}_nova_main`);
        results.push({
            assetType: 'main_image_nova',
            key: `${baseKey}_nova_main`,
            exists: !!novaMain,
            hasContent: !!novaMain?.buffer && novaMain.buffer.length > 1000,
            contentSize: novaMain?.buffer?.length,
            status: novaMain?.status
        });
    } else {
        // Check meal main
        const mealMain = await AssetRepository.findByKey(`${baseKey}_main`);
        results.push({
            assetType: 'main_image',
            key: `${baseKey}_main`,
            exists: !!mealMain,
            hasContent: !!mealMain?.buffer && mealMain.buffer.length > 1000,
            contentSize: mealMain?.buffer?.length,
            status: mealMain?.status
        });
    }

    // 3. Check step images (if we have instructions)
    if (metaAsset) {
        try {
            const content = JSON.parse(metaAsset.value);
            const instructions = content.instructions || [];
            
            for (let i = 0; i < Math.min(instructions.length, 5); i++) {
                if (type === 'exercise') {
                    // Check Atlas step
                    const atlasStep = await AssetRepository.findByKey(`${baseKey}_atlas_step_${i + 1}`);
                    results.push({
                        assetType: 'step_image_atlas',
                        key: `${baseKey}_atlas_step_${i + 1}`,
                        exists: !!atlasStep,
                        hasContent: !!atlasStep?.buffer && atlasStep.buffer.length > 1000,
                        contentSize: atlasStep?.buffer?.length,
                        status: atlasStep?.status
                    });

                    // Check Nova step
                    const novaStep = await AssetRepository.findByKey(`${baseKey}_nova_step_${i + 1}`);
                    results.push({
                        assetType: 'step_image_nova',
                        key: `${baseKey}_nova_step_${i + 1}`,
                        exists: !!novaStep,
                        hasContent: !!novaStep?.buffer && novaStep.buffer.length > 1000,
                        contentSize: novaStep?.buffer?.length,
                        status: novaStep?.status
                    });
                } else {
                    // Check meal step
                    const mealStep = await AssetRepository.findByKey(`${baseKey}_step_${i}`);
                    results.push({
                        assetType: 'step_image',
                        key: `${baseKey}_step_${i}`,
                        exists: !!mealStep,
                        hasContent: !!mealStep?.buffer && mealStep.buffer.length > 1000,
                        contentSize: mealStep?.buffer?.length,
                        status: mealStep?.status
                    });
                }
            }
        } catch (e) {
            console.error('Failed to parse meta content:', e);
        }
    }

    // 4. Check translations (simplified - check if translation jobs exist)
    const translationJobCheck = await pool.query(`
        SELECT COUNT(*) as count
        FROM translation_jobs
        WHERE asset_key = $1
    `, [metaKey]);

    results.push({
        assetType: 'translations',
        key: 'translation_jobs',
        exists: true,
        hasContent: parseInt(translationJobCheck.rows[0]?.count || '0') > 0,
        contentSize: parseInt(translationJobCheck.rows[0]?.count || '0'),
        details: { translationJobCount: translationJobCheck.rows[0]?.count }
    });

    return results;
}

async function main() {
    console.log('='.repeat(60));
    console.log('🧪 ASSET GENERATION VERIFICATION TEST');
    console.log('='.repeat(60));
    console.log('');

    try {
        // Step 1: Find empty asset
        const asset = await findEmptyAsset();
        const { type, name, movementId } = asset;

        // Step 2: Generate text content
        const textContent = await generateTextContent(name, type);
        
        // Save text content
        const baseKey = type === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;
        const metaKey = `${baseKey}_meta`;
        await AssetRepository.save(metaKey, {
            value: JSON.stringify(textContent),
            status: 'active',
            type: 'json',
            metadata: { source: 'test_verification', movementId }
        });

        // Step 3: Generate main images
        if (type === 'exercise') {
            console.log('🏋️  Generating exercise images (Atlas + Nova)...\n');
            await generateMainImage(name, type, movementId, 'atlas');
            await generateMainImage(name, type, movementId, 'nova');
        } else {
            console.log('🍽️  Generating meal image...\n');
            await generateMainImage(name, type, movementId);
        }

        // Step 4: Generate step images
        if (textContent.instructions && textContent.instructions.length > 0) {
            console.log(`📸 Generating step images (${Math.min(textContent.instructions.length, 3)} steps)...\n`);
            
            for (let i = 0; i < Math.min(textContent.instructions.length, 3); i++) {
                const instruction = textContent.instructions[i];
                const instructionText = instruction.detailed || instruction.simple || instruction.label || '';
                
                if (!instructionText) {
                    console.log(`   ⚠️  Skipping step ${i + 1} - no instruction text`);
                    continue;
                }
                
                try {
                    if (type === 'exercise') {
                        await generateStepImage(name, type, movementId, i + 1, instructionText, 'atlas');
                        await generateStepImage(name, type, movementId, i + 1, instructionText, 'nova');
                    } else {
                        await generateStepImage(name, type, movementId, i, instructionText);
                    }
                } catch (e: any) {
                    console.error(`   ❌ Step ${i + 1} generation failed: ${e.message}`);
                }
            }
        } else {
            console.log('⚠️  No instructions available for step image generation\n');
        }

        // Step 5: Trigger translations
        console.log('🌍 Triggering translations...\n');
        try {
            await translationService.publishAndTranslate(movementId, name, type);
            console.log('✅ Translation jobs enqueued\n');
        } catch (e: any) {
            console.error(`⚠️  Translation trigger failed: ${e.message}\n`);
        }

        // Step 6: Verify all requirements
        const verificationResults = await verifyRequirements(name, type, movementId);

        // Step 7: Display results
        console.log('='.repeat(60));
        console.log('📊 VERIFICATION RESULTS');
        console.log('='.repeat(60));
        console.log('');

        let allPassed = true;
        for (const result of verificationResults) {
            const status = result.exists && result.hasContent ? '✅' : '❌';
            console.log(`${status} ${result.assetType}: ${result.key}`);
            console.log(`   Exists: ${result.exists ? 'Yes' : 'No'}`);
            console.log(`   Has Content: ${result.hasContent ? 'Yes' : 'No'}`);
            if (result.contentSize) {
                console.log(`   Size: ${result.contentSize} bytes`);
            }
            if (result.status) {
                console.log(`   Status: ${result.status}`);
            }
            if (result.details && result.assetType === 'text_content') {
                const details = result.details;
                console.log(`   Instructions: ${details.instructions?.length || 0}`);
                if (type === 'exercise') {
                    console.log(`   Safety Warnings: ${details.safety_warnings?.length || 0}`);
                    console.log(`   Pro Tips: ${details.pro_tips?.length || 0}`);
                } else {
                    console.log(`   Nutrition Science: ${details.nutrition_science ? 'Yes' : 'No'}`);
                    console.log(`   Prep Tips: ${details.prep_tips?.length || 0}`);
                }
            }
            console.log('');

            if (!result.exists || !result.hasContent) {
                allPassed = false;
            }
        }

        console.log('='.repeat(60));
        if (allPassed) {
            console.log('✅ ALL REQUIREMENTS MET!');
        } else {
            console.log('⚠️  SOME REQUIREMENTS MISSING');
        }
        console.log('='.repeat(60));

    } catch (e: any) {
        console.error('❌ Test failed:', e.message);
        console.error(e.stack);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

main();
