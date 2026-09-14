import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { statfsSync } from 'fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { startEventStream } from './chat.controller';

const run = promisify(exec);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

// hand-picked library — sizes are approximate download/VRAM footprints in GB
const LIBRARY = [
  { name: 'qwen3:8b', label: 'Qwen 3 8B', kind: 'chat', sizeGB: 5.2, blurb: 'Great all-rounder for chat, homework, and tool use. A strong default.' },
  { name: 'qwen3:4b', label: 'Qwen 3 4B', kind: 'chat', sizeGB: 2.6, blurb: 'Half the size, noticeably faster answers. Good for slower cards.' },
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', kind: 'chat', sizeGB: 2.0, blurb: 'Meta’s small model. Light and quick.' },
  { name: 'gemma3:4b', label: 'Gemma 3 4B', kind: 'chat', sizeGB: 3.3, blurb: 'Google’s compact model. Solid quality for its size.' },
  { name: 'deepseek-r1:8b', label: 'DeepSeek R1 8B', kind: 'chat', sizeGB: 5.2, blurb: 'A reasoning model — slower, thinks step by step.' },
  { name: 'gemma3:12b', label: 'Gemma 3 12B', kind: 'chat', sizeGB: 8.1, blurb: 'Google’s mid-size model. Noticeably smarter, needs a roomier card.' },
  { name: 'qwen3:14b', label: 'Qwen 3 14B', kind: 'chat', sizeGB: 9.3, blurb: 'Bigger brain for bigger cards.' },
  { name: 'qwen2.5vl:7b', label: 'Vision (Qwen 2.5-VL)', kind: 'vision', sizeGB: 6.0, blurb: 'Extension: lets the assistant see and answer questions about photos you attach.' },
];

function isAdmin(req: any) {
  if (req.user.role !== 'ADMIN') throw new ForbiddenException('Admins only');
}

@UseGuards(JwtAuthGuard)
@Controller()
export class ModelsController {
  constructor(private prisma: PrismaService) {}

  @Get('system/stats')
  async stats() {
    let gpu: any = null;
    try {
      const { stdout } = await run(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu,utilization.gpu --format=csv,noheader,nounits',
      );
      const [name, vramTotal, vramUsed, temp, util] = stdout.trim().split(', ');
      gpu = {
        name,
        vramTotalMB: +vramTotal,
        vramUsedMB: +vramUsed,
        tempC: +temp,
        utilPercent: +util,
      };
    } catch {}
    const disk = statfsSync('/');
    return {
      gpu,
      cpuLoad: os.loadavg()[0],
      cpuCores: os.cpus().length,
      ramTotalMB: Math.round(os.totalmem() / 1e6),
      ramFreeMB: Math.round(os.freemem() / 1e6),
      diskTotalGB: Math.round((disk.blocks * disk.bsize) / 1e9),
      diskFreeGB: Math.round((disk.bavail * disk.bsize) / 1e9),
      uptimeSec: Math.round(os.uptime()),
    };
  }

  // what's ready on this server — drives first-run setup and feature availability
  @Get('setup/status')
  async setupStatus() {
    let installed = new Set<string>();
    try {
      const tags: any = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
      installed = new Set(
        (tags.models ?? []).map((m: any) => m.name.replace(/:latest$/, '')),
      );
    } catch {}
    const chatReady = LIBRARY.some(
      (m) => m.kind === 'chat' && installed.has(m.name),
    );
    const visionAvailable = LIBRARY.some(
      (m) => m.kind === 'vision' && installed.has(m.name),
    );
    let imagesAvailable = false;
    try {
      const comfy = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';
      const r = await fetch(`${comfy}/system_stats`, {
        signal: AbortSignal.timeout(2000),
      });
      imagesAvailable = r.ok;
    } catch {}
    return {
      modelInstalled: chatReady,
      activeModel: chatReady ? await this.activeModel() : null,
      visionAvailable,
      imagesAvailable,
    };
  }

  @Get('models/library')
  async library() {
    const [tags, active] = await Promise.all([
      fetch(`${OLLAMA}/api/tags`).then((r) => r.json() as any),
      this.activeModel(),
    ]);
    const installed = new Set(
      (tags.models ?? []).map((m: any) => m.name.replace(/:latest$/, '')),
    );
    let vramGB = 8;
    try {
      const { stdout } = await run(
        'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      );
      vramGB = +stdout.trim() / 1024;
    } catch {}
    return {
      activeModel: active,
      vramGB: Math.round(vramGB * 10) / 10,
      models: LIBRARY.map((m) => ({
        ...m,
        installed: installed.has(m.name),
        active: m.name === active,
        fit:
          m.sizeGB <= vramGB * 0.78 ? 'recommended'
          : m.sizeGB <= vramGB * 1.02 ? 'tight'
          : 'too_big',
      })),
    };
  }

  // streams ollama's download progress straight through as SSE
  @Post('models/install')
  async install(@Req() req: any, @Body() body: any, @Res() res: Response) {
    isAdmin(req);
    const name = String(body.name ?? '');
    if (!LIBRARY.some((m) => m.name === name)) {
      res.status(400).json({ message: 'Not in the library' });
      return;
    }
    startEventStream(res);
    const emit = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    try {
      const pull = await fetch(`${OLLAMA}/api/pull`, {
        method: 'POST',
        body: JSON.stringify({ model: name, stream: true }),
      });
      if (!pull.ok || !pull.body) throw new Error(`ollama status ${pull.status}`);
      const reader = pull.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const j = JSON.parse(line);
          if (j.total && j.completed !== undefined) {
            emit({ type: 'progress', completed: j.completed, total: j.total, status: j.status });
          } else if (j.status) {
            emit({ type: 'status', status: j.status });
          }
          if (j.error) throw new Error(j.error);
        }
      }
      await this.prisma.installedModel.upsert({
        where: { name },
        create: { name },
        update: {},
      });
      // first chat model installed becomes the active one automatically
      const entry = LIBRARY.find((m) => m.name === name);
      if (entry?.kind === 'chat') {
        const existing = await this.prisma.setting.findUnique({
          where: { key: 'chat_model' },
        });
        if (!existing) {
          await this.prisma.setting.create({
            data: { key: 'chat_model', value: name },
          });
        }
      }
      emit({ type: 'done' });
    } catch (e: any) {
      emit({ type: 'error', message: e.message });
    }
    res.end();
  }

  @Post('models/active')
  async setActive(@Req() req: any, @Body() body: any) {
    isAdmin(req);
    const name = String(body.name ?? '');
    if (!LIBRARY.some((m) => m.name === name && m.kind === 'chat')) {
      throw new ForbiddenException('Not a chat model');
    }
    await this.prisma.setting.upsert({
      where: { key: 'chat_model' },
      create: { key: 'chat_model', value: name },
      update: { value: name },
    });
    return { activeModel: name };
  }

  @Delete('models/:name')
  async remove(@Req() req: any, @Param('name') name: string) {
    isAdmin(req);
    if (name === (await this.activeModel())) {
      throw new ForbiddenException('That model is currently active — switch first');
    }
    await fetch(`${OLLAMA}/api/delete`, {
      method: 'DELETE',
      body: JSON.stringify({ model: name }),
    });
    await this.prisma.installedModel.deleteMany({ where: { name } });
    return { ok: true };
  }

  private async activeModel(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'chat_model' } });
    return row?.value ?? process.env.CHAT_MODEL ?? 'qwen3:8b';
  }
}
