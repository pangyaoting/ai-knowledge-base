# 阶段 4+：用户模型配置（BYO 大模型 API）

> 一句话：用户绑定自己的大模型 API Key（OpenAI 兼容协议），回答的 Token 由用户自己的 Key 计费——**平台零推理成本**。
> 对标：Cherry Studio / LobeChat 的"自带 Key"模式（它们是桌面端本地存 Key，我们是 Web 端加密存储）。

---

## 一、大白话：为什么做这个

没有 BYO 时，**每次用户提问烧的都是平台的钱**——来 100 个用户就养不起。BYO = **用户带粮，平台只出厨房**：

- 用户绑自己的 key，回答走用户的 baseURL/key/model，token 用户买单；
- 平台只承担检索（bge-m3 有免费额度）和服务器 → 项目真正跑得起、能免费开放；
- 用户还能选自己想用的模型（DeepSeek / GLM / 通义 / 硅基流动上的任何 OpenAI 兼容模型）；
- 对话直连用户自己的 key 到厂商，平台不经手明文 → 隐私卖点。

## 二、安全设计（面试重点）

| 设计点 | 方案 |
|--------|------|
| **Key 加密落库** | AES-256-GCM（密钥在服务端 env `MODEL_KEY_SECRET`，`openssl rand -hex 32` 生成；缺失时由 JWT_SECRET 派生兜底），库中只存 `iv:tag:密文` |
| **永不回传明文** | 所有接口只返回掩码 `sk-1234****abcd`；列表/详情/更新响应都不含 `apiKey` 字段 |
| **归属校验** | 配置只能本人增删改查/绑定，他人访问一律 404（数据隔离） |
| **编辑保留原 Key** | 更新时**不传 apiKey 则保留原 key**（前端表单留空），避免"改个名字把 key 丢了" |

## 三、实现拆解

### 1. 数据模型

```prisma
model ModelConfig {
  ownerId   String  // 归属
  name      String  // 备注名
  baseURL   String  // OpenAI 兼容地址
  apiKey    String  // AES-GCM 密文
  model     String  // 模型名
  isDefault Boolean // 新建会话默认使用（用户只有一个默认）
}
```
`ChatSession.modelConfigId?` 外键（ON DELETE SET NULL）——会话级绑定。

### 2. 接口

```
POST   /model-configs           新增（加密存储）
GET    /model-configs           列表（掩码 key）
PATCH  /model-configs/:id       更新（不传 apiKey 保留原 key）
DELETE /model-configs/:id       删除
POST   /model-configs/:id/test  测试连接（最小补全请求，只返回 ok/错误信息）
PATCH  /chat/sessions/:id/model 切换会话模型（null = 系统默认）
```

### 3. 聊天路由

```
askAndStream:
  会话绑定配置？ → 解密 key → new OpenAI({ baseURL, apiKey }) → 回答走用户 key
  未绑定        → 系统默认 DeepSeek
  辅助调用（查询改写/标题/图谱抽取）→ 仍走系统 key（成本极小，保证一致）
```

## 四、面试话术

- "BYO 是**架构级决策**不是功能：个人平台承担不起 token 成本，用户带 key 让项目零推理成本跑得起来；这也是 Cherry Studio 模式，但我们 Web 端把 key 加密落库而不是存浏览器。"
- "Key 安全：AES-256-GCM 加密存储、接口永不回传明文（只给掩码）、更新时留空保留原 key、他人 404——用户数据隔离是全线原则。"
- "设计取舍：嵌入/检索继续用系统硅基流动 key（免费额度），只让'回答'走用户 key——检索质量不随用户配置波动，成本也透明。"

## 五、自测清单（已实测）

- [x] 创建配置：响应只含掩码 key，无明文
- [x] 列表不含明文 key 字段
- [x] 测试连接：真实 key ✅ / 错误 key ❌
- [x] 会话绑定用户配置 → 正常流式回答（用户 key 计费）
- [x] 切到坏 key → 回答返回错误事件（路由生效的证明）
- [x] 他人访问配置 → 404
- [x] 设置页：列表/掩码/默认徽标/测试按钮
- [x] 聊天页：模型下拉（系统默认 + 用户配置）
