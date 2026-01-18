const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3005,
    path: '/api/admin/assets/recent',
    method: 'GET',
    headers: {
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log('Status Code:', res.statusCode);
        try {
            const parsed = JSON.parse(data);
            console.log('Response Items:', parsed.length);
            if (parsed.length > 0) {
                console.log('First Item:', JSON.stringify(parsed[0], null, 2));
                // Check if any match the user's meal "Nohutlu Bulgur Pilavı"
                const match = parsed.find(a => a.movement_id && a.movement_id.toLowerCase().includes('nohutlu'));
                if (match) {
                    console.log('Found Nohutlu Meal:', JSON.stringify(match, null, 2));
                } else {
                    console.log('Nohutlu Meal NOT FOUND in recent list.');
                    // list all names
                    console.log('All Names:', parsed.map(p => p.movement_id));
                }
            } else {
                console.log('No recent assets found.');
            }
        } catch (e) {
            console.log('Raw Data:', data);
        }
    });
});
req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});
req.end();
