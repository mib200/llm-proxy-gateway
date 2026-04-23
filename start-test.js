import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// Reserve a free ephemeral port so the smoke test never collides with a
// running dev server (prior behaviour failed with EADDRINUSE on port 8787).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const port = await getFreePort();
console.log(`Starting the application on port ${port}...`);

const app = spawn('node', ['build/start-server.js', '--headless'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port) },
});

let shuttingDown = false;

app.on('exit', (code, signal) => {
  if (shuttingDown) {
    // Intentional termination after successful startup window.
    process.exit(0);
  }
  console.error(`Failed to start the app (code=${code}, signal=${signal})`);
  process.exit(1);
});

app.on('spawn', () => {
  console.log('App started successfully');
  setTimeout(() => {
    shuttingDown = true;
    app.kill();
  }, 3000);
});
