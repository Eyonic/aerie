// AI image generation via ComfyUI. Primary engine is the user's Krea2 turbo
// workflow (UNET krea2_turbo_fp8_scaled + turbo LoRA + Qwen3-VL CLIP "krea2" +
// qwen_image_vae, SamplerCustomAdvanced, 8 steps euler — ~16s). Falls back to a
// FLUX-dev checkpoint graph if the Krea2 assets aren't present. Degrades to
// "offline" gracefully when ComfyUI is unreachable.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as gpu from './gpu.js';
import { outboundBytes, outboundJson, outboundVoid } from './outbound-http.js';

const base = () => config.sd.url.replace(/\/$/, '');

const KREA = {
  unet: 'krea2_turbo_fp8_scaled.safetensors',
  lora: 'krea2_turbo_nsfw_v3081369.safetensors',
  loraStrength: 1.4,
  clip: 'qwen3vl_4b_fp8_scaled.safetensors',
  clipType: 'krea2',
  vae: 'qwen_image_vae.safetensors',
  steps: 8,
  sampler: 'euler',
  scheduler: 'simple',
};

let engine: 'krea' | 'flux' | null = null;
let fluxCkpt = '';
let engineChecked = 0;

export async function available(): Promise<boolean> {
  try {
    await outboundVoid(`${base()}/system_stats`, { timeoutMs: 3000 });
    return true;
  } catch { return false; }
}

async function optionList(node: string, input: string): Promise<string[]> {
  try {
    const d = (await outboundJson<any>(`${base()}/object_info/${encodeURIComponent(node)}`,
      { timeoutMs: 5000, maxBytes: 16 * 1024 * 1024 })).body;
    return d?.[node]?.input?.required?.[input]?.[0] || [];
  } catch { return []; }
}

// Decide which engine to use (Krea2 if its UNET is installed, else FLUX checkpoint).
async function resolveEngine(): Promise<'krea' | 'flux' | null> {
  if (engine && Date.now() - engineChecked < 300000) return engine;
  const unets = await optionList('UNETLoader', 'unet_name');
  if (unets.includes(KREA.unet)) { engine = 'krea'; }
  else {
    const cks = await optionList('CheckpointLoaderSimple', 'ckpt_name');
    fluxCkpt = cks.find(n => /flux.*fp8/i.test(n)) || cks.find(n => /flux/i.test(n)) || cks[0] || '';
    engine = fluxCkpt ? 'flux' : null;
  }
  engineChecked = Date.now();
  return engine;
}

export interface TxtImgParams {
  prompt: string; negativePrompt?: string; width?: number; height?: number;
  steps?: number; cfgScale?: number; seed?: number; batch?: number;
}

function randSeed() { return Math.floor(Math.random() * 2 ** 31); }

// ---- Krea2 graph (SamplerCustomAdvanced pipeline) ----
function kreaBase(prompt: string, seed: number, steps: number, denoise: number) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: KREA.unet, weight_dtype: 'default' } },
    '13': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: KREA.lora, strength_model: KREA.loraStrength } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: KREA.clip, type: KREA.clipType, device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: KREA.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '5': { class_type: 'BasicGuider', inputs: { model: ['13', 0], conditioning: ['4', 0] } },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '7': { class_type: 'BasicScheduler', inputs: { model: ['13', 0], scheduler: KREA.scheduler, steps, denoise } },
    '8': { class_type: 'KSamplerSelect', inputs: { sampler_name: KREA.sampler } },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    '12': { class_type: 'SaveImage', inputs: { filename_prefix: 'aerie', images: ['11', 0] } },
  } as any;
}
function kreaTxt2Img(p: TxtImgParams, seed: number): any {
  const g = kreaBase(p.prompt, seed, p.steps || KREA.steps, 1);
  g['9'] = { class_type: 'EmptyLatentImage', inputs: { width: p.width || 832, height: p.height || 1216, batch_size: p.batch || 1 } };
  g['10'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['5', 0], sampler: ['8', 0], sigmas: ['7', 0], latent_image: ['9', 0] } };
  return g;
}
function kreaImg2Img(p: TxtImgParams & { denoising?: number; maskName?: string }, seed: number, initName: string): any {
  const g = kreaBase(p.prompt, seed, p.steps || KREA.steps, p.maskName ? 1 : (p.denoising ?? 0.75));
  g['20'] = { class_type: 'LoadImage', inputs: { image: initName } };
  if (p.maskName) {
    g['21'] = { class_type: 'LoadImageMask', inputs: { image: p.maskName, channel: 'red' } };
    g['22'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['20', 0], vae: ['3', 0], mask: ['21', 0], grow_mask_by: 6 } };
  } else {
    g['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['3', 0] } };
  }
  g['10'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['5', 0], sampler: ['8', 0], sigmas: ['7', 0], latent_image: ['22', 0] } };
  return g;
}

// ---- FLUX checkpoint fallback graph ----
function fluxTxt2Img(p: TxtImgParams, seed: number): any {
  const steps = p.steps || 20;
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: fluxCkpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width || 1024, height: p.height || 1024, batch_size: p.batch || 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negativePrompt || '', clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'aerie', images: ['8', 0] } },
  } as any;
}

async function submit(graph: any): Promise<string> {
  const data = (await outboundJson<any>(`${base()}/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'aerie' }), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024,
  })).body;
  if (data.error) throw new Error(`comfyui: ${JSON.stringify(data.error).slice(0, 200)}`);
  return data.prompt_id;
}

async function waitForImages(promptId: string, timeoutMs = 240000): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const hist = (await outboundJson<any>(`${base()}/history/${encodeURIComponent(promptId)}`,
        { timeoutMs: 8000, maxBytes: 16 * 1024 * 1024 })).body;
      const entry = hist[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === 'error') throw new Error('comfyui execution error: ' + JSON.stringify(entry.status?.messages || '').slice(0, 200));
      const imgs: any[] = [];
      for (const nodeId of Object.keys(entry.outputs || {})) for (const img of (entry.outputs[nodeId].images || [])) imgs.push(img);
      if (imgs.length) return imgs;
    } catch (e: any) { if (/execution error/.test(e.message)) throw e; }
  }
  throw new Error('comfyui timeout');
}

async function fetchImage(img: any): Promise<string> {
  const u = new URL(`${base()}/view`);
  u.searchParams.set('filename', img.filename);
  u.searchParams.set('subfolder', img.subfolder || '');
  u.searchParams.set('type', img.type || 'output');
  const res = await outboundBytes(u, { timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 });
  return res.body.toString('base64');
}

async function uploadImage(b64: string, filename: string): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' }), filename);
  form.append('overwrite', 'true');
  const data = (await outboundJson<any>(`${base()}/upload/image`, {
    method: 'POST', body: form, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024,
  })).body;
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function txt2img(p: TxtImgParams): Promise<string[]> {
  const eng = await resolveEngine();
  if (!eng) throw new Error('no image model available');
  const seed = p.seed && p.seed > 0 ? p.seed : randSeed();
  const graph = eng === 'krea' ? kreaTxt2Img(p, seed) : fluxTxt2Img(p, seed);
  return gpu.run('image', async () => {
    const id = await submit(graph);
    return Promise.all((await waitForImages(id)).map(fetchImage));
  });
}

export async function img2img(initB64: string, p: TxtImgParams & { denoising?: number; maskB64?: string }): Promise<string[]> {
  const eng = await resolveEngine();
  if (!eng) throw new Error('no image model available');
  const clean = (s: string) => s.replace(/^data:image\/\w+;base64,/, '');
  const seed = p.seed && p.seed > 0 ? p.seed : randSeed();
  const initName = await uploadImage(clean(initB64), `cbx_init_${Date.now()}.png`);
  const maskName = p.maskB64 ? await uploadImage(clean(p.maskB64), `cbx_mask_${Date.now()}.png`) : undefined;
  return gpu.run('image', () => img2imgInner(eng, p, seed, initName, maskName));
}

async function img2imgInner(eng: 'krea' | 'flux', p: any, seed: number, initName: string, maskName?: string): Promise<string[]> {
  let graph: any;
  if (eng === 'krea') {
    graph = kreaImg2Img({ ...p, maskName }, seed, initName);
  } else {
    // FLUX checkpoint img2img/inpaint
    const steps = p.steps || 20;
    graph = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: fluxCkpt } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negativePrompt || '', clip: ['4', 1] } },
      '20': { class_type: 'LoadImage', inputs: { image: initName } },
      '3': { class_type: 'KSampler', inputs: { seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: maskName ? 1 : (p.denoising ?? 0.75), model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['22', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'aerie_edit', images: ['8', 0] } },
    };
    if (maskName) {
      graph['21'] = { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } };
      graph['22'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['20', 0], vae: ['4', 2], mask: ['21', 0], grow_mask_by: 6 } };
    } else {
      graph['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['4', 2] } };
    }
  }
  const id = await submit(graph);
  return Promise.all((await waitForImages(id)).map(fetchImage));
}

export async function saveGenerated(userId: number, b64: string): Promise<{ filename: string; fullPath: string }> {
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  const filename = `gen_${userId}_${crypto.randomUUID()}.png`;
  const full = path.join(config.generatedDir, filename);
  const temporary = `${full}.partial`;
  try {
    await fsp.writeFile(temporary, Buffer.from(clean, 'base64'), { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, full);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { filename, fullPath: full };
}
