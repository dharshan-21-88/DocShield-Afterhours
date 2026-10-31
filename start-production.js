import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const backendPort = process.env.BACKEND_PORT || '3002';
const frontendPort = process.env.PORT || '3000';

console.log('====================================================');
console.log('🛡️  DocShield Unified Production Runtime Starting');
console.log(`📡 Backend internal port : ${backendPort}`);
console.log(`🌐 Frontend public port   : ${frontendPort}`);
console.log('====================================================');

// 1. Start Express Processing Backend
const backend = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: backendPort,
    NODE_ENV: process.env.NODE_ENV || 'production',
  },
  stdio: 'inherit',
});

backend.on('error', (err) => {
  console.error('Failed to start backend engine:', err);
});

// 2. Start Next.js Frontend Studio
const frontend = spawn(
  'npx',
  ['next', 'start', '-p', String(frontendPort)],
  {
    cwd: path.join(__dirname, 'frontend'),
    env: {
      ...process.env,
      PORT: String(frontendPort),
      BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      NODE_ENV: process.env.NODE_ENV || 'production',
    },
    stdio: 'inherit',
    shell: true,
  }
);

frontend.on('error', (err) => {
  console.error('Failed to start frontend studio:', err);
});

function handleExit(signal) {
  console.log(`Received ${signal}, shutting down DocShield services...`);
  try { backend.kill(); } catch {}
  try { frontend.kill(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
