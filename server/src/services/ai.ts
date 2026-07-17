// AI backend — DeepSeek (V4, OpenAI-compatible) when a key is configured, else
// local Ollama. Exposes chat / streaming chat / tool-calling / instruct so the
// rest of the app is provider-agnostic.
import { config } from '../config.js';
import type { AiChatMessage } from '../lib/model.js';

const ds = () => config.deepseek;
const useDeepseek = () => !!config.deepseek.apiKey;
const ollamaBase = () => config.ollama.url.replace(/\/$/, '');

export function providerName(): string { return useDeepseek() ? `DeepSeek (${ds().model})` : `Local (${config.ollama.model})`; }

export async function available(): Promise<boolean> {
  if (useDeepseek()) return true;
  try { const r = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
}

export async function models(): Promise<string[]> {
  if (useDeepseek()) return [ds().model];
  try { const r = await fetch(`${ollamaBase()}/api/tags`); return ((await r.json()).models || []).map((m: any) => m.name); } catch { return []; }
}

async function ollamaPickModel(): Promise<string> {
  const list = await models();
  if (list.includes(config.ollama.model)) return config.ollama.model;
  return list.find(m => /qwen2\.5.*instruct|qwen|llama3|mistral|phi|gemma/i.test(m)) || list[0] || config.ollama.model;
}

function parseArgs(a: any): any { if (a == null) return {}; if (typeof a === 'object') return a; try { return JSON.parse(a); } catch { return {}; } }

// ---- non-streaming chat -> assistant text ----
export async function chat(messages: AiChatMessage[], opts: { temperature?: number } = {}): Promise<string> {
  if (useDeepseek()) {
    const r = await fetch(`${ds().url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds().apiKey}` },
      body: JSON.stringify({ model: ds().model, messages, temperature: opts.temperature ?? 0.4, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).choices?.[0]?.message?.content || '';
  }
  const model = await ollamaPickModel();
  const r = await fetch(`${ollamaBase()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: opts.temperature ?? 0.4 } }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  return (await r.json()).message?.content || '';
}

// ---- streaming chat -> text chunks ----
export async function* chatStream(messages: AiChatMessage[], opts: { temperature?: number } = {}): AsyncGenerator<string> {
  if (useDeepseek()) {
    const r = await fetch(`${ds().url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds().apiKey}` },
      body: JSON.stringify({ model: ds().model, messages, temperature: opts.temperature ?? 0.4, stream: true }),
    });
    if (!r.ok || !r.body) throw new Error(`deepseek ${r.status}`);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim(); if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim(); if (payload === '[DONE]') return;
        try { const t = JSON.parse(payload).choices?.[0]?.delta?.content; if (t) yield t; } catch { /* */ }
      }
    }
    return;
  }
  const model = await ollamaPickModel();
  const r = await fetch(`${ollamaBase()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature: opts.temperature ?? 0.4 } }),
  });
  if (!r.ok || !r.body) throw new Error(`ollama ${r.status}`);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) { if (!line.trim()) continue; try { const j = JSON.parse(line); if (j.message?.content) yield j.message.content; } catch { /* */ } }
  }
}

// ---- tool-calling (non-streaming) -> {content, toolCalls, rawMessage} ----
export async function chatWithTools(messages: any[], tools: readonly any[], opts: { temperature?: number } = {}): Promise<{ content: string; toolCalls: { id: string; name: string; args: any }[]; rawMessage: any }> {
  if (useDeepseek()) {
    const r = await fetch(`${ds().url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds().apiKey}` },
      body: JSON.stringify({ model: ds().model, messages, tools, tool_choice: 'auto', temperature: opts.temperature ?? 0.3, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const m = (await r.json()).choices?.[0]?.message || {};
    return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c: any) => ({ id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments) })), rawMessage: m };
  }
  const model = await ollamaPickModel();
  const r = await fetch(`${ollamaBase()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: opts.temperature ?? 0.3 } }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const m = (await r.json()).message || {};
  return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c: any, i: number) => ({ id: c.id || `call_${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) })), rawMessage: m };
}

export async function instruct(system: string, user: string, temperature = 0.4): Promise<string> {
  return chat([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature });
}
