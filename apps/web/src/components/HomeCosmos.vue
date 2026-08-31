<script setup lang="ts">
/**
 * 首页宇宙背景（Canvas 实时渲染，非 CSS 贴图）
 *
 * 主题联动（替代旧版固定深色星空）：
 *  - 暗黑模式 → 黑洞：开普勒吸积盘（内缘白热、外缘蓝紫）、多普勒聚束（迎面一侧更亮）、
 *    光子环、事件视界遮挡（先画盘背侧 → 视界 → 盘前侧）、背景星引力透镜畸变。
 *  - 浅色模式 → 白洞：黑洞的时间反演 —— 同样的倾斜盘面几何、同尺寸核心，样式相反：
 *    白核（= 视界半径 R）+ 反光子环（= 1.42R，白环而非橙环），物质从核心向外喷射、
 *    旋转减速并淡出，配旋转光晕射线、周期性激波环、漂浮光尘。
 *  - 核心位于页面下方（0.74h），避开欢迎区/卡片/引导文字；鼠标互动：核心跟随鼠标缓动，
 *    白洞核心附近粒子被鼠标"能量斥力"偏转；主题切换时两套场景交叉淡入淡出。
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useTheme } from '@/composables/useTheme';

const { isDark } = useTheme();
const canvasRef = ref<HTMLCanvasElement | null>(null);

// ---------- 工具 ----------
const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let w = 0;
let h = 0;
let dpr = 1;
// 场景核心（黑洞/白洞位置）：随鼠标缓动
let holeX = 0;
let holeY = 0;
// 鼠标偏移 -1..1（平滑后）
let mx = 0;
let my = 0;
const mouse = { x: 0.5, y: 0.5 };
const targetMouse = { x: 0.5, y: 0.5 };
// 场景混合：0 = 黑洞，1 = 白洞
let blend = 0;
let targetBlend = 0;

// ---------- 黑洞场景 ----------
interface DiskParticle {
  /** 盘面半径（归一化，0.075=内缘，1=外缘） */
  r: number;
  theta: number;
  /** 径向速度（黑洞为负=内落） */
  vr: number;
  size: number;
  phase: number;
  /** 每粒子独立倾角（y 压缩比）：盘内≈inc，外围云 0.15~1，铺满整页 */
  tilt: number;
  sx: number;
  sy: number;
}
interface BgStar {
  x: number;
  y: number;
  size: number;
  tw: number;
  bright: boolean;
  depth: number;
}

const bh = {
  /** 事件视界半径（px） */
  R: 50,
  /** 外盘半径（px） */
  diskR: 220,
  /** 盘面倾角：y 方向压缩比 */
  inc: 0.3,
  /** 开普勒角速度系数 ω = K / r^1.5 */
  K: 0.00158,
  stars: [] as BgStar[],
  disk: [] as DiskParticle[],
};

// ---------- 白洞场景 ----------
interface WhDiskParticle {
  r: number;
  theta: number;
  /** 径向速度（白洞为正=向外喷射） */
  vr: number;
  size: number;
  phase: number;
  /** 每粒子独立倾角（y 压缩比）：内区≈inc，外围喷发云 0.15~1，铺满整页 */
  tilt: number;
  sx: number;
  sy: number;
  /** 喷射目标色（RGB）：粒子从白色渐变到该色，多色喷流 */
  color: [number, number, number];
}

/** 白洞喷流的饱和色板（大胆多彩：金黄/橙红/玫红/紫罗兰/天蓝/亮青/翠绿） */
const WH_JET_PALETTE: Array<[number, number, number]> = [
  [255, 186, 48], // 金黄
  [255, 110, 62], // 橙红
  [255, 82, 132], // 玫红
  [196, 96, 255], // 紫罗兰
  [86, 152, 255], // 天蓝
  [52, 208, 240], // 亮青
  [72, 224, 132], // 翠绿
];
interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  tw: number;
  depth: number;
  /** 光尘颜色（从色板取，淡色漂浮） */
  color: [number, number, number];
}

const wh = {
  coreR: 42,
  K: 0.0007,
  particles: [] as WhDiskParticle[],
  dust: [] as Dust[],
};

// ================= 构建 =================

function buildBlackHole() {
  bh.R = clamp(Math.min(w, h) * 0.062, 26, 110);
  bh.diskR = Math.min(w, h) * 0.46;
  bh.inc = w > h ? 0.3 : 0.26;
  bh.stars = [];
  const starCount = Math.min(260, Math.round((w * h) / 4200));
  for (let i = 0; i < starCount; i++) {
    bh.stars.push({
      x: rand(0, w),
      y: rand(0, h),
      size: rand(0.5, 1.9),
      tw: rand(0.4, 2.2),
      bright: Math.random() < 0.1,
      depth: rand(0.4, 1),
    });
  }
  bh.disk = [];
  // 粒子铺满整页：核心吸积盘（r<1）+ 外围旋转碎屑云（r 至 1.9，独立倾角）
  const n = Math.min(1100, Math.round((w * h) / 1500));
  for (let i = 0; i < n; i++) {
    bh.disk.push(makeDiskParticle(-rand(0.0001, 0.00034)));
  }
}

function makeDiskParticle(vr: number): DiskParticle {
  const p: DiskParticle = {
    r: Math.pow(rand(0.075, 1.9), 0.8),
    theta: rand(0, Math.PI * 2),
    vr,
    size: 0,
    phase: rand(0, Math.PI * 2),
    tilt: 0,
    sx: 0,
    sy: 0,
  };
  // 盘内保持薄盘倾角；外围云粒子独立倾角（0.15~1），使粒子云铺满页面
  p.tilt = p.r > 1.05 ? rand(0.15, 1) : rand(bh.inc * 0.75, bh.inc * 1.3);
  p.size = p.r > 1.05 ? rand(0.5, 1.5) : rand(0.8, 2.4);
  p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
  p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  return p;
}

function buildWhiteHole() {
  // 白洞核心比黑洞视界小一圈（视觉：白洞小巧 + 周围黑带环绕）；样式相反：黑↔白
  wh.coreR = bh.R * 0.72;
  wh.particles = [];
  // 粒子铺满整页：内区喷流（r<1）+ 外围喷发云（r 至 1.9，独立倾角）
  const n = Math.min(700, Math.round((w * h) / 2000));
  for (let i = 0; i < n; i++) {
    wh.particles.push(makeWhParticle(rand(0.0005, 0.0014)));
  }
  wh.dust = [];
  const d = Math.min(110, Math.round((w * h) / 15000));
  for (let i = 0; i < d; i++) {
    wh.dust.push({
      x: rand(0, w),
      y: rand(0, h),
      vx: rand(-0.12, 0.12),
      vy: rand(-0.08, 0.08),
      size: rand(0.8, 2.6),
      tw: rand(0.5, 2),
      depth: rand(0.5, 1),
      color: WH_JET_PALETTE[Math.floor(Math.random() * WH_JET_PALETTE.length)],
    });
  }
}

function makeWhParticle(vr: number): WhDiskParticle {
  const p: WhDiskParticle = {
    r: Math.pow(rand(0.08, 1.9), 0.7),
    theta: rand(0, Math.PI * 2),
    vr,
    size: 0,
    phase: rand(0, Math.PI * 2),
    tilt: 0,
    sx: 0,
    sy: 0,
    color: WH_JET_PALETTE[Math.floor(Math.random() * WH_JET_PALETTE.length)],
  };
  p.tilt = p.r > 1.05 ? rand(0.15, 1) : rand(bh.inc * 0.75, bh.inc * 1.3);
  p.size = p.r > 1.05 ? rand(0.6, 1.6) : rand(1, 2.6);
  p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
  p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  return p;
}

// ================= 更新 =================

function updateBlackHole() {
  for (const p of bh.disk) {
    const prevR = p.r;
    p.theta += bh.K / Math.pow(p.r, 1.5);
    p.r += p.vr;
    if (p.r <= 0.075) {
      // 坠入视界 → 重新捕获：部分从外围云补充（保持整页粒子密度）
      p.r = Math.random() < 0.45 ? rand(1.1, 1.9) : rand(0.92, 1.06);
      p.theta = rand(0, Math.PI * 2);
      p.vr = -rand(0.0001, 0.00034);
      p.tilt = p.r > 1.05 ? rand(0.15, 1) : rand(bh.inc * 0.75, bh.inc * 1.3);
      p.size = p.r > 1.05 ? rand(0.5, 1.5) : rand(0.8, 2.4);
    } else if (p.r <= 1.05 && prevR > 1.05) {
      // 外围云粒子落入盘面 → 收拢到薄盘倾角
      p.tilt = rand(bh.inc * 0.75, bh.inc * 1.3);
      p.size = rand(0.8, 2.4);
    }
    p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
    p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  }
}

function updateWhiteHole() {
  const cxp = mouse.x * window.innerWidth;
  const cyp = mouse.y * window.innerHeight;
  for (const p of wh.particles) {
    // 鼠标能量斥力：核心附近的粒子被弹开（互动）
    const dx = p.sx - cxp;
    const dy = p.sy - cyp;
    const d2 = dx * dx + dy * dy;
    if (d2 < 220 * 220 && d2 > 1) {
      const d = Math.sqrt(d2);
      const f = (1 - d / 220) * 0.12;
      p.theta += ((Math.atan2(dy, dx) - p.theta + Math.PI * 3) % (Math.PI * 2)) * f * 0.2;
      p.vr += f * 0.0016;
    }
    p.theta += wh.K / Math.pow(p.r, 1.5);
    const prevR = p.r;
    p.r += p.vr;
    p.vr *= 0.9994; // 喷射逐渐减速
    // 与黑洞对称：粒子喷发到整页（r 至 1.9）后消散重喷
    if (p.r > 1.9) {
      // 逃逸远去 → 从核心重新喷出
      p.r = rand(0.08, 0.16);
      p.theta = rand(0, Math.PI * 2);
      p.vr = rand(0.0005, 0.0014);
      p.tilt = rand(bh.inc * 0.75, bh.inc * 1.3);
      p.size = rand(1, 2.6);
    } else if (p.r > 1.05 && prevR <= 1.05) {
      // 内区喷流散开到外围云 → 独立倾角铺满整页
      p.tilt = rand(0.15, 1);
      p.size = rand(0.6, 1.6);
    }
    p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
    p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  }
  for (const d of wh.dust) {
    d.x += d.vx;
    d.y += d.vy;
    if (d.x < -20) d.x = w + 20;
    if (d.x > w + 20) d.x = -20;
    if (d.y < -20) d.y = h + 20;
    if (d.y > h + 20) d.y = -20;
  }
}

// ================= 绘制 =================

/** 黑洞吸积盘粒子颜色：内白热 → 金黄 → 橙 → 品红 → 蓝紫 */
function diskColor(rn: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [0, [255, 244, 224]],
    [0.25, [255, 214, 140]],
    [0.5, [255, 158, 96]],
    [0.75, [208, 108, 168]],
    [1, [136, 122, 232]],
  ];
  const t = clamp(rn, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return `rgb(${Math.round(lerp(c0[0], c1[0], k))},${Math.round(lerp(c0[1], c1[1], k))},${Math.round(lerp(c0[2], c1[2], k))})`;
    }
  }
  return 'rgb(136,122,232)';
}

/** 黑洞吸积盘单个粒子（含速度拖尾 + 多普勒聚束） */
function drawDiskDot(p: DiskParticle, now: number, alpha: number) {
  const rn = clamp(p.r, 0.075, 1);
  const wv = bh.K / Math.pow(rn, 1.5); // 角速度 rad/frame
  const tv = wv * rn * bh.diskR; // 切向速度 px/frame
  // 屏幕空间速度（含径向内落）
  const vx = -Math.sin(p.theta) * tv + Math.cos(p.theta) * p.vr * bh.diskR;
  const vy = Math.cos(p.theta) * tv * p.tilt + Math.sin(p.theta) * p.vr * bh.diskR * p.tilt;
  // 多普勒聚束：盘面前侧（朝观察者运动）更亮；外围云粒子减亮，突出吸积盘主体
  const dopp = 1 + 0.5 * Math.sin(p.theta);
  const flick = 0.85 + 0.15 * Math.sin(now / 900 + p.phase);
  const a = alpha * (0.32 + 0.55 * rn) * dopp * flick * (p.r > 1.05 ? 0.55 : 1);
  const col = diskColor(rn);
  const tail = 8;
  // 速度拖尾
  ctx!.globalAlpha = Math.min(1, a);
  ctx!.strokeStyle = col;
  ctx!.lineWidth = p.size;
  ctx!.beginPath();
  ctx!.moveTo(p.sx - vx * tail, p.sy - vy * tail);
  ctx!.lineTo(p.sx, p.sy);
  ctx!.stroke();
  // 亮点
  ctx!.fillStyle = col;
  ctx!.beginPath();
  ctx!.arc(p.sx, p.sy, p.size * 0.75, 0, Math.PI * 2);
  ctx!.fill();
  // 内盘炽热光晕
  if (rn < 0.3) {
    ctx!.globalAlpha = Math.min(1, a * 0.5);
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 3.2, 0, Math.PI * 2);
    ctx!.fill();
  }
}

function drawBlackHole(now: number, alpha: number) {
  if (!ctx) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  // 深空底色
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#04060f');
  bg.addColorStop(0.5, '#060a1c');
  bg.addColorStop(1, '#0a1128');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  // 核心幽蓝氛围
  const neb = ctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, Math.min(w, h) * 0.85);
  neb.addColorStop(0, 'rgba(40, 58, 140, 0.5)');
  neb.addColorStop(0.45, 'rgba(18, 26, 70, 0.32)');
  neb.addColorStop(1, 'rgba(6, 8, 20, 0)');
  ctx.fillStyle = neb;
  ctx.fillRect(0, 0, w, h);

  // 背景星 + 引力透镜畸变（靠近黑洞的星被推向外侧弯曲）
  ctx.globalCompositeOperation = 'source-over';
  const re = bh.R * 2.6;
  for (const s of bh.stars) {
    const sx0 = s.x - mx * s.depth * 16;
    const sy0 = s.y - my * s.depth * 11;
    const dx = sx0 - holeX;
    const dy = sy0 - holeY;
    const d = Math.hypot(dx, dy);
    let sx = sx0;
    let sy = sy0;
    if (d > re * 0.25) {
      const f = 1 + (re * re) / (d * d);
      const nd = Math.min(d * f, Math.max(w, h));
      sx = holeX + (dx / d) * nd;
      sy = holeY + (dy / d) * nd;
    }
    const tw = 0.5 + 0.5 * Math.sin((now / 1000) * s.tw + s.x);
    ctx.globalAlpha = alpha * (0.2 + 0.5 * tw) * s.depth;
    ctx.fillStyle = s.bright ? '#dbe7ff' : '#8fa3d0';
    ctx.beginPath();
    ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
    ctx.fill();
    if (s.bright) {
      ctx.globalAlpha = alpha * 0.1 * tw * s.depth;
      ctx.beginPath();
      ctx.arc(sx, sy, s.size * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 吸积盘背侧（y < holeY）
  ctx.globalCompositeOperation = 'lighter';
  for (const p of bh.disk) {
    if (p.sy >= holeY) continue;
    drawDiskDot(p, now, alpha);
  }

  // 光子环（视界外细亮环）
  ctx.globalCompositeOperation = 'lighter';
  const ringR = bh.R * 1.42;
  const pr = ctx.createRadialGradient(holeX, holeY, ringR * 0.94, holeX, holeY, ringR * 1.12);
  pr.addColorStop(0, 'rgba(255, 190, 110, 0)');
  pr.addColorStop(0.5, 'rgba(255, 232, 180, 0.9)');
  pr.addColorStop(0.78, 'rgba(255, 250, 235, 1)');
  pr.addColorStop(1, 'rgba(255, 170, 90, 0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pr;
  ctx.beginPath();
  ctx.arc(holeX, holeY, ringR * 1.15, 0, Math.PI * 2);
  ctx.fill();

  // 事件视界（纯黑）
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(holeX, holeY, bh.R, 0, Math.PI * 2);
  ctx.fill();
  // 视界边缘红移暗环
  const eg = ctx.createRadialGradient(holeX, holeY, bh.R * 0.85, holeX, holeY, bh.R * 1.02);
  eg.addColorStop(0, 'rgba(0, 0, 0, 0)');
  eg.addColorStop(1, 'rgba(255, 140, 70, 0.4)');
  ctx.fillStyle = eg;
  ctx.beginPath();
  ctx.arc(holeX, holeY, bh.R * 1.02, 0, Math.PI * 2);
  ctx.fill();

  // 吸积盘前侧（y >= holeY，叠在视界下缘）
  ctx.globalCompositeOperation = 'lighter';
  for (const p of bh.disk) {
    if (p.sy < holeY) continue;
    drawDiskDot(p, now, alpha);
  }

  // 暗角
  ctx.globalCompositeOperation = 'source-over';
  const vg = ctx.createRadialGradient(
    holeX,
    holeY,
    Math.min(w, h) * 0.35,
    holeX,
    holeY,
    Math.max(w, h) * 0.78,
  );
  vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vg.addColorStop(1, 'rgba(0, 0, 6, 0.5)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

function drawWhiteHole(now: number, alpha: number) {
  if (!ctx) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  // 明亮蓝空底色（偏深的天蓝，让白色喷射/核心有对比；slate-900 深色文字仍可读）
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#e8f1ff');
  g.addColorStop(0.5, '#c8e0ff');
  g.addColorStop(1, '#96bdf5');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 核心暖光晕（白核的底色，浅蓝天空上更亮）
  const halo = ctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, Math.min(w, h) * 0.72);
  halo.addColorStop(0, 'rgba(255, 250, 244, 1)');
  halo.addColorStop(0.4, 'rgba(240, 246, 255, 0.55)');
  halo.addColorStop(1, 'rgba(220, 235, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  // 漂浮光尘（视差，多彩淡色）
  ctx.globalCompositeOperation = 'source-over';
  for (const d of wh.dust) {
    const px = d.x - mx * d.depth * 10;
    const py = d.y - my * d.depth * 8;
    const tw = 0.5 + 0.5 * Math.sin((now / 900) * d.tw + d.x);
    ctx.globalAlpha = alpha * (0.14 + 0.22 * tw) * d.depth;
    ctx.fillStyle = `rgb(${d.color[0]},${d.color[1]},${d.color[2]})`;
    ctx.beginPath();
    ctx.arc(px, py, d.size, 0, Math.PI * 2);
    ctx.fill();
  }

  // 喷射粒子（普通覆盖混合：饱和色直接可见，不会被白色核心加色冲白 → 全程多彩）
  ctx.globalCompositeOperation = 'source-over';
  for (const p of wh.particles) {
    const rn = clamp(p.r / 1.9, 0, 1);
    const wv = wh.K / Math.pow(Math.max(p.r, 0.1), 1.5);
    const tv = wv * p.r * bh.diskR;
    const vx = -Math.sin(p.theta) * tv + Math.cos(p.theta) * p.vr * bh.diskR;
    const vy = Math.cos(p.theta) * tv * p.tilt + Math.sin(p.theta) * p.vr * bh.diskR * p.tilt;
    const flick = 0.8 + 0.2 * Math.sin(now / 700 + p.phase);
    // 近核（rn 小）alpha 高 → 从产生就呈现饱和色
    const a = alpha * (0.55 + 0.45 * (1 - rn)) * (0.6 + 0.4 * flick);
    const cr = p.color[0];
    const cg = p.color[1];
    const cb = p.color[2];
    const tail = 7;
    ctx!.globalAlpha = Math.min(1, a);
    ctx!.strokeStyle = `rgb(${cr},${cg},${cb})`;
    ctx!.lineWidth = p.size * 0.9;
    ctx!.beginPath();
    ctx!.moveTo(p.sx - vx * tail, p.sy - vy * tail);
    ctx!.lineTo(p.sx, p.sy);
    ctx!.stroke();
    ctx!.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 0.7, 0, Math.PI * 2);
    ctx!.fill();
    if (rn < 0.35) {
      ctx!.globalAlpha = Math.min(1, a * 0.35);
      ctx!.beginPath();
      ctx!.arc(p.sx, p.sy, p.size * 3, 0, Math.PI * 2);
      ctx!.fill();
    }
  }

  // 星环：环绕白核的连续暗色环带（渐变填充的圆环，非离散粒子）
  ctx.globalCompositeOperation = 'source-over';
  const beltPulse = 0.85 + 0.15 * Math.sin(now / 2200);
  // 用径向渐变画一个"环带"（外圆 - 内圆挖空 = annulus），深蓝黑、两端渐隐 → 连续平滑的星环
  // 渐变从环带内侧起笔：内侧最深、向外逐渐变淡，避免出现边缘硬线
  const drawBelt = (r0: number, r1: number, peak: number) => {
    const g = ctx!.createRadialGradient(holeX, holeY, r0 * wh.coreR, holeX, holeY, r1 * wh.coreR);
    g.addColorStop(0, `rgba(15, 24, 46, ${peak * beltPulse * alpha})`);
    g.addColorStop(0.4, `rgba(15, 24, 46, ${peak * 0.9 * beltPulse * alpha})`);
    g.addColorStop(1, 'rgba(15, 24, 46, 0)');
    ctx!.fillStyle = g;
    ctx!.beginPath();
    ctx!.arc(holeX, holeY, r1 * wh.coreR, 0, Math.PI * 2);
    ctx!.arc(holeX, holeY, r0 * wh.coreR, 0, Math.PI * 2, true);
    ctx!.fill();
  };
  // 主环带（更宽更深）+ 内环留卡西尼缝 + 最外一道渐隐的散带；不描边，避免明显线条
  drawBelt(1.5, 3.2, 0.95);
  drawBelt(1.72, 1.94, 0.5);
  drawBelt(3.2, 4.0, 0.25);

  // 高能核心（脉动 + 鼠标靠近增亮）——白核比黑洞视界小：白核 = 0.72R，反光子环 = 1.42×白核
  const prox = clamp(1 - Math.hypot(mouse.x - 0.5, mouse.y - 0.5) * 2.2, 0, 1);
  const pulse = 1 + 0.06 * Math.sin(now / 380);
  ctx.globalCompositeOperation = 'lighter';
  // 反光子环：与黑洞光子环同位置同粗细，颜色相反（白环 + 深蓝外缘，浅色天空上可见）
  const pr2 = wh.coreR * 1.42;
  const prGrad = ctx.createRadialGradient(holeX, holeY, pr2 * 0.94, holeX, holeY, pr2 * 1.12);
  prGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
  prGrad.addColorStop(0.5, 'rgba(255, 252, 244, 0.95)');
  prGrad.addColorStop(0.8, 'rgba(255, 255, 255, 1)');
  prGrad.addColorStop(1, 'rgba(120, 160, 235, 0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = prGrad;
  ctx.beginPath();
  ctx.arc(holeX, holeY, pr2 * 1.15, 0, Math.PI * 2);
  ctx.fill();
  // 外晕（收窄到 ~2R，与黑洞视界+光子环同视觉尺度，不再一大团）
  const r1 = wh.coreR * 2.0 * pulse;
  const glow = ctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, r1);
  glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
  glow.addColorStop(0.3, `rgba(255, 255, 255, ${0.95 + prox * 0.05})`);
  glow.addColorStop(0.7, 'rgba(150, 190, 255, 0.5)');
  glow.addColorStop(1, 'rgba(120, 160, 240, 0)');
  ctx.globalAlpha = alpha * (0.85 + prox * 0.3);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(holeX, holeY, r1, 0, Math.PI * 2);
  ctx.fill();
  // 白核：与黑洞视界同半径的纯白圆 + 深蓝描边（浅色天空上轮廓清晰）
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(holeX, holeY, wh.coreR * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(80, 130, 220, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

// ================= 主循环 =================

function draw(now: number) {
  if (!ctx) return;
  // 鼠标平滑 + 场景核心跟随
  mouse.x += (targetMouse.x - mouse.x) * 0.05;
  mouse.y += (targetMouse.y - mouse.y) * 0.05;
  mx = (mouse.x - 0.5) * 2;
  my = (mouse.y - 0.5) * 2;
  const off = Math.min(w, h) * 0.09;
  holeX = w / 2 + mx * off;
  // 核心位于页面下方（0.74h），避开上方欢迎区/卡片/引导文字
  holeY = h * 0.74 + my * off * 0.7;
  // 主题混合插值（交叉淡入淡出）
  blend += (targetBlend - blend) * 0.04;
  // 两套场景每帧都在演化（切换回来时立即可见）
  updateBlackHole();
  updateWhiteHole();
  if (blend < 0.995) drawBlackHole(now, 1 - blend);
  if (blend > 0.005) drawWhiteHole(now, blend);
}

function loop(now: number) {
  draw(now);
  raf = requestAnimationFrame(loop);
}

function onResize() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  w = rect.width;
  h = rect.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  holeX = w / 2;
  holeY = h * 0.74;
  buildBlackHole();
  buildWhiteHole();
  // 诊断：暴露粒子数量（黑洞,白洞），供自动化测试断言粒子规模
  canvas.dataset.particles = `${bh.disk.length},${wh.particles.length}`;
}

function onMouseMove(e: MouseEvent) {
  targetMouse.x = e.clientX / window.innerWidth;
  targetMouse.y = e.clientY / window.innerHeight;
}

watch(isDark, (v) => {
  // 暗黑 → 黑洞（blend 0）；浅色 → 白洞（blend 1）
  targetBlend = v ? 0 : 1;
});

onMounted(() => {
  targetBlend = isDark.value ? 0 : 1;
  blend = targetBlend;
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('mousemove', onMouseMove);
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousemove', onMouseMove);
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="pointer-events-none absolute inset-0 h-full w-full"
    aria-hidden="true"
  />
</template>
