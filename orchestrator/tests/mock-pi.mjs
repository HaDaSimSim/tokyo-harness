#!/usr/bin/env node
// Mock pi --mode rpc: echoes prompts back with a fixed response pattern.
// Used for integration tests without a real LLM.
// ESM-compatible (Node v24+).

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });

let msgCount = 0;

rl.on('line', (line) => {
  try {
    const cmd = JSON.parse(line);
    if (cmd.type === 'prompt') {
      msgCount++;
      const id = cmd.id || null;
      // Emit response (accepted)
      const resp = { type: 'response', command: 'prompt', success: true };
      if (id) resp.id = id;
      process.stdout.write(JSON.stringify(resp) + '\n');

      // Emit agent_start
      process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');

      // Emit turn_start
      process.stdout.write(JSON.stringify({ type: 'turn_start' }) + '\n');

      // Generate a mock response based on the message
      const msg = cmd.message || '';
      let reply;
      if (msg.includes('MANGO77') || msg.includes('secret code: MANGO')) {
        reply = 'stored';
      } else if (msg.includes('What was the secret') || msg.includes('secret code')) {
        reply = 'MANGO77';
      } else if (msg.includes('ready') || msg.includes('Acknowledge')) {
        reply = 'ready';
      } else if (msg.includes('2+2') || msg.includes('1+1')) {
        reply = '4';
      } else {
        reply = `[mock response #${msgCount} to: ${msg.slice(0, 50)}]`;
      }

      // Emit streaming text
      process.stdout.write(JSON.stringify({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: reply }
      }) + '\n');

      // Emit agent_end
      process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
    }
  } catch (e) {
    // Ignore parse errors
  }
});
