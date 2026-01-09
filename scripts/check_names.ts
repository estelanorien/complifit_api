
import { resolve } from 'dns/promises';
import * as fs from 'fs';


// Generator
const prefixes = [
    "Bio", "Vytal", "Vital", "Neuro", "Soma", "Cell", "Core", "Iron", "Shredd", "Power", "Flux", "Omni", "Apex", "Nova",
    "Vigil", "Aegis", "Guard", "Secure", "Safe", "True", "Pure", "Prime", "Zen", "Flow", "Sync", "Pulse", "Node", "Grid",
    "Link", "Mesh", "Chain", "Warp", "Shift", "Morph", "Evolve", "Adapt", "Glp", "Metab", "Keto", "Paleo", "Lean", "Mass"
];
const suffixes = [
    "Fit", "AI", "OS", "Lab", "Hub", "App", "Sys", "Bot", "Gen", "X", "Pro", "Max", "Plus", "One", "Zero",
    "Node", "Core", "Base", "Zone", "Flow", "Sync", "Pulse", "Guard", "Shield", "Safe", "Lock", "Key", "Works", "Box", "Deck"
];

const generateCandidates = () => {
    const list: string[] = [];
    // Direct Combinations
    prefixes.forEach(p => {
        suffixes.forEach(s => {
            if (p !== s) list.push(`${p}${s}`);
        });
    });
    // Add some "ly" or "ify"
    prefixes.forEach(p => {
        list.push(`${p}ify`);
        list.push(`${p}ly`);
        list.push(`${p}ize`);
    });
    return list;
};

const candidates = generateCandidates();


const tlds = ['.com', '.app', '.io', '.ai'];

async function checkDomain(name: string): Promise<{ name: string, available: boolean, domain: string }> {
    // Check .com primarily, maybe .ai
    const domain = `${name.toLowerCase()}.com`;
    try {
        await resolve(domain);
        return { name, available: false, domain };
    } catch (e: any) {
        if (e.code === 'ENOTFOUND' || e.code === 'NXDOMAIN') {
            return { name, available: true, domain };
        }
        return { name, available: false, domain }; // Other errors assume unavailable or broken
    }
}

async function run() {
    console.log(`Checking ${candidates.length} candidates...`);
    const results = [];

    // Process in batches of 10 to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const promises = batch.map(name => checkDomain(name));
        const batchResults = await Promise.all(promises);
        results.push(...batchResults);
        process.stdout.write('.');
    }

    console.log('\nDone.');
    const available = results.filter(r => r.available);
    console.log(`Found ${available.length} potentially available .com domains.`);

    fs.writeFileSync('available_names.json', JSON.stringify(available, null, 2));
}

run();
