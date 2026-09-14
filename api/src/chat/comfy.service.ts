import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { execFile as execFileCb } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const COMFY = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const CKPT_FAST = process.env.SD_CHECKPOINT ?? 'RealVisXL_Lightning.safetensors';
const CKPT_BEST = process.env.SD_CHECKPOINT_HQ ?? 'RealVisXL_V5.safetensors';

export const IMAGES_DIR =
  process.env.IMAGES_DIR ?? path.join(process.env.HOME ?? '/tmp', 'circuit-barn', 'data', 'images');

const NEGATIVE =
  '(watermark, text, caption, logo, signature, stock photo, getty images:1.4), blurry, lowres, bad anatomy, deformed, extra people, duplicate, jpeg artifacts';

export type Quality = 'fast' | 'best';
export interface Size {
  width: number;
  height: number;
}
export interface SceneOpts {
  swap?: boolean;
  quality?: Quality;
  onStage?: (text: string) => void;
  personName?: string;
  size?: Size;
}
const SQUARE: Size = { width: 1024, height: 1024 };

// which stage label a comfy node maps to, for live progress
const STAGE_BY_NODE: Record<string, string> = {
  '23': 'Studying the face',
  '3': 'Building the scene',
  '30': 'Matching the face',
  '41': 'Refining the face',
  '9': 'Finishing',
};

@Injectable()
export class ComfyService {
  private log = new Logger('Comfy');

  async generate(
    prompt: string,
    quality: Quality = 'fast',
    onStage?: (t: string) => void,
    size: Size = SQUARE,
  ): Promise<string> {
    await this.freeOllama();
    const workflow = this.txt2img(prompt, quality, size);
    if (quality === 'best' && (await this.hasNode('FaceDetailer'))) {
      this.appendDetailer(workflow, '8', prompt, quality);
    }
    return this.run(workflow, onStage);
  }

  async transform(sourceFile: string, prompt: string, strong = false): Promise<string> {
    await this.freeOllama();
    const uploaded = await this.uploadToComfy(sourceFile);
    return this.run(this.img2img(prompt, uploaded, strong ? 0.75 : 0.55));
  }

  // new scene, same face. instantid gets structure and resemblance from every
  // reference photo; for photo styles reactor swaps the real face on top; the
  // 'best' tier renders with the full checkpoint and re-renders the face
  // region at high resolution. photomaker is the fallback when nothing else
  // is installed.
  async faceScene(refFiles: string[], prompt: string, opts: SceneOpts = {}): Promise<string> {
    const quality = opts.quality ?? 'fast';
    const stage = opts.onStage ?? (() => {});
    await this.freeOllama();
    stage('Preparing');
    const uploaded: string[] = [];
    for (const f of refFiles.slice(0, 5)) uploaded.push(await this.uploadToComfy(f));

    const [instantId, reactor, detailer] = await Promise.all([
      this.hasNode('ApplyInstantID'),
      this.hasNode('ReActorFaceSwap'),
      this.hasNode('FaceDetailer'),
    ]);

    // instantid frames the output like the reference photo (a selfie forces a
    // close-up), so for photo styles the scene is composed first without it,
    // then the real face is swapped in (and, on 'best', re-rendered by the
    // detailer). an instantid refinement pass in between was tried and
    // dropped: it tended to conjure a second copy of the person.
    // cartoon styles keep instantid driving the whole render.
    const size = opts.size ?? SQUARE;
    let workflow: Record<string, any>;
    if (opts.swap && reactor) {
      workflow = this.txt2img(prompt, quality, size);
    } else if (instantId) {
      workflow = this.instantId(prompt, uploaded, quality, size);
    } else {
      workflow = this.photomaker(`portrait photo of a person photomaker ${prompt}`, uploaded[0], quality);
    }
    if (!workflow['10']) {
      workflow['10'] = { class_type: 'LoadImage', inputs: { image: uploaded[0] } };
    }

    let last = '8';
    if (opts.swap && reactor) {
      workflow['30'] = {
        class_type: 'ReActorFaceSwap',
        inputs: {
          enabled: true,
          input_image: ['8', 0],
          source_image: ['10', 0],
          swap_model: 'inswapper_128.onnx',
          facedetection: 'retinaface_resnet50',
          face_restore_model: 'GFPGANv1.4.pth',
          face_restore_visibility: quality === 'best' ? 0.6 : 1,
          codeformer_weight: 0.5,
          detect_gender_input: 'no',
          detect_gender_source: 'no',
          input_faces_index: '0',
          source_faces_index: '0',
          console_log_level: 1,
        },
      };
      last = '30';
    }
    if (quality === 'best' && detailer) {
      this.appendDetailer(workflow, last, prompt, quality, workflow['23'] ? '23' : undefined);
      last = '41';
    }
    workflow['9'].inputs.images = [last, 0];
    return this.run(workflow, stage);
  }

  private nodeCache = new Map<string, { at: number; ok: boolean }>();
  async hasNode(name: string): Promise<boolean> {
    const c = this.nodeCache.get(name);
    if (c && Date.now() - c.at < 60_000) return c.ok;
    let ok = false;
    try {
      const r = await fetch(`${COMFY}/object_info/${name}`, { signal: AbortSignal.timeout(3000) });
      const j: any = await r.json();
      ok = !!j[name];
    } catch {}
    this.nodeCache.set(name, { at: Date.now(), ok });
    return ok;
  }
  hasInstantId() {
    return this.hasNode('ApplyInstantID');
  }

  // most consumer cards can't hold a chat model and the image model at once,
  // so whatever ollama has loaded steps aside while we paint
  private async freeOllama() {
    try {
      const ps: any = await fetch(`${OLLAMA}/api/ps`).then((r) => r.json());
      for (const m of ps.models ?? []) {
        await fetch(`${OLLAMA}/api/chat`, {
          method: 'POST',
          body: JSON.stringify({ model: m.name, messages: [], keep_alive: 0 }),
        }).catch(() => {});
      }
    } catch {}
  }

  // ask comfy to let go of the gpu. the face-swap models hold vram outside
  // comfy's own cache and ignore /free, so if the card is still mostly full
  // afterwards we bounce the service — on an 8GB card the chat model can't
  // load next to a leaked pipeline.
  private async freeComfy() {
    await fetch(`${COMFY}/free`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).catch(() => {});
    try {
      const stats: any = await fetch(`${COMFY}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.json());
      const dev = stats.devices?.[0];
      if (dev && dev.vram_free / dev.vram_total < 0.5) {
        this.log.warn(
          `comfy still holding ${((1 - dev.vram_free / dev.vram_total) * 100).toFixed(0)}% of vram after /free — restarting it`,
        );
        await execFile('sudo', ['-n', 'systemctl', 'restart', 'comfyui']);
      }
    } catch {}
  }

  // submit, follow node-by-node progress over the websocket, collect the image
  private async run(workflow: Record<string, unknown>, onStage?: (t: string) => void): Promise<string> {
    const clientId = randomUUID();
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${COMFY.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'executing' && msg.data?.node) {
            const label = STAGE_BY_NODE[msg.data.node];
            if (label && onStage) onStage(label);
          }
        } catch {}
      };
      ws.onerror = () => {};
    } catch {
      ws = null;
    }

    const res = await fetch(`${COMFY}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!res.ok) {
      const body = await res.text();
      this.log.error(`comfy rejected job: ${body.slice(0, 400)}`);
      throw new Error(`comfy rejected the job (${res.status})`);
    }
    const { prompt_id } = (await res.json()) as any;

    try {
      const started = Date.now();
      for (;;) {
        if (Date.now() - started > 420_000) throw new Error('image timed out');
        await new Promise((r) => setTimeout(r, 1500));
        const h = await fetch(`${COMFY}/history/${prompt_id}`).then((r) => r.json() as any);
        const entry = h[prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') throw new Error('comfy job failed');
        const outputs = entry.outputs ?? {};
        for (const nodeId of Object.keys(outputs)) {
          const img = outputs[nodeId].images?.[0];
          if (img) {
            const bytes = await fetch(
              `${COMFY}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=${img.type ?? 'output'}`,
            ).then((r) => r.arrayBuffer());
            await fs.mkdir(IMAGES_DIR, { recursive: true });
            const name = `${randomUUID()}.png`;
            await fs.writeFile(path.join(IMAGES_DIR, name), Buffer.from(bytes));
            this.log.log(`image ready: ${name} (${(bytes.byteLength / 1024).toFixed(0)}kb)`);
            await this.freeComfy();
            return name;
          }
        }
      }
    } finally {
      try {
        ws?.close();
      } catch {}
    }
  }

  private async uploadToComfy(filePath: string): Promise<string> {
    const data = await fs.readFile(filePath);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), path.basename(filePath));
    const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) throw new Error('could not hand the image to comfy');
    const j = (await res.json()) as any;
    return j.name;
  }

  private sampler(quality: Quality) {
    return quality === 'best'
      ? { steps: 26, cfg: 4.5, sampler_name: 'dpmpp_2m', scheduler: 'karras' }
      : { steps: 9, cfg: 2, sampler_name: 'dpmpp_sde', scheduler: 'karras' };
  }

  private base(prompt: string, quality: Quality, size: Size = SQUARE) {
    return {
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: quality === 'best' ? CKPT_BEST : CKPT_FAST },
      },
      '5': {
        class_type: 'EmptyLatentImage',
        inputs: { width: size.width, height: size.height, batch_size: 1 },
      },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'cb', images: ['8', 0] } },
    } as Record<string, any>;
  }

  private txt2img(prompt: string, quality: Quality, size: Size = SQUARE) {
    const w = this.base(prompt, quality, size);
    w['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 1e15),
        ...this.sampler(quality),
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    };
    return w;
  }

  // several reference photos get batched so instantid averages the identity
  private instantId(prompt: string, imageNames: string[], quality: Quality, size: Size = SQUARE) {
    const w = this.base(prompt, quality, size);
    imageNames.forEach((name, i) => {
      w[i === 0 ? '10' : `10_${i}`] = { class_type: 'LoadImage', inputs: { image: name } };
    });
    let ref: [string, number] = ['10', 0];
    for (let i = 1; i < imageNames.length; i++) {
      w[`11_${i}`] = {
        class_type: 'ImageBatch',
        inputs: { image1: ref, image2: [`10_${i}`, 0] },
      };
      ref = [`11_${i}`, 0];
    }
    w['20'] = { class_type: 'InstantIDModelLoader', inputs: { instantid_file: 'ip-adapter.bin' } };
    w['21'] = { class_type: 'InstantIDFaceAnalysis', inputs: { provider: 'CPU' } };
    w['22'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: 'instantid-controlnet.safetensors' } };
    w['23'] = {
      class_type: 'ApplyInstantID',
      inputs: {
        instantid: ['20', 0],
        insightface: ['21', 0],
        control_net: ['22', 0],
        image: ref,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        weight: quality === 'best' ? 0.75 : 0.8,
        start_at: 0,
        end_at: 1,
      },
    };
    w['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 1e15),
        ...this.sampler(quality),
        denoise: 1,
        model: ['23', 0],
        positive: ['23', 1],
        negative: ['23', 2],
        latent_image: ['5', 0],
      },
    };
    return w;
  }

  // crop the detected face, re-render it at high res, paste it back
  private appendDetailer(
    w: Record<string, any>,
    imageNode: string,
    prompt: string,
    quality: Quality,
    instantIdNode?: string,
  ) {
    w['40'] = {
      class_type: 'UltralyticsDetectorProvider',
      inputs: { model_name: 'bbox/face_yolov8m.pt' },
    };
    w['41'] = {
      class_type: 'FaceDetailer',
      inputs: {
        image: [imageNode, 0],
        model: instantIdNode ? [instantIdNode, 0] : ['4', 0],
        clip: ['4', 1],
        vae: ['4', 2],
        guide_size: 512,
        guide_size_for: true,
        max_size: 768,
        seed: Math.floor(Math.random() * 1e15),
        steps: quality === 'best' ? 16 : 8,
        cfg: quality === 'best' ? 4 : 2,
        sampler_name: quality === 'best' ? 'dpmpp_2m' : 'dpmpp_sde',
        scheduler: 'karras',
        positive: instantIdNode ? [instantIdNode, 1] : ['6', 0],
        negative: instantIdNode ? [instantIdNode, 2] : ['7', 0],
        denoise: 0.4,
        feather: 8,
        noise_mask: true,
        force_inpaint: true,
        bbox_threshold: 0.5,
        bbox_dilation: 10,
        bbox_crop_factor: 3,
        sam_detection_hint: 'center-1',
        sam_dilation: 0,
        sam_threshold: 0.93,
        sam_bbox_expansion: 0,
        sam_mask_hint_threshold: 0.7,
        sam_mask_hint_use_negative: 'False',
        drop_size: 10,
        bbox_detector: ['40', 0],
        wildcard: '',
        cycle: 1,
      },
    };
    w['9'].inputs.images = ['41', 0];
  }

  private photomaker(prompt: string, imageName: string, quality: Quality) {
    const w = this.base(prompt, quality);
    w['10'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    w['12'] = { class_type: 'PhotoMakerLoader', inputs: { photomaker_model_name: 'photomaker-v1.bin' } };
    w['13'] = {
      class_type: 'PhotoMakerEncode',
      inputs: { photomaker: ['12', 0], image: ['10', 0], clip: ['4', 1], text: prompt },
    };
    w['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 1e15),
        ...this.sampler(quality),
        steps: quality === 'best' ? 26 : 14,
        cfg: quality === 'best' ? 4.5 : 3,
        denoise: 1,
        model: ['4', 0],
        positive: ['13', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    };
    return w;
  }

  private img2img(prompt: string, imageName: string, denoise = 0.55) {
    const w = this.base(prompt, 'fast');
    w['10'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    w['11'] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } };
    w['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 1e15),
        steps: 8,
        cfg: 2,
        sampler_name: 'dpmpp_sde',
        scheduler: 'karras',
        denoise,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['11', 0],
      },
    };
    return w;
  }
}
