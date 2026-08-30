import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateModelConfigDto } from './dto/create-model-config.dto';
import { UpdateModelConfigDto } from './dto/update-model-config.dto';
import { ListModelsDto } from './dto/list-models.dto';

/** 返回给前端的配置（绝不包含明文 key，只给掩码） */
export interface SafeModelConfig {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  isDefault: boolean;
  apiKeyMasked: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 聊天实际使用的目标（解密后的 key） */
export interface ChatTarget {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** 模型名是否视觉模型（启发式：vision / VL / 4V / Omni / GLM-4V 等） */
export function isVisionModelName(model: string): boolean {
  return /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i.test(model);
}

/**
 * 用户模型配置（BYO 大模型 API）：
 * - apiKey 用 AES-256-GCM 加密落库，接口永远只返回掩码（sk-1234****abcd）；
 * - 聊天时按会话绑定的配置解密 key，用用户的 key/baseURL/model 出回答——token 用户买单；
 * - 测试连接：发一个最小补全请求验证 key/baseURL/model 可用。
 */
@Injectable()
export class ModelConfigService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  /** AES-256 密钥：优先取 env MODEL_KEY_SECRET（64 位 hex），否则由 JWT_SECRET 派生 */
  private get secret(): Buffer {
    const s = this.configService.get<string>('MODEL_KEY_SECRET');
    if (s && /^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
    return createHash('sha256')
      .update(this.configService.get<string>('JWT_SECRET', 'dev-secret'))
      .digest();
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  private decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    const decipher = createDecipheriv('aes-256-gcm', this.secret, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private mask(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 6)}****${key.slice(-4)}`;
  }

  private toSafe(c: {
    id: string;
    name: string;
    baseURL: string;
    apiKey: string;
    model: string;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): SafeModelConfig {
    let plain = '';
    try {
      plain = this.decrypt(c.apiKey);
    } catch {
      plain = '';
    }
    return {
      id: c.id,
      name: c.name,
      baseURL: c.baseURL,
      model: c.model,
      isDefault: c.isDefault,
      apiKeyMasked: this.mask(plain),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  /** 设为默认前先取消该用户其它默认 */
  private async clearDefault(userId: string) {
    await this.prisma.modelConfig.updateMany({
      where: { ownerId: userId, isDefault: true },
      data: { isDefault: false },
    });
  }

  async create(userId: string, dto: CreateModelConfigDto) {
    // 用户还没有任何配置时，第一条自动成为默认（省去手动勾选，保证"打开就能用"）
    const hasAny = await this.prisma.modelConfig.count({ where: { ownerId: userId } });
    const isDefault = dto.isDefault ?? hasAny === 0;
    if (isDefault) await this.clearDefault(userId);
    const created = await this.prisma.modelConfig.create({
      data: {
        ownerId: userId,
        name: dto.name.trim(),
        baseURL: (dto.baseURL ?? 'https://api.deepseek.com').trim(),
        apiKey: this.encrypt(dto.apiKey),
        model: dto.model.trim(),
        isDefault,
      },
    });
    return this.toSafe(created);
  }

  async list(userId: string): Promise<SafeModelConfig[]> {
    const configs = await this.prisma.modelConfig.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return configs.map((c) => this.toSafe(c));
  }

  private async findOwned(userId: string, id: string) {
    const config = await this.prisma.modelConfig.findFirst({
      where: { id, ownerId: userId },
    });
    if (!config) throw new NotFoundException('模型配置不存在');
    return config;
  }

  async update(userId: string, id: string, dto: UpdateModelConfigDto) {
    const config = await this.findOwned(userId, id);
    if (dto.isDefault && !config.isDefault) await this.clearDefault(userId);
    const updated = await this.prisma.modelConfig.update({
      where: { id },
      data: {
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.baseURL != null ? { baseURL: dto.baseURL.trim() } : {}),
        ...(dto.model != null ? { model: dto.model.trim() } : {}),
        ...(dto.isDefault != null ? { isDefault: dto.isDefault } : {}),
        // 传了新 key 才重加密（不传则保留原 key）
        ...(dto.apiKey ? { apiKey: this.encrypt(dto.apiKey) } : {}),
      },
    });
    return this.toSafe(updated);
  }

  async remove(userId: string, id: string) {
    await this.findOwned(userId, id);
    await this.prisma.modelConfig.delete({ where: { id } });
    return { success: true };
  }

  /** 测试连接：发最小补全请求，返回 ok/错误信息（不返回 key） */
  async test(userId: string, id: string) {
    const config = await this.findOwned(userId, id);
    const apiKey = this.decrypt(config.apiKey);
    try {
      const res = await fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, message: `接口返回 ${res.status}：${text.slice(0, 120)}` };
      }
      return { ok: true, message: '连接成功' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * 探测提供商模型列表（GET /models，OpenAI 兼容协议）：
   * 前端"模型名下拉选择"用，避免用户手写模型名打错（如 char）。
   * 创建时传 baseURL+apiKey（不落库）；编辑时传 configId 用已存的 key 探测。
   */
  async listRemoteModels(userId: string, dto: ListModelsDto) {
    let baseURL = dto.baseURL?.trim();
    let apiKey = dto.apiKey?.trim();
    if (dto.configId) {
      const config = await this.findOwned(userId, dto.configId);
      baseURL = config.baseURL;
      apiKey = this.decrypt(config.apiKey);
    }
    if (!baseURL || !apiKey) {
      throw new BadRequestException('请填写接口地址和 API Key（新建时），或选择已有配置（编辑时）');
    }
    const url = `${baseURL.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BadRequestException(
        `获取模型列表失败：接口返回 ${res.status} ${text.slice(0, 120)}`,
      );
    }
    const json = (await res.json().catch(() => null)) as unknown;
    // OpenAI 规范：{ data: [{ id, ... }] }；个别网关直接返回数组或字符串数组，兼容处理
    const data = Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: unknown[] }).data
      : Array.isArray(json)
        ? json
        : [];
    const ids = data
      .map((m: unknown) => {
        if (typeof m === 'string') return m;
        if (m && typeof m === 'object' && 'id' in m) return (m as { id: string }).id;
        return null;
      })
      .filter((x: string | null): x is string => !!x);
    return { models: [...new Set(ids)] };
  }

  /**
   * 聊天用：解析会话绑定的配置 → 解密 key → 返回目标；未绑定/不存在返回 null（用系统默认）。
   * 归属校验：配置不属于该用户则视为不存在（数据隔离）。
   */
  async resolveForChat(userId: string, configId?: string | null): Promise<ChatTarget | null> {
    if (!configId) return null;
    const config = await this.prisma.modelConfig.findFirst({
      where: { id: configId, ownerId: userId },
    });
    if (!config) return null;
    return {
      baseURL: config.baseURL,
      apiKey: this.decrypt(config.apiKey),
      model: config.model,
    };
  }

  /**
   * 解析用户的默认配置（BYO 强依赖：AI 功能优先用会话绑定，否则用默认配置，
   * 两者都没有 → 返回 null，调用方提示用户先绑定 Key）。
   */
  async resolveDefaultForUser(userId: string): Promise<ChatTarget | null> {
    const config = await this.prisma.modelConfig.findFirst({
      where: { ownerId: userId, isDefault: true },
    });
    if (!config) return null;
    return {
      baseURL: config.baseURL,
      apiKey: this.decrypt(config.apiKey),
      model: config.model,
    };
  }

  /**
   * 找用户的视觉模型配置（聊天发图片时自动路由用）：
   * 遍历用户全部配置，模型名含 vision/VL/4V/Omni 等关键字即视为视觉模型；
   * 默认配置优先。找不到 → null（调用方继续用原模型，报错时提示切换）。
   */
  async resolveVisionForUser(userId: string): Promise<ChatTarget | null> {
    const configs = await this.prisma.modelConfig.findMany({
      where: { ownerId: userId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    for (const c of configs) {
      if (isVisionModelName(c.model)) {
        return {
          baseURL: c.baseURL,
          apiKey: this.decrypt(c.apiKey),
          model: c.model,
        };
      }
    }
    return null;
  }
}
