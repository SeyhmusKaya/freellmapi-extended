// Minimal stdio MCP test client. Spawns dist/index.js, runs the handshake,
// lists tools, and (if a prompt arg is given) calls generate_image.
// Usage: node test-client.mjs ["a prompt to generate"]
import { spawn } from 'node:child_process';

const prompt = process.argv[2];
const child = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '0.0.1' },
});
console.log('initialize:', init.result?.serverInfo ?? init.error);
notify('notifications/initialized', {});

const tools = await rpc('tools/list', {});
console.log('tools:', (tools.result?.tools ?? []).map((t) => t.name));

if (prompt) {
  const call = await rpc('tools/call', {
    name: 'generate_image',
    arguments: { prompt },
  });
  const content = call.result?.content ?? [];
  for (const c of content) {
    if (c.type === 'text') console.log('text:', c.text);
    else if (c.type === 'image') console.log(`image: ${c.mimeType}, ${c.data.length} b64 chars`);
  }
  if (call.result?.isError) console.log('(tool returned isError)');
}

child.kill();
process.exit(0);
