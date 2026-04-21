import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

const rootDir = process.cwd();
const apiDir = resolve(rootDir, '..', 'mide-chatbot');
const API_HOST = '127.0.0.1';
const API_PORT = 8000;

function pickPythonCommand() {
  const winVenvPython = resolve(apiDir, 'venv', 'Scripts', 'python.exe');
  const unixVenvPython = resolve(apiDir, 'venv', 'bin', 'python');

  if (existsSync(winVenvPython)) {
    return { cmd: winVenvPython, args: [] };
  }

  if (existsSync(unixVenvPython)) {
    return { cmd: unixVenvPython, args: [] };
  }

  if (process.platform === 'win32') {
    return { cmd: 'py', args: ['-3'] };
  }

  return { cmd: 'python3', args: [] };
}

const python = pickPythonCommand();
const api = spawn(
  python.cmd,
  [...python.args, '-m', 'uvicorn', 'app:app', '--reload', '--host', API_HOST, '--port', String(API_PORT)],
  {
    cwd: apiDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let web = null;

let shuttingDown = false;

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  if (web) web.kill(signal);
  api.kill(signal);

  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function waitForApiReady(host, port, timeoutMs = 20000) {
  const start = Date.now();

  return new Promise((resolveReady, rejectReady) => {
    const tryConnect = () => {
      if (Date.now() - start > timeoutMs) {
        rejectReady(new Error(`[dev] Timeout esperando API en http://${host}:${port}`));
        return;
      }

      const socket = net.createConnection({ host, port });

      socket.once('connect', () => {
        socket.end();
        resolveReady();
      });

      socket.once('error', () => {
        socket.destroy();
        setTimeout(tryConnect, 250);
      });
    };

    tryConnect();
  });
}

async function startWebWhenApiIsReady() {
  try {
    console.log('\n[dev] 🚀 Esperando a que la API esté lista...');
    await waitForApiReady(API_HOST, API_PORT);
    console.log(`[dev] ✅ API lista en http://${API_HOST}:${API_PORT}`);
    console.log('[dev] 🌐 Arrancando frontend...\n');
    
    web = spawn(npmCmd, ['run', 'dev:web'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    web.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`[dev] Frontend finalizo con codigo ${code ?? 0}.`);
        shutdown();
      }
    });
  } catch (error) {
    console.error(`\n[dev] ❌ Error: ${error.message}`);
    console.error(`[dev] Verifica que FastAPI esté corriendo en http://${API_HOST}:${API_PORT}\n`);
    shutdown();
  }
}

startWebWhenApiIsReady();

api.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[dev] API finalizo con codigo ${code ?? 0}.`);
    shutdown();
  }
});
