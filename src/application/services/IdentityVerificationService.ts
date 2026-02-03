/**
 * IdentityVerificationService - Verify generated images match Atlas/Nova reference
 *
 * Uses Gemini Vision to compare generated images against coach reference images.
 * Checks for:
 * - Hair presence (not bald)
 * - Hair color match (blonde for both coaches)
 * - Gender match
 * - Outfit consistency
 * - Athletic shoes presence
 */

import fetch from 'node-fetch';
import { aiConfig } from '../../config/ai.js';
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface VerificationResult {
    matches: boolean;
    confidence: number;           // 0.0 - 1.0
    issues: string[];             // Detected issues
    details: {
        hairPresent: boolean;
        hairColorMatch: boolean;
        genderMatch: boolean;
        outfitMatch: boolean;
        shoesVisible: boolean;
    };
    shouldRetry: boolean;         // Whether regeneration is recommended
}

export interface CoachProfile {
    persona: 'atlas' | 'nova';
    gender: 'male' | 'female';
    hairColor: string;
    hairStyle: string;
    outfit: string;
    outfitColors: string[];
}

// ============================================================================
// Coach Profiles
// ============================================================================

const COACH_PROFILES: Record<string, CoachProfile> = {
    atlas: {
        persona: 'atlas',
        gender: 'male',
        hairColor: 'golden-blonde, dark blonde, light brownish-gold',
        hairStyle: 'short hair, buzz cut',
        outfit: 'grey athletic t-shirt, black athletic shorts',
        outfitColors: ['grey', 'gray', 'black']
    },
    nova: {
        persona: 'nova',
        gender: 'female',
        hairColor: 'platinum blonde, golden blonde, light blonde',
        hairStyle: 'long hair in high ponytail',
        outfit: 'emerald green sports bra, black athletic leggings',
        outfitColors: ['green', 'emerald', 'black']
    }
};

// ============================================================================
// Verification Prompt
// ============================================================================

const VERIFICATION_PROMPT = `You are an identity verification expert. Analyze the TWO images provided:

IMAGE 1 (First): This is the REFERENCE image - the canonical appearance of the person.
IMAGE 2 (Second): This is the GENERATED image - should show the SAME person performing an exercise.

Compare the generated image against the reference and evaluate:

1. HAIR PRESENCE (Critical): Is the person in the generated image bald? The reference has hair, so the generated image MUST also have hair.
2. HAIR COLOR: Does the hair color in the generated image match the reference? (Both should be blonde/golden shades, NOT black, NOT dark brown)
3. GENDER: Does the gender match? (Male should stay male, Female should stay female)
4. OUTFIT: Is the person wearing similar athletic clothing? (Approximate match is fine, colors should be similar)
5. ATHLETIC SHOES: Are athletic shoes/sneakers visible in the generated image?

Return your analysis as JSON only (no markdown, no code blocks):
{
    "matches": true/false,
    "confidence": 0.0-1.0,
    "issues": ["list of detected problems, empty if matches"],
    "details": {
        "hairPresent": true/false,
        "hairColorMatch": true/false,
        "genderMatch": true/false,
        "outfitMatch": true/false,
        "shoesVisible": true/false
    },
    "reasoning": "brief explanation"
}

CRITICAL FAILURES that MUST result in matches=false:
- Bald head when reference has hair
- Black hair when reference has blonde hair
- Wrong gender
- Multiple people in image when reference shows one person

ACCEPTABLE VARIATIONS (do NOT fail for these):
- Slightly different shade of outfit color
- Different angle or pose
- Background differences`;

// ============================================================================
// IdentityVerificationService Class
// ============================================================================

export class IdentityVerificationService {
    private static instance: IdentityVerificationService;
    private readonly apiKey: string;
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

    private constructor() {
        this.apiKey = aiConfig.geminiApiKey;
        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is required for identity verification');
        }
    }

    static getInstance(): IdentityVerificationService {
        if (!IdentityVerificationService.instance) {
            IdentityVerificationService.instance = new IdentityVerificationService();
        }
        return IdentityVerificationService.instance;
    }

    // ------------------------------------------------------------------------
    // Main Verification Method
    // ------------------------------------------------------------------------

    /**
     * Verify a generated image matches the coach reference
     */
    async verify(
        generatedImage: string,    // base64 data URI or raw base64
        referenceImage: string,    // base64 data URI or raw base64
        persona: 'atlas' | 'nova',
        assetKey?: string
    ): Promise<VerificationResult> {
        const profile = COACH_PROFILES[persona];
        if (!profile) {
            throw new Error(`Unknown persona: ${persona}`);
        }

        try {
            // Normalize base64 data
            const refBase64 = this.normalizeBase64(referenceImage);
            const genBase64 = this.normalizeBase64(generatedImage);

            // Call Gemini Vision with both images
            const response = await this.callGeminiVision(refBase64, genBase64, profile);

            // Parse and validate response
            const result = this.parseVerificationResponse(response, profile);

            // Log verification result
            await this.logVerification(assetKey || 'unknown', persona, result, genBase64);

            return result;
        } catch (error: any) {
            logger.error(`[IdentityVerification] Verification failed for ${persona}: ${error.message}`);

            // Return cautious result on error - allow retry but don't block
            return {
                matches: false,
                confidence: 0,
                issues: [`Verification failed: ${error.message}`],
                details: {
                    hairPresent: true,  // Assume true to not block unnecessarily
                    hairColorMatch: true,
                    genderMatch: true,
                    outfitMatch: true,
                    shoesVisible: true
                },
                shouldRetry: true
            };
        }
    }

    /**
     * Verify using stored reference image
     */
    async verifyWithStoredReference(
        generatedImage: string,
        persona: 'atlas' | 'nova',
        assetKey?: string
    ): Promise<VerificationResult> {
        const referenceKey = persona === 'atlas' ? 'system_coach_atlas_ref' : 'system_coach_nova_ref';

        const refAsset = await AssetRepository.findByKey(referenceKey);
        if (!refAsset) {
            logger.warn(`[IdentityVerification] Reference image not found: ${referenceKey}`);
            return {
                matches: true, // Can't verify, assume OK
                confidence: 0,
                issues: ['Reference image not found, verification skipped'],
                details: {
                    hairPresent: true,
                    hairColorMatch: true,
                    genderMatch: true,
                    outfitMatch: true,
                    shoesVisible: true
                },
                shouldRetry: false
            };
        }

        // Get reference as base64
        let refBase64: string;
        if (refAsset.buffer && refAsset.buffer.length > 0) {
            refBase64 = refAsset.buffer.toString('base64');
        } else if (refAsset.value) {
            refBase64 = this.normalizeBase64(refAsset.value);
        } else {
            logger.warn(`[IdentityVerification] Reference image has no data: ${referenceKey}`);
            return {
                matches: true,
                confidence: 0,
                issues: ['Reference image has no data, verification skipped'],
                details: {
                    hairPresent: true,
                    hairColorMatch: true,
                    genderMatch: true,
                    outfitMatch: true,
                    shoesVisible: true
                },
                shouldRetry: false
            };
        }

        return this.verify(generatedImage, refBase64, persona, assetKey);
    }

    // ------------------------------------------------------------------------
    // Private Methods
    // ------------------------------------------------------------------------

    /**
     * Call Gemini Vision API with two images
     */
    private async callGeminiVision(
        referenceBase64: string,
        generatedBase64: string,
        profile: CoachProfile
    ): Promise<string> {
        const model = 'models/gemini-2.0-flash';

        // Build parts: reference image, generated image, then prompt
        const parts: any[] = [
            // Reference image (first)
            {
                inlineData: {
                    mimeType: 'image/png',
                    data: referenceBase64
                }
            },
            // Generated image (second)
            {
                inlineData: {
                    mimeType: 'image/png',
                    data: generatedBase64
                }
            },
            // Verification prompt
            {
                text: `${VERIFICATION_PROMPT}

EXPECTED COACH PROFILE:
- Persona: ${profile.persona}
- Gender: ${profile.gender}
- Hair Color: ${profile.hairColor}
- Hair Style: ${profile.hairStyle}
- Expected Outfit: ${profile.outfit}

Analyze the images and return JSON only.`
            }
        ];

        const response = await fetch(`${this.baseUrl}/${model}:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.apiKey
            },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    temperature: 0.1,
                    topP: 1,
                    maxOutputTokens: 1024
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error: ${response.status} ${errorText}`);
        }

        const data = await response.json() as any;
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        if (!text) {
            throw new Error('Empty response from Gemini Vision');
        }

        return text;
    }

    /**
     * Parse Gemini response into VerificationResult
     */
    private parseVerificationResponse(response: string, profile: CoachProfile): VerificationResult {
        try {
            // Clean up response - remove markdown code blocks if present
            let cleaned = response.trim();
            if (cleaned.startsWith('```json')) {
                cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            } else if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
            }

            const parsed = JSON.parse(cleaned);

            const result: VerificationResult = {
                matches: Boolean(parsed.matches),
                confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
                issues: Array.isArray(parsed.issues) ? parsed.issues : [],
                details: {
                    hairPresent: Boolean(parsed.details?.hairPresent ?? true),
                    hairColorMatch: Boolean(parsed.details?.hairColorMatch ?? true),
                    genderMatch: Boolean(parsed.details?.genderMatch ?? true),
                    outfitMatch: Boolean(parsed.details?.outfitMatch ?? true),
                    shoesVisible: Boolean(parsed.details?.shoesVisible ?? true)
                },
                shouldRetry: false
            };

            // Determine if retry is recommended
            // Critical failures should trigger retry
            if (!result.details.hairPresent) {
                result.shouldRetry = true;
                if (!result.issues.includes('bald head detected')) {
                    result.issues.push('bald head detected');
                }
            }
            if (!result.details.hairColorMatch) {
                result.shouldRetry = true;
            }
            if (!result.details.genderMatch) {
                result.shouldRetry = true;
            }

            // Low confidence should also trigger retry
            if (result.confidence < 0.6 && !result.matches) {
                result.shouldRetry = true;
            }

            return result;
        } catch (error: any) {
            logger.error(`[IdentityVerification] Failed to parse response: ${error.message}`);
            logger.debug(`[IdentityVerification] Raw response: ${response.substring(0, 500)}`);

            // Return conservative result
            return {
                matches: false,
                confidence: 0,
                issues: ['Failed to parse verification response'],
                details: {
                    hairPresent: true,
                    hairColorMatch: true,
                    genderMatch: true,
                    outfitMatch: true,
                    shoesVisible: true
                },
                shouldRetry: true
            };
        }
    }

    /**
     * Normalize base64 string (remove data URI prefix if present)
     */
    private normalizeBase64(data: string): string {
        if (data.startsWith('data:image')) {
            return data.replace(/^data:image\/\w+;base64,/, '');
        }
        return data;
    }

    /**
     * Log verification result to database
     */
    private async logVerification(
        assetKey: string,
        persona: string,
        result: VerificationResult,
        generatedImageBase64: string
    ): Promise<void> {
        try {
            // Calculate hash of generated image for debugging
            const imageHash = crypto.createHash('md5').update(generatedImageBase64.substring(0, 10000)).digest('hex');

            await pool.query(
                `INSERT INTO identity_verification_log (
                    asset_key, persona, reference_key, matches, confidence, issues, generated_image_hash
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    assetKey,
                    persona,
                    persona === 'atlas' ? 'system_coach_atlas_ref' : 'system_coach_nova_ref',
                    result.matches,
                    result.confidence,
                    JSON.stringify(result.issues),
                    imageHash
                ]
            );

            logger.info(`[IdentityVerification] Logged verification for ${assetKey}: matches=${result.matches}, confidence=${result.confidence}`);
        } catch (error: any) {
            // Don't fail if logging fails
            logger.warn(`[IdentityVerification] Failed to log verification: ${error.message}`);
        }
    }

    // ------------------------------------------------------------------------
    // Statistics
    // ------------------------------------------------------------------------

    /**
     * Get verification statistics
     */
    async getStats(days: number = 7): Promise<{
        total: number;
        passed: number;
        failed: number;
        passRate: number;
        byPersona: Record<string, { passed: number; failed: number }>;
        commonIssues: Array<{ issue: string; count: number }>;
    }> {
        const result = await pool.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE matches = true) as passed,
                COUNT(*) FILTER (WHERE matches = false) as failed
            FROM identity_verification_log
            WHERE verified_at > NOW() - INTERVAL '${days} days'
        `);

        const byPersonaResult = await pool.query(`
            SELECT
                persona,
                COUNT(*) FILTER (WHERE matches = true) as passed,
                COUNT(*) FILTER (WHERE matches = false) as failed
            FROM identity_verification_log
            WHERE verified_at > NOW() - INTERVAL '${days} days'
            GROUP BY persona
        `);

        const byPersona: Record<string, { passed: number; failed: number }> = {};
        for (const row of byPersonaResult.rows) {
            byPersona[row.persona] = {
                passed: parseInt(row.passed, 10),
                failed: parseInt(row.failed, 10)
            };
        }

        // Get common issues from failed verifications
        const issuesResult = await pool.query(`
            SELECT issues
            FROM identity_verification_log
            WHERE matches = false AND verified_at > NOW() - INTERVAL '${days} days'
        `);

        const issueCounts: Record<string, number> = {};
        for (const row of issuesResult.rows) {
            const issues = Array.isArray(row.issues) ? row.issues : [];
            for (const issue of issues) {
                issueCounts[issue] = (issueCounts[issue] || 0) + 1;
            }
        }

        const commonIssues = Object.entries(issueCounts)
            .map(([issue, count]) => ({ issue, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const total = parseInt(result.rows[0].total, 10);
        const passed = parseInt(result.rows[0].passed, 10);

        return {
            total,
            passed,
            failed: parseInt(result.rows[0].failed, 10),
            passRate: total > 0 ? passed / total : 0,
            byPersona,
            commonIssues
        };
    }
}

// Export singleton instance
export const identityVerificationService = IdentityVerificationService.getInstance();
