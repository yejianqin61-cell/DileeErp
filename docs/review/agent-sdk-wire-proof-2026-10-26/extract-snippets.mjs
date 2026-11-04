import { readFileSync } from 'node:fs';
const dir = new URL('./captures/', import.meta.url);
for (const f of ['02-plan-after-tool.json', '03-stream-after-tool.json', '04-plan-after-tool-fixed.json', '05-sdk-object-input-control.json']) {
  const r = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  const a = r.body.messages.find((m) => m.tool_calls);
  const arg = a.tool_calls[0].function.arguments;
  const idx = r.rawBody.indexOf('"arguments"');
  console.log(f);
  console.log('  decoded value = ' + JSON.stringify(arg));
  console.log('  wire fragment = ' + r.rawBody.slice(idx, idx + 72));
  let kind;
  try { kind = typeof JSON.parse(arg); } catch { kind = 'invalid'; }
  console.log('  JSON.parse(arg) type = ' + kind);
}
