// BoardPainter MCP server (stdio). Claude Desktop / Claude Code start this with the BoardPainter executable in
// Node mode (ELECTRON_RUN_AS_NODE=1), so nothing else needs installing. It forwards each tool call to the running
// BoardPainter window through the local bridge the app opens while "allow Claude" is on
// (<home>/BoardPainterLink/claude-bridge.json: port + token, 127.0.0.1 only).
// Protocol: JSON-RPC 2.0, one message per line (MCP stdio transport).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const TOOLS = require('./agent-tools.js');
const VERSION = '1.0.0';

const bridgeFile = () => path.join(process.env.BP_LINK_DIR ? path.resolve(process.env.BP_LINK_DIR) : path.join(os.homedir(), 'BoardPainterLink'), 'claude-bridge.json');
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (text, isError) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

function callApp(tool, args) {
  let b;
  try { b = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8')); }
  catch { return Promise.resolve(textResult('BoardPainter is not reachable. Open BoardPainter and turn on "Claude からの操作を許可" (allow Claude) in the "Claude と連携" section.', true)); }
  const body = JSON.stringify({ tool, args: args || {} });
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: b.port, path: '/call', method: 'POST', timeout: 600000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-bp-token': b.token } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (r.error) { resolve(textResult(r.error, true)); return; }
          const content = [];
          if (r.text) content.push({ type: 'text', text: r.text });
          for (const img of r.images || []) content.push({ type: 'image', data: img.data, mimeType: 'image/png' }, ...(img.label ? [{ type: 'text', text: img.label }] : []));
          resolve({ content: content.length ? content : [{ type: 'text', text: 'done' }] });
        } catch (e) { resolve(textResult('Bad answer from BoardPainter: ' + e.message, true)); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(textResult('BoardPainter did not answer in time.', true)); });
    req.on('error', () => resolve(textResult('BoardPainter is not reachable (is it still open, with "allow Claude" on?).', true)));
    req.end(body);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;   // notifications (initialized, cancelled): nothing to answer
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params && params.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'boardpainter', title: 'BoardPainter', version: VERSION },
      instructions: 'BoardPainter is a 3D modelling app. Build game assets from primitive parts (add_shape), shape them (edit_faces, bevel_edges, insert_loops, deform, boolean, subdivide), colour them, and check your work with render (look at it from several views and fix what looks wrong) before export. Y is up, the front faces +Z, 1 unit = 1 metre.',
    });
  } else if (method === 'ping') reply(id, {});
  else if (method === 'tools/list') reply(id, { tools: TOOLS });
  else if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some(t => t.name === name)) { fail(id, -32602, `Unknown tool: ${name}`); return; }
    reply(id, await callApp(name, params.arguments));
  } else fail(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg).catch(e => msg.id !== undefined && fail(msg.id, -32603, String(e && e.message || e)));
  }
});
process.stdin.on('end', () => process.exit(0));
