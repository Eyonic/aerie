// AI Assistant + shared AI actions. Provider choice is policy- and
// preference-driven; translation has its own explicit per-user selection.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { audit } from '../lib/db.js';
import { config } from '../config.js';
import * as ai from '../services/ai.js';
import * as whisper from '../services/whisper.js';
import { execTool, toolsForUser } from '../services/aitools.js';
import { adminPolicy, aiDecision } from '../services/policy.js';
import {
  assertTranslationProviderAllowed,
  configuredTranslationTarget,
  getTranslationPreferences,
  languageName,
} from '../services/translation-preferences.js';

const r = Router();

r.use((req: AuthedRequest, res, next) => {
  try { aiDecision(req.user!, req); next(); }
  catch (error: any) { res.status(error?.status || 403).json({ error: error?.message || 'ai_disabled' }); }
});

function effectiveDecision(req: AuthedRequest) {
  const decision = aiDecision(req.user!, req);
  return decision.provider === 'external' && !config.deepseek.apiKey
    ? { ...decision, provider: 'local' as const, external: false }
    : decision;
}
function provider(req: AuthedRequest) { return effectiveDecision(req).provider; }
function cleanMessages(value: unknown): any[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-80).map(message => ({
    role: ['system', 'user', 'assistant', 'tool'].includes(String(message?.role)) ? String(message.role) : 'user',
    content: String(message?.content ?? '').slice(0, 32_000),
  }));
}

// Speech-to-text. Body: { pcm: base64 16kHz-mono-16bit-LE PCM, lang? }.
r.post('/transcribe', async (req: AuthedRequest, res, next) => {
  try {
    const { pcm, lang } = req.body || {};
    if (!pcm) return res.status(400).json({ error: 'no_audio' });
    const buf = Buffer.from(pcm, 'base64');
    const text = await whisper.transcribe(buf, lang || 'en');
    audit(req.user!.id, req.user!.username, 'transcribe', `${buf.length} bytes`);
    res.json({ text });
  } catch (e) { next(e); }
});
r.get('/transcribe/status', async (_req, res) => res.json({ available: await whisper.available() }));

// Interpret a spoken command against spreadsheet/doc context -> a small JSON
// instruction the editor applies (e.g. {action:'setFormula', cell:'B2', value:'=SUM(A1:A10)'}).
r.post('/voice-command', async (req: AuthedRequest, res, next) => {
  try {
    const { transcript, context, kind } = req.body || {};
    const sys = kind === 'sheet'
      ? `You convert a spoken instruction into ONE JSON action for a spreadsheet. Reply ONLY with JSON. Actions: {"action":"setCell","cell":"A1","value":"..."} | {"action":"setFormula","cell":"B2","value":"=SUM(A1:A10)"} | {"action":"insertText","text":"..."} | {"action":"none"}. Use A1 notation. Current selection/context: ${context || 'unknown'}.`
      : `You convert a spoken instruction into ONE JSON action for a document editor. Reply ONLY with JSON. Actions: {"action":"insertText","text":"..."} | {"action":"format","format":"bold|italic|h1|h2|bullet"} | {"action":"none"}.`;
    const out = await ai.instruct(sys, String(transcript || '').slice(0, 16_000), 0.1, { provider: provider(req) });
    let json: any = { action: 'insertText', text: transcript };
    try { json = JSON.parse(out.replace(/```json|```/g, '').trim()); } catch { /* keep dictation fallback */ }
    res.json(json);
  } catch (e) { next(e); }
});

// Agentic assistant: Ollama tool-calling loop. Streams NDJSON events:
//   {type:'tool', name, args} | {type:'tool_result', name, result} | {type:'text', content} | {type:'done'}
r.post('/agent', async (req: AuthedRequest, res, next) => {
  try {
    const { messages } = req.body || {};
    const decision = effectiveDecision(req);
    const tools = toolsForUser(req.user!);
    const contentTools = tools.map(tool => tool.function?.name).filter(Boolean).join(', ');
    const sys = {
      role: 'system',
      content: `You are Aerie Assistant, a capable AI for the user's private cloud server. ${decision.external ? 'This request is being processed by the configured external AI provider with the user\'s permission.' : 'This request is being processed by the configured local AI provider.'} The only private-cloud tools currently authorized for this member are: ${contentTools || 'none'}. Never claim access to a disabled content category, and never invent file names or media. When an authorized tool returns data, summarise it clearly. You can still answer ordinary questions without a tool. Be concise and helpful. Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    };
    const convo: any[] = [sys, ...cleanMessages(messages)];
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const send = (o: any) => res.write(JSON.stringify(o) + '\n');
    audit(req.user!.id, req.user!.username, 'ai_request', 'agent', req.ip,
      { provider: decision.provider, external: decision.external });

    let lastContent = '';
    for (let step = 0; step < 6; step++) {
      let turn;
      try { turn = await ai.chatWithTools(convo, tools, { temperature: 0.3, provider: provider(req), signal: controller.signal }); }
      catch (e) { send({ type: 'text', content: 'The AI is unavailable right now.' }); break; }
      lastContent = turn.content;
      if (turn.toolCalls.length) {
        convo.push(turn.rawMessage);
        for (const c of turn.toolCalls) {
          send({ type: 'tool', name: c.name, args: c.args });
          const result = await execTool(c.name, c.args || {}, { username: req.user!.username, userId: req.user!.id, user: req.user! }).catch((e) => ({ error: String(e) }));
          send({ type: 'tool_result', name: c.name, result });
          convo.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: JSON.stringify(result).slice(0, 8000) });
        }
        continue; // let the model use the results
      }
      // No tool calls -> the tool-decision pass (chatWithTools) already produced the full
      // answer in `lastContent`. Emit THAT progressively instead of re-running the model via
      // chatStream. The old code double-generated the reply (one silent full pass here, then a
      // second streamed pass), which is why plain-text answers sat on bouncing dots for several
      // seconds and could even differ between the two passes.
      if (lastContent.trim()) {
        const parts = lastContent.match(/\S+\s*/g) || [lastContent];
        for (const p of parts) send({ type: 'text', content: p });
      } else {
        // Nothing was generated -> fall back to a single fresh streamed answer.
        const finalMsgs = [...convo, { role: 'user', content: 'Answer now based on everything above. Do not call tools.' }];
        try { for await (const chunk of ai.chatStream(finalMsgs, { provider: provider(req), signal: controller.signal })) send({ type: 'text', content: chunk }); } catch { /* */ }
      }
      break;
    }
    send({ type: 'done' });
    res.end();
  } catch (e) {
    if (!res.headersSent) return next(e);
    res.end();
  }
});

r.get('/status', async (req: AuthedRequest, res) => {
  const decision = effectiveDecision(req);
  const options = { provider: decision.provider } as const;
  const ok = await ai.available(options);
  res.json({ available: ok, provider: ai.providerName(options), external: decision.external,
    consentRequired: req.user!.aiMode === 'ask_before_send' && adminPolicy().externalAiEnabled && !!config.deepseek.apiKey,
    models: ok ? await ai.models(options) : [] });
});

// Streaming chat (SSE-ish newline JSON)
r.post('/chat', async (req: AuthedRequest, res, next) => {
  try {
    const { messages, context } = req.body || {};
    const decision = effectiveDecision(req);
    const location = decision.external ? 'through the configured external provider with explicit user permission' : 'locally on the user\'s own server';
    const sys = context
      ? `You are Aerie Assistant, a helpful AI running ${location}. Be concise and practical. Context:\n${context}`
      : `You are Aerie Assistant, a helpful AI running ${location}. Be concise and practical.`;
    const full = [{ role: 'system', content: sys }, ...cleanMessages(messages)];
    audit(req.user!.id, req.user!.username, 'ai_request', 'assistant', req.ip,
      { provider: decision.provider, external: decision.external });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    for await (const chunk of ai.chatStream(full, { provider: provider(req), signal: controller.signal })) res.write(chunk);
    res.end();
  } catch (e) {
    if (!res.headersSent) return next(e);
    res.end();
  }
});

// Document/text AI actions (return a suggestion the user approves)
const DOC_ACTIONS: Record<string, string> = {
  summarize: 'Summarize the following text clearly and concisely.',
  improve: 'Improve the writing quality of the following text while preserving meaning. Return only the improved text.',
  spelling: 'Fix spelling mistakes in the following text. Return only the corrected text.',
  grammar: 'Fix grammar in the following text. Return only the corrected text.',
  professional: 'Rewrite the following text in a professional tone. Return only the rewritten text.',
  shorter: 'Make the following text shorter while keeping key points. Return only the result.',
  longer: 'Expand the following text with more detail. Return only the result.',
  explain: 'Explain the following text in simple terms.',
  outline: 'Create a structured outline from the following text.',
  title: 'Generate a concise, descriptive title for the following text. Return only the title.',
  contradictions: 'Find and list any contradictions in the following text.',
  clean: 'Turn these rough notes into clean, well-structured prose. Return only the result.',
};

r.post('/doc-action', async (req: AuthedRequest, res, next) => {
  try {
    const { action, text, targetLanguage } = req.body || {};
    const source = String(text || '').slice(0, 64_000);
    if (action === 'translate') {
      const preferences = getTranslationPreferences(req.user!.id);
      const selectedProvider = assertTranslationProviderAllowed(req.user!.id, preferences.provider);
      const target = configuredTranslationTarget(req.user!.id, targetLanguage || preferences.languages[0]);
      const targetName = languageName(target);
      const instruction = `Translate the following text into ${targetName} (language tag: ${target}). Preserve meaning, tone, names, numbers, and formatting. Return only the translation.`;
      audit(req.user!.id, req.user!.username, 'ai_request', 'doc:translate', req.ip,
        { provider: selectedProvider, targetLanguage: target });
      const result = await ai.instruct(instruction, source, 0.1, { provider: selectedProvider });
      return res.json({ action, original: text, suggestion: result.trim(), provider: selectedProvider, targetLanguage: target });
    }
    const instruction = DOC_ACTIONS[action];
    if (!instruction) return res.status(400).json({ error: 'unknown_action' });
    audit(req.user!.id, req.user!.username, 'ai_request', `doc:${action}`);
    const result = await ai.instruct(instruction, source, 0.4, { provider: provider(req) });
    res.json({ action, original: text, suggestion: result.trim() });
  } catch (e) { next(e); }
});

// Spreadsheet AI actions — operate on a JSON grid; return advice + optional patch
r.post('/sheet-action', async (req: AuthedRequest, res, next) => {
  try {
    const { action, grid } = req.body || {};
    const gridText = JSON.stringify(grid).slice(0, 12000);
    const prompts: Record<string, string> = {
      explain: 'Explain what this spreadsheet contains and its structure.',
      errors: 'Find likely errors or inconsistencies in this spreadsheet data.',
      missing: 'Identify missing values and where they are.',
      duplicates: 'Identify duplicate rows in this spreadsheet data.',
      formulas: 'Suggest useful formulas for this spreadsheet and explain them.',
      summary: 'Summarize the key insights from this spreadsheet data.',
      outliers: 'Identify statistical outliers in this spreadsheet data.',
      charts: 'Suggest which charts would best visualize this data and why.',
      clean: 'Suggest how to clean and normalize this messy data.',
    };
    const instruction = prompts[action] || prompts.explain;
    audit(req.user!.id, req.user!.username, 'ai_request', `sheet:${action}`);
    const result = await ai.instruct(
      'You are a spreadsheet analysis assistant. Data is a 2D JSON array (rows of cells).',
      `${instruction}\n\nData:\n${gridText}`, 0.3, { provider: provider(req) });
    res.json({ action, suggestion: result.trim() });
  } catch (e) { next(e); }
});

export default r;
