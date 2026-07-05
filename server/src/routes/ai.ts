// AI Assistant + shared AI actions (local Ollama). Privacy-first.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import { audit } from '../lib/db.js';
import { config } from '../config.js';
import * as ai from '../services/ai.js';
import * as whisper from '../services/whisper.js';
import { TOOLS, execTool } from '../services/aitools.js';

const r = Router();

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
    const out = await ai.instruct(sys, transcript || '', 0.1);
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
    const sys = {
      role: 'system',
      content: `You are Aerie Assistant, a capable AI for the user's private cloud server. You have TOOLS to inspect their files, photos, and media library and to take actions (generate images, build playlists). Use tools to answer factually about THEIR content instead of guessing. When a tool returns data, summarise it clearly. Be concise and helpful. Never invent file names or media — always use a tool. Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    };
    const convo: any[] = [sys, ...(messages || [])];
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const send = (o: any) => res.write(JSON.stringify(o) + '\n');
    audit(req.user!.id, req.user!.username, 'ai_request', 'agent');

    let lastContent = '';
    for (let step = 0; step < 6; step++) {
      let turn;
      try { turn = await ai.chatWithTools(convo, TOOLS, { temperature: 0.3 }); }
      catch (e) { send({ type: 'text', content: 'The AI is unavailable right now.' }); break; }
      lastContent = turn.content;
      if (turn.toolCalls.length) {
        convo.push(turn.rawMessage);
        for (const c of turn.toolCalls) {
          send({ type: 'tool', name: c.name, args: c.args });
          const result = await execTool(c.name, c.args || {}, { username: req.user!.username, userId: req.user!.id }).catch((e) => ({ error: String(e) }));
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
        try { for await (const chunk of ai.chatStream(finalMsgs)) send({ type: 'text', content: chunk }); } catch { /* */ }
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

r.get('/status', async (_req, res) => {
  const ok = await ai.available();
  res.json({ available: ok, models: ok ? await ai.models() : [] });
});

// Streaming chat (SSE-ish newline JSON)
r.post('/chat', async (req: AuthedRequest, res, next) => {
  try {
    const { messages, context } = req.body || {};
    const sys = context
      ? `You are Aerie Assistant, a helpful private AI running locally on the user's own server. Be concise and practical. Context:\n${context}`
      : `You are Aerie Assistant, a helpful private AI running locally on the user's own server. Be concise and practical.`;
    const full = [{ role: 'system', content: sys }, ...(messages || [])];
    audit(req.user!.id, req.user!.username, 'ai_request', 'assistant');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    for await (const chunk of ai.chatStream(full)) res.write(chunk);
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
  // TRANSLATE_LANG makes translate bidirectional for bilingual households:
  // non-English → English, English → that language. Unset = to English only.
  translate: process.env.TRANSLATE_LANG
    ? `Translate the following text to English (or to ${process.env.TRANSLATE_LANG} if it is already English). Return only the translation.`
    : 'Translate the following text to English. Return only the translation.',
  outline: 'Create a structured outline from the following text.',
  title: 'Generate a concise, descriptive title for the following text. Return only the title.',
  contradictions: 'Find and list any contradictions in the following text.',
  clean: 'Turn these rough notes into clean, well-structured prose. Return only the result.',
};

r.post('/doc-action', async (req: AuthedRequest, res, next) => {
  try {
    const { action, text } = req.body || {};
    const instruction = DOC_ACTIONS[action];
    if (!instruction) return res.status(400).json({ error: 'unknown_action' });
    audit(req.user!.id, req.user!.username, 'ai_request', `doc:${action}`);
    const result = await ai.instruct(instruction, text || '', 0.4);
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
      `${instruction}\n\nData:\n${gridText}`, 0.3);
    res.json({ action, suggestion: result.trim() });
  } catch (e) { next(e); }
});

export default r;
