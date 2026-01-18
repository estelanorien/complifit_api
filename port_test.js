import net from 'net';
const server = net.createServer();
server.once('error', (err) => {
    console.log('PORT_ERROR:', err.code, err.message);
    process.exit(1);
});
server.once('listening', () => {
    console.log('PORT_AVAILABLE');
    server.close();
    process.exit(0);
});
server.listen(3005, '0.0.0.0');
