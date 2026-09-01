<script setup lang="ts">
/**
 * 首页宇宙背景（Canvas 实时渲染，非 CSS 贴图）
 *
 * 主题联动（替代旧版固定深色星空）：
 *  - 暗黑模式 → 黑洞：开普勒吸积盘（内缘白热、外缘蓝紫）、多普勒聚束（迎面一侧更亮）、
 *    光子环、事件视界遮挡（先画盘背侧 → 视界 → 盘前侧）、背景星引力透镜畸变。
 *  - 浅色模式 → 白洞：黑洞的时间反演 —— 同样的倾斜盘面几何、同尺寸核心，样式相反：
 *    白核（= 视界半径 R）+ 反光子环（= 1.42R，黑环而非橙环），物质从核心向外喷射、
 *    减速并淡出；背景为以白洞为圆心的径向渐变（核心周围深蓝 → 向外渐变到白色），
 *    发光星环 + 漂浮光尘 + 点缀星；粒子核心淡入、全程饱满不渐隐、飞出屏幕才循环，
 *    外圈渐变深蓝紫。
 *  - 核心位于页面下方（0.74h），避开欢迎区/卡片/引导文字；鼠标互动：核心跟随鼠标缓动，
 *    白洞核心附近粒子被鼠标"能量斥力"偏转，鼠标悬停白洞上时全部粒子加速爆发（默认缓速喷射）；
 *    黑洞相反——鼠标附近的粒子加速旋转并被吸入，鼠标悬停在黑洞上时整盘粒子加速旋转、
 *    加速坠入视界（"吞噬"）；主题切换时两套场景交叉淡入淡出。
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
// 鼠标是否真正移动过（初始未移动时不启用互动，粒子保持原速）
let mouseActive = false;
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
  /** 被吸入粒子：从外围沿径向快速坠入视界（明显"吸进去"的效果） */
  infall: [] as DiskParticle[],
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
  /** 出生年龄 0..1：从核心喷出时 0，逐渐增长；用于淡入（连续涌现，无跳变） */
  age: number;
}

interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  tw: number;
  depth: number;
  /** 光尘颜色（淡蓝白，低透明漂浮） */
  color: [number, number, number];
}

const wh = {
  coreR: 42,
  K: 0.0007,
  particles: [] as WhDiskParticle[],
  dust: [] as Dust[],
  /** 深空背景点缀星（白洞场景） */
  stars: [] as BgStar[],
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
  // 高密度（用户反馈：粒子偏少）
  const n = Math.min(1800, Math.round((w * h) / 1000));
  for (let i = 0; i < n; i++) {
    bh.disk.push(makeDiskParticle(-rand(0.0001, 0.00034)));
  }
  // 被吸入粒子：数量少但径向速度大，肉眼可见"从四周被吸进黑洞"（默认缓慢盘旋入内）
  bh.infall = [];
  const inf = Math.min(240, Math.round((w * h) / 4800));
  for (let i = 0; i < inf; i++) {
    bh.infall.push(makeDiskParticle(-rand(0.0007, 0.0015)));
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
  // 粒子加大（用户反馈：光亮孱弱）
  p.size = p.r > 1.05 ? rand(0.8, 2.2) : rand(1.2, 3.0);
  p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
  p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  return p;
}

function buildWhiteHole() {
  // 白洞核心比黑洞视界小：0.72R 减小 5/8（剩 3/8 = 0.27R，用户反馈核心仍偏大）
  wh.coreR = (bh.R * 0.72 * 3) / 8;
  wh.particles = [];
  // 粒子铺满整页：内区喷流（r<1）+ 外围喷发云（r 至 1.9，独立倾角）
  // 默认缓速喷射（约 4.5 秒一轮）；鼠标悬停白洞核心时全部粒子加速爆发（见 updateWhiteHole）
  const n = Math.min(2400, Math.round((w * h) / 600));
  for (let i = 0; i < n; i++) {
    wh.particles.push(makeWhParticle(rand(0.0035, 0.0065)));
  }
  wh.dust = [];
  const d = Math.min(200, Math.round((w * h) / 8000));
  for (let i = 0; i < d; i++) {
    wh.dust.push({
      x: rand(0, w),
      y: rand(0, h),
      vx: rand(-0.12, 0.12),
      vy: rand(-0.08, 0.08),
      size: rand(0.8, 2.6),
      tw: rand(0.5, 2),
      depth: rand(0.5, 1),
      color: [210, 228, 255],
    });
  }
  // 深空点缀星（浅色顶部区域因浅底自动不可见）
  wh.stars = [];
  const starCount = Math.min(60, Math.round((w * h) / 14000));
  for (let i = 0; i < starCount; i++) {
    wh.stars.push({
      x: rand(0, w),
      y: rand(0, h),
      size: rand(0.5, 1.4),
      tw: rand(0.4, 2),
      bright: Math.random() < 0.15,
      depth: rand(0.4, 1),
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
    age: 1,
  };
  // 白洞向四周喷射：tilt 取大范围（近圆），粒子铺满所有方向而非压成两端
  p.tilt = rand(0.5, 1);
  p.size = p.r > 1.05 ? rand(1.0, 2.2) : rand(1.6, 3.6);
  p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
  p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  return p;
}

// ================= 更新 =================

function updateBlackHole() {
  // 鼠标互动（与白洞"能量斥力"对称，黑洞是"引力吞噬"）：
  //  - 局部：鼠标附近的粒子加速旋转 + 加速吸入（vr 更负 = 更快坠向视界）
  //  - 全局：鼠标悬停在黑洞核心上 → 全部粒子加速旋转并加速被吸
  //  - 鼠标未移动过（mouseActive=false）时互动不生效，所有粒子保持原速
  const cxp = mouseActive ? mouse.x * window.innerWidth : -9999;
  const cyp = mouseActive ? mouse.y * window.innerHeight : -9999;
  const dCore = Math.hypot(cxp - holeX, cyp - holeY);
  const globalPull = clamp(1 - dCore / (bh.R * 2.5), 0, 1);
  const localR = Math.max(90, Math.min(w, h) * 0.16);

  for (const p of bh.disk) {
    const prevR = p.r;
    // 局部：鼠标附近的粒子加速旋转 + 加速内落（"被吸"）
    const dMouse = Math.hypot(p.sx - cxp, p.sy - cyp);
    const localPull = dMouse < localR ? 1 - dMouse / localR : 0;
    p.theta += bh.K / Math.pow(p.r, 1.5) + localPull * 0.02 + globalPull * 0.008;
    p.vr = Math.max(p.vr - localPull * 0.0012 - globalPull * 0.003, -0.025);
    p.r += p.vr;
    if (p.r <= 0.075) {
      // 坠入视界 → 重新捕获：部分从外围云补充（保持整页粒子密度）
      p.r = Math.random() < 0.45 ? rand(1.1, 1.9) : rand(0.92, 1.06);
      p.theta = rand(0, Math.PI * 2);
      p.vr = -rand(0.0001, 0.00034);
      p.tilt = p.r > 1.05 ? rand(0.15, 1) : rand(bh.inc * 0.75, bh.inc * 1.3);
      p.size = p.r > 1.05 ? rand(0.8, 2.2) : rand(1.2, 3.0);
    } else if (p.r <= 1.05 && prevR > 1.05) {
      // 外围云粒子落入盘面 → 收拢到薄盘倾角
      p.tilt = rand(bh.inc * 0.75, bh.inc * 1.3);
      p.size = rand(1.2, 3.0);
    }
    p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
    p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  }
  // 被吸入粒子：同样受鼠标引力（加速坠入），几乎纯径向
  for (const p of bh.infall) {
    const dMouse = Math.hypot(p.sx - cxp, p.sy - cyp);
    const localPull = dMouse < localR ? 1 - dMouse / localR : 0;
    p.theta +=
      (bh.K * 0.06) / Math.pow(Math.max(p.r, 0.2), 1.5) + localPull * 0.04 + globalPull * 0.012;
    p.vr = Math.max(p.vr - localPull * 0.004 - globalPull * 0.008, -0.06);
    p.r += p.vr; // vr 为负且大
    if (p.r <= 0.075) {
      // 坠入视界 → 从更外围重新出现，形成持续吸入流；重置为默认慢速
      p.r = rand(1.3, 1.9);
      p.theta = rand(0, Math.PI * 2);
      p.vr = -rand(0.0007, 0.0015);
      p.tilt = rand(0.25, 0.9);
      p.size = rand(1.0, 2.4);
    }
    p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
    p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
  }
}

function updateWhiteHole() {
  // 鼠标能量斥力仅在鼠标真正移动过后生效（初始保持原速）
  const cxp = mouseActive ? mouse.x * window.innerWidth : -9999;
  const cyp = mouseActive ? mouse.y * window.innerHeight : -9999;
  // 鼠标悬停白洞核心上 → 全部粒子加速喷发（速度对齐黑洞互动时的激烈观感）
  const dCore = Math.hypot(cxp - holeX, cyp - holeY);
  const globalBoost = clamp(1 - dCore / (wh.coreR * 2.5), 0, 1);
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
    // 出生年龄增长（淡入用，约 0.25 秒内完全显现）
    p.age = Math.min(1, p.age + 0.012);
    // 鼠标在白洞上：每帧给 vr 叠加加速（封顶 0.028，约 1 秒一轮爆发喷射，快一倍）
    p.vr = Math.min(p.vr + globalBoost * 0.002, 0.028);
    p.r += p.vr;
    p.vr *= 0.9998; // 喷射几乎不减速（保持高速锐利的喷流）
    p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
    p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
    // 粒子完全飞出屏幕（边缘外 20px）才循环重生 → 屏幕内永不消失
    if (p.sx < -20 || p.sx > w + 20 || p.sy < -20 || p.sy > h + 20) {
      // 从核心重新喷出（age 归零，在淡入区不可见处重生，视觉连续）
      p.r = rand(0.075, 0.1);
      p.theta = rand(0, Math.PI * 2);
      p.vr = rand(0.0035, 0.0065);
      p.tilt = rand(0.5, 1);
      p.size = rand(1.6, 3.6);
      p.age = 0;
      p.sx = holeX + p.r * bh.diskR * Math.cos(p.theta);
      p.sy = holeY + p.r * bh.diskR * Math.sin(p.theta) * p.tilt;
    } else if (p.r > 1.05 && prevR <= 1.05) {
      // 内区喷流散开到外围 → 保持大 tilt 铺满四周
      p.tilt = rand(0.5, 1);
      p.size = rand(1.0, 2.2);
    }
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

/** 白洞喷流粒子颜色：奶油暖白（温和）→ 淡蓝 → 蓝紫 → 深蓝紫 */
function whJetColor(rn: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [0, [255, 246, 224]],
    [0.28, [224, 226, 242]],
    [0.6, [192, 202, 246]],
    [0.82, [112, 102, 222]],
    [1, [72, 60, 202]],
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
  // 多普勒聚束：盘面前侧（朝观察者运动）更亮；外围云粒子略减亮，突出吸积盘主体
  const dopp = 1 + 0.5 * Math.sin(p.theta);
  const flick = 0.85 + 0.15 * Math.sin(now / 900 + p.phase);
  const a = alpha * (0.42 + 0.58 * rn) * dopp * flick * (p.r > 1.05 ? 0.7 : 1);
  const col = diskColor(rn);
  const tail = 8;
  // 速度拖尾（加粗提亮）
  ctx!.globalAlpha = Math.min(1, a);
  ctx!.strokeStyle = col;
  ctx!.lineWidth = p.size * 1.1;
  ctx!.beginPath();
  ctx!.moveTo(p.sx - vx * tail, p.sy - vy * tail);
  ctx!.lineTo(p.sx, p.sy);
  ctx!.stroke();
  // 亮点
  ctx!.fillStyle = col;
  ctx!.beginPath();
  ctx!.arc(p.sx, p.sy, p.size * 0.85, 0, Math.PI * 2);
  ctx!.fill();
  // 内盘炽热光晕（更亮更大）
  if (rn < 0.3) {
    ctx!.globalAlpha = Math.min(1, a * 0.6);
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 3.6, 0, Math.PI * 2);
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

  // 被吸入粒子：沿径向快速坠向核心，配色/画法与吸积盘环绕粒子一致
  // （diskColor 按半径渐变：外圈蓝紫 → 品红 → 橙 → 内圈白热），只是径向运动更快、拖尾更长
  ctx.globalCompositeOperation = 'lighter';
  for (const p of bh.infall) {
    const rn = clamp(p.r, 0.075, 1);
    // 屏幕空间速度（几乎纯径向向内）
    const vx = Math.cos(p.theta) * p.vr * bh.diskR;
    const vy = Math.sin(p.theta) * p.vr * bh.diskR * p.tilt;
    // 与吸积盘同款：多普勒聚束 + 闪烁 + 随半径透明度（提亮）
    const dopp = 1 + 0.5 * Math.sin(p.theta);
    const flick = 0.85 + 0.15 * Math.sin(now / 900 + p.phase);
    const a = alpha * (0.42 + 0.58 * rn) * dopp * flick;
    const col = diskColor(rn);
    const tail = 10;
    ctx!.globalAlpha = Math.min(1, a);
    ctx!.strokeStyle = col;
    ctx!.lineWidth = p.size * 1.1;
    ctx!.beginPath();
    ctx!.moveTo(p.sx - vx * tail, p.sy - vy * tail);
    ctx!.lineTo(p.sx, p.sy);
    ctx!.stroke();
    ctx!.fillStyle = col;
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 0.85, 0, Math.PI * 2);
    ctx!.fill();
    if (rn < 0.3) {
      // 近视界：炽热光晕（同吸积盘内盘，提亮）
      ctx!.globalAlpha = Math.min(1, a * 0.6);
      ctx!.beginPath();
      ctx!.arc(p.sx, p.sy, p.size * 3.6, 0, Math.PI * 2);
      ctx!.fill();
    }
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
  // 背景：以白洞为圆心的径向渐变 —— 深蓝只围绕核心一小圈（衬白色粒子），
  // 快速过渡到浅色，保证页面文字可读
  const g = ctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, Math.max(w, h));
  g.addColorStop(0, '#3a548f');
  g.addColorStop(0.18, '#7693c6');
  g.addColorStop(0.45, '#c0d4ef');
  g.addColorStop(0.8, '#eef4ff');
  g.addColorStop(1, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 核心冷白光晕（柔和，避免刺眼；半径缩小 1/3，超白范围收窄）
  const halo = ctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, Math.min(w, h) * 0.333);
  halo.addColorStop(0, 'rgba(255, 255, 255, 0.62)');
  halo.addColorStop(0.4, 'rgba(215, 230, 255, 0.28)');
  halo.addColorStop(1, 'rgba(160, 190, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  // 深空点缀星（浅色顶部区域因浅底自动不可见）
  ctx.globalCompositeOperation = 'source-over';
  for (const s of wh.stars) {
    const tw = 0.5 + 0.5 * Math.sin((now / 1000) * s.tw + s.x);
    ctx.globalAlpha = alpha * (0.3 + 0.5 * tw) * s.depth;
    ctx.fillStyle = s.bright ? '#ffffff' : '#cfe0ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
  }

  // 漂浮光尘（视差，淡蓝白漂浮）
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

  // 喷射粒子（普通覆盖混合；配色：近核纯白/炽白 → 外圈蓝紫，真实冷却渐变）
  // 精致渲染：白色高光芯 + 目标色主体 + 淡色光晕，三层发光球；拖尾细线
  ctx.globalCompositeOperation = 'source-over';
  for (const p of wh.particles) {
    const rn = clamp(p.r / 1.9, 0, 1);
    const wv = wh.K / Math.pow(Math.max(p.r, 0.1), 1.5);
    const tv = wv * p.r * bh.diskR;
    const vx = -Math.sin(p.theta) * tv + Math.cos(p.theta) * p.vr * bh.diskR;
    const vy = Math.cos(p.theta) * tv * p.tilt + Math.sin(p.theta) * p.vr * bh.diskR * p.tilt;
    const flick = 0.8 + 0.2 * Math.sin(now / 700 + p.phase);
    // 核心涌现（age 淡入）；粒子保持饱满亮度（不降）
    const fadeIn = Math.min(1, p.age * 6);
    const a = alpha * (0.62 + 0.38 * (1 - rn)) * (0.7 + 0.3 * flick) * fadeIn;
    const col = whJetColor(rn);
    const tail = 12;
    // 拖尾：细线，略淡，尾部渐隐感（高速 → 拉出壮观的放射状喷流尾迹）
    ctx!.globalAlpha = Math.min(1, a * 0.5);
    ctx!.strokeStyle = col;
    ctx!.lineWidth = Math.max(0.7, p.size * 0.65);
    ctx!.beginPath();
    ctx!.moveTo(p.sx - vx * tail, p.sy - vy * tail);
    ctx!.lineTo(p.sx, p.sy);
    ctx!.stroke();
    // 光晕层：大圆淡色（发光氛围）
    ctx!.globalAlpha = Math.min(1, a * 0.2);
    ctx!.fillStyle = col;
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 2.2, 0, Math.PI * 2);
    ctx!.fill();
    // 主体层：目标色圆（可见色块）
    ctx!.globalAlpha = Math.min(1, a * 0.95);
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 1.05, 0, Math.PI * 2);
    ctx!.fill();
    // 高光芯：柔和白点（点睛，发光球质感；不刺眼）
    ctx!.globalAlpha = Math.min(1, a);
    ctx!.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx!.beginPath();
    ctx!.arc(p.sx, p.sy, p.size * 0.42, 0, Math.PI * 2);
    ctx!.fill();
  }

  // 星环：环绕白核的黑色环带（渐变填充的圆环，非离散粒子；白核+黑环带，黑白相反观感）
  ctx.globalCompositeOperation = 'source-over';
  const beltPulse = 0.85 + 0.15 * Math.sin(now / 2200);
  // 用径向渐变画一个"环带"（外圆 - 内圆挖空 = annulus），内侧最深、向外渐隐 → 连续平滑
  const drawBelt = (r0: number, r1: number, peak: number) => {
    const g = ctx!.createRadialGradient(holeX, holeY, r0 * wh.coreR, holeX, holeY, r1 * wh.coreR);
    g.addColorStop(0, `rgba(216, 230, 255, ${peak * beltPulse * alpha})`);
    g.addColorStop(0.4, `rgba(216, 230, 255, ${peak * 0.9 * beltPulse * alpha})`);
    g.addColorStop(1, 'rgba(216, 230, 255, 0)');
    ctx!.fillStyle = g;
    ctx!.beginPath();
    ctx!.arc(holeX, holeY, r1 * wh.coreR, 0, Math.PI * 2);
    ctx!.arc(holeX, holeY, r0 * wh.coreR, 0, Math.PI * 2, true);
    ctx!.fill();
  };
  // 主环带（更亮更宽）+ 内环留卡西尼缝 + 最外一道渐隐的散带；不描边，避免明显线条
  drawBelt(1.5, 3.2, 0.95);
  drawBelt(1.72, 1.94, 0.5);
  drawBelt(3.2, 4.0, 0.25);

  // 高能核心（脉动 + 鼠标靠近增亮）——白核比黑洞视界小：白核 = 0.72R，反光子环 = 1.42×白核
  const prox = clamp(1 - Math.hypot(mouse.x - 0.5, mouse.y - 0.5) * 2.2, 0, 1);
  const pulse = 1 + 0.06 * Math.sin(now / 380);
  ctx.globalCompositeOperation = 'lighter';
  // 反光子环：与黑洞光子环同位置同粗细，颜色相反（黑环 + 深蓝外缘）——白核外一圈黑环
  const pr2 = wh.coreR * 1.42;
  const prGrad = ctx.createRadialGradient(holeX, holeY, pr2 * 0.94, holeX, holeY, pr2 * 1.12);
  prGrad.addColorStop(0, 'rgba(0, 2, 10, 0)');
  prGrad.addColorStop(0.5, 'rgba(0, 2, 10, 0.92)');
  prGrad.addColorStop(0.8, 'rgba(0, 2, 10, 1)');
  prGrad.addColorStop(1, 'rgba(0, 2, 10, 0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = prGrad;
  ctx.beginPath();
  ctx.arc(holeX, holeY, pr2 * 1.15, 0, Math.PI * 2);
  ctx.fill();
  // 外晕（半径缩小 1/3 至 ~1.33R，紧贴白核，超白范围收窄）
  const r1 = wh.coreR * 1.33 * pulse;
  const glow = ctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, r1);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  glow.addColorStop(0.3, `rgba(255, 255, 255, ${0.85 + prox * 0.05})`);
  glow.addColorStop(0.7, 'rgba(150, 190, 255, 0.4)');
  glow.addColorStop(1, 'rgba(120, 160, 240, 0)');
  ctx.globalAlpha = alpha * (0.62 + prox * 0.25);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(holeX, holeY, r1, 0, Math.PI * 2);
  ctx.fill();
  // 白核：与黑洞视界同半径的微蓝白圆（深空底上轮廓清晰，柔和不刺眼）
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f4f8ff';
  ctx.beginPath();
  ctx.arc(holeX, holeY, wh.coreR * pulse, 0, Math.PI * 2);
  ctx.fill();

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
  mouseActive = true;
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
