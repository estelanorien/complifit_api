
import { resolve } from 'dns/promises';
import * as fs from 'fs';

// Abstract / Neologism Generator
const roots = [
    "Vyt", "Vel", "Nov", "Alt", "Pri", "Syn", "Dyn", "Kin", "Met", "Sol", "Lun", "Aer", "Zen", "Kai", "Ryu",
    "Kyn", "Zyn", "Xen", "Vex", "Nex", "Om", "Arc", "Orb", "Qui", "Ax", "Ex", "Ion", "Aura", "Flux",
    "Juno", "Luma", "Mira", "Sola", "Vesa", "Zera", "Nym", "Pry", "Qubit", "Thrive", "Zest", "Prism"
];
const endings = [
    "os", "us", "ix", "ex", "on", "a", "io", "ia", "ra", "za", "ly", "fy", "sys", "net", "hub", "lab", "box", "base", "flow", "sync",
    "gen", "bot", "app", "pro", "max", "plus", "core", "zone", "shield", "guard", "safe", "lock", "key", "works", "deck", "mind", "brain", "pulse", "ware", "soft", "tech", "logic", "sense", "scout", "bridge"
];

// Combine
const candidates: string[] = [];

// 2-Syllable Combinations
roots.forEach(r => endings.forEach(e => {
    candidates.push(`${r}${e}`);
}));

// Portmanteaus / Compounds
const compounds = [
    "Kynex", "Vytrex", "Dynos", "Metrix", "Solara", "Lunex", "Aeris", "Zenon", "Kaira", "Ryzen",
    "Xenon", "Vexis", "Nexos", "Omex", "Arcus", "Orbis", "Quion", "Axon", "Exos", "Ionix",
    "Velox", "Novus", "Altus", "Prisma", "Synex", "Dyna", "Kinex", "Metra", "Solaris", "Lunar",
    "Zynta", "Vyta", "Kyra", "Zela", "Xera", "Qura", "Jura", "Axia", "Exia", "Oza", "Una", "Oma",
    "Vitalix", "Biola", "Corex", "Synta", "Vytara", "Kinetix", "Zora", "Mian", "Elix", "Aether"
];
candidates.push(...compounds);


async function checkDomain(name: string) {
    const domain = `${name.toLowerCase()}.com`;
    try {
        await resolve(domain);
        // Taken
        process.stdout.write('x');
    } catch (e: any) {
        if (e.code === 'ENOTFOUND' || e.code === 'NXDOMAIN') {
            // Available
            process.stdout.write('!');
            const entry = { name, available: true, domain };
            fs.appendFileSync('available_names.json', JSON.stringify(entry) + ',\n');
        } else {
            process.stdout.write('?');
        }
    }
}

async function run() {
    console.log(`Checking ${candidates.length} candidates...`);
    fs.writeFileSync('available_names.json', '[\n'); // Start array

    // Batch 20 to speed up
    const batchSize = 25;
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        await Promise.all(batch.map(name => checkDomain(name)));
    }

    fs.appendFileSync('available_names.json', '{}]\n'); // Close valid JSON with dummy
    console.log('\nDone.');
}

run();
