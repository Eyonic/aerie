// AI backend — OpenAI-compatible DeepSeek when a key is configured, else
// local Ollama. Exposes chat / streaming chat / tool-calling / instruct so the
// rest of the app is provider-agnostic.
import { config } from '../config.js';
import type { AiChatMessage } from '../lib/model.js';
import type { AiProvider } from './policy.js';
import { OutboundHttpError, outboundJson, outboundVoid, validateOutboundUrl } from './outbound-http.js';

const ds = () => config.deepseek;
export interface AiRequestOptions { temperature?: number; provider?: AiProvider; signal?: AbortSignal; }
const useDeepseek = (opts?: AiRequestOptions) => opts?.provider === 'external' && !!config.deepseek.apiKey;
const ollamaBase = () => config.ollama.url.replace(/\/$/, '');

export function providerName(opts: AiRequestOptions = {}): string { return useDeepseek(opts) ? `DeepSeek (${ds().model})` : `Local (${config.ollama.model})`; }

export async function available(opts: AiRequestOptions = {}): Promise<boolean> {
  if (useDeepseek(opts)) return true;
  if (!ollamaBase()) return false;
  try { await outboundVoid(`${ollamaBase()}/api/tags`, { timeoutMs: 2500 }); return true; } catch { return false; }
}

export async function models(opts: AiRequestOptions = {}): Promise<string[]> {
  if (useDeepseek(opts)) return [ds().model];
  if (!ollamaBase()) return [];
  try {
    const result = await outboundJson<any>(`${ollamaBase()}/api/tags`, { timeoutMs: 5000, maxBytes: 2 * 1024 * 1024 });
    return (result.body.models || []).map((m: any) => String(m.name || '')).filter(Boolean).slice(0, 500);
  } catch { return []; }
}

async function ollamaPickModel(): Promise<string> {
  const list = await models();
  if (list.includes(config.ollama.model)) return config.ollama.model;
  return list.find(m => /qwen2\.5.*instruct|qwen|llama3|mistral|phi|gemma/i.test(m)) || list[0] || config.ollama.model;
}

function parseArgs(a: any): any { if (a == null) return {}; if (typeof a === 'object') return a; try { return JSON.parse(a); } catch { return {}; } }

async function aiJson(provider: 'deepseek' | 'ollama', url: string, init: RequestInit,
  signal?: AbortSignal): Promise<any> {
  try {
    return (await outboundJson<any>(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal,
      timeoutMs: 120_000,
      maxBytes: 8 * 1024 * 1024,
    })).body;
  } catch (error) {
    const suffix = error instanceof OutboundHttpError ? error.upstreamStatus || error.code : 'unavailable';
    throw Object.assign(new Error(`${provider}_${suffix}`), { status: 502 });
  }
}

async function aiStreamResponse(url: string, init: RequestInit, callerSignal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(120_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  return fetch(validateOutboundUrl(url), { ...init, redirect: 'error', signal });
}

async function* decodedStream(response: Response, format: 'sse' | 'ndjson'): AsyncGenerator<string> {
  if (!response.body) throw new Error('ai_stream_unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  const parse = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (format === 'sse') {
      if (!trimmed.startsWith('data:')) return null;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return '__DONE__';
      try { return JSON.parse(payload).choices?.[0]?.delta?.content || null; } catch { return null; }
    }
    try { return JSON.parse(trimmed).message?.content || null; } catch { return null; }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 8 * 1024 * 1024) throw new Error('ai_response_too_large');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('ai_stream_frame_too_large');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const text = parse(line);
        if (text === '__DONE__') return;
        if (text) yield text;
      }
    }
    const final = parse(buffer + decoder.decode());
    if (final && final !== '__DONE__') yield final;
  } finally {
    try { await reader.cancel(); } catch { /* connection already closed */ }
  }
}

// ---- non-streaming chat -> assistant text ----
export async function chat(messages: AiChatMessage[], opts: AiRequestOptions = {}): Promise<string> {
  if (useDeepseek(opts)) {
    const data = await aiJson('deepseek', `${ds().url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds().apiKey}` },
      body: JSON.stringify({ model: ds().model, messages, temperature: opts.temperature ?? 0.4, stream: false }),
    }, opts.signal);
    return data.choices?.[0]?.message?.content || '';
  }
  const model = await ollamaPickModel();
  const data = await aiJson('ollama', `${ollamaBase()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: opts.temperature ?? 0.4 } }),
  }, opts.signal);
  return data.message?.content || '';
}

// ---- streaming chat -> text chunks ----
export async function* chatStream(messages: AiChatMessage[], opts: AiRequestOptions = {}): AsyncGenerator<string> {
  if (useDeepseek(opts)) {
    const r = await aiStreamResponse(`${ds().url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds().apiKey}` },
      body: JSON.stringify({ model: ds().model, messages, temperature: opts.temperature ?? 0.4, stream: true }),
    }, opts.signal);
    if (!r.ok || !r.body) throw new Error(`deepseek ${r.status}`);
    yield* decodedStream(r, 'sse');
    return;
  }
  const model = await ollamaPickModel();
  const r = await aiStreamResponse(`${ollamaBase()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature: opts.temperature ?? 0.4 } }),
  }, opts.signal);
  if (!r.ok || !r.body) throw new Error(`ollama ${r.status}`);
  yield* decodedStream(r, 'ndjson');
}

// ---- tool-calling (non-streaming) -> {content, toolCalls, rawMessage} ----
export async function chatWithTools(messages: any[], tools: readonly any[], opts: AiRequestOptions = {}): Promise<{ content: string; toolCalls: { id: string; name: string; args: any }[]; rawMessage: any }> {
  if (useDeepseek(opts)) {
    const data = await aiJson('deepseek', `${ds().url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds().apiKey}` },
      body: JSON.stringify({ model: ds().model, messages, tools, tool_choice: 'auto', temperature: opts.temperature ?? 0.3, stream: false }),
    }, opts.signal);
    const m = data.choices?.[0]?.message || {};
    return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c: any) => ({ id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments) })), rawMessage: m };
  }
  const model = await ollamaPickModel();
  const data = await aiJson('ollama', `${ollamaBase()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: opts.temperature ?? 0.3 } }),
  }, opts.signal);
  const m = data.message || {};
  return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c: any, i: number) => ({ id: c.id || `call_${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) })), rawMessage: m };
}

export async function instruct(system: string, user: string, temperature = 0.4, opts: Omit<AiRequestOptions, 'temperature'> = {}): Promise<string> {
  return chat([{ role: 'system', content: system }, { role: 'user', content: user }], { ...opts, temperature });
}
