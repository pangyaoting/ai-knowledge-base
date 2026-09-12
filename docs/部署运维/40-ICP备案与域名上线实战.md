# 40 · ICP备案与域名上线实战（aiknowbase.cn）

> 一句话：域名买好了（aiknowbase.cn，2026-09，腾讯云），实名、注册局复核、**ICP 备案全部通过**，
> 这篇记录**从域名到 HTTPS 上线的完整链路**——为什么大陆服务器必须备案、备案每一步在腾讯云哪里点、
> 备完怎么解析怎么上 HTTPS、以及**上线后必须补的合规动作**（备案号展示 / 公安联网备案 / AI 生成标识 / 隐私政策）。
> 状态：备案 ✅ 通过 → 解析 + HTTPS + 合规改造见 §五、§八、§九。

---

## 一、域名时间线（实际经历）

| 时间 | 事件 | 结果 |
|---|---|---|
| 09-xx | 腾讯云买域名 aiknowbase.cn（勾选自动续费 + 禁止转移锁 + 禁止更新锁） | ✅ 已付款锁定 |
| 09-xx | 域名实名信息模板审核（身份核实，快） | ✅ 通过 |
| 09-xx | 域名注册局复核（命名 + 实名复核，几分钟~1 天） | ✅ 状态"正常" |
| 09-xx | 提交 ICP 备案（本文档 §四） | ✅ 通过（粤ICP备2026135674号-1） |
| 09-12 | DNSPod 解析 A 记录：`@` → 159.75.52.172 | ✅ 生效（权威 DNS 实时可查） |
| 09-12 | 装 `nginx-http-only.conf`（80）+ 放行 80/443 | ✅ 域名上 200 |
| 09-12 | certbot 首次签发（--dry-run 先演练后正式） | ✅ 到 2026-12-10，`certbot.timer` 已建 |
| 09-12 | 装 `nginx.conf`（443 + 301）→ 站点上 HTTPS | ✅ http 301 / https 200，HSTS 300 起步 |
| 09-12 | 上线自检：续期 dry-run、证书链、合规页、SSE、页脚备案号 | ✅ 服务端全绿（见 §十） |
| 30 日内 | **公安联网备案**（beian.mps.gov.cn） | ⏳ 见 §八② |
| 以后 | www 补备案后 `--expand` 扩证书 | ⏳ www 尚未备案，本次不做 |

> www 未备案 → 本轮**只上主域名**。若 www 若解析出去会被拦，且 certbot 带 `-d www...` 会因为校验失败让**整条命令失败**（一张证书都拿不到）。

---

## 二、三个"审核/备案"别再混

| | 域名实名 | 域名注册复核 | **ICP 备案** |
|---|---|---|---|
| 审什么 | 持有人身份信息 | 域名命名 + 信息一致性 | 网站是否合法（大陆服务器必须） |
| 谁要求 | 工信部（域名实名制） | 注册局 | 工信部（服务器在大陆） |
| 时长 | 几分钟~1 天 | 几分钟~1 天 | **1~2 周**（管局人工） |
| 在哪办 | 腾讯云买域名时 | 自动 | 腾讯云控制台"网站备案" |
| 不过的后果 | 不能解析 | 不能解析 | 域名解析到大陆 IP 会被阻断 |

> **还有第四个：公安联网备案**（全国互联网安全管理服务平台 beian.mps.gov.cn）。
> ⚠️ 勘误：本文早前写的"个人小站可做可不做"**不准确** —— 《计算机信息网络国际联网安全保护管理办法》
> （公安部 33 号令）第 11/12 条要求，联网单位应自网络正式联通之日起 **30 日内**到所在地公安机关办理备案，
> 个人网站同样适用。免费、线上办、几分钟填完，**上线后 30 天内务必补**（见 §八②）。

---

## 三、备案前材料（先备齐，避免中途卡住）

| 材料 | 要求 |
|---|---|
| 身份证正反面照片 | 清晰、无反光、四角完整（腾讯云备案系统直接拍照/上传） |
| 手机号 | **实名制、和身份证同一个人**（管局发短信核验码） |
| 邮箱 | 常用邮箱，收备案通知 |
| 网站名称 | 个人备案建议"我的AI知识库"；**不能带**公司/商城/论坛/网 等词 |
| 网站备注 | 说明用途：个人学习项目、AI 知识库演示，无商业内容 |
| 域名 | aiknowbase.cn（腾讯云买的，备案系统自动带出，无需再传域名证书） |

---

## 四、腾讯云备案完整步骤（个人）

入口：腾讯云控制台搜索"**网站备案**" → beian.cloud.tencent.com

### 4.1 验证备案类型
- 选"**首次备案**"，填域名 `aiknowbase.cn`
- 主办者选"**个人**"（免费，无需营业执照）
- 系统提示服务器：选这台腾讯云轻量（备案时服务器需是腾讯云的，自动关联）

### 4.2 填写主体信息（个人）
- 姓名 / 身份证号 / 证件有效期
- 手机号（收验证码）+ 应急电话可填同号
- 邮箱
- 常住地址 / 通讯地址：**精确到门牌号**（省市区街道小区楼栋房号）

### 4.3 填写网站信息
- 网站名称：`我的AI知识库`（不含敏感词）
- 网站内容：个人空间 / 个人博客类（学习记录、AI 应用展示）
- 语言：简体中文
- 备注模板：
  > 本网站为个人学习项目，用于展示自研 AI 知识库应用（RAG 问答、文档管理），无商业经营、无不良信息。
- 前置审批：无（非新闻/医疗/教育等特殊行业）

### 4.4 上传证件 + 人脸核验
- 身份证正反面照片上传
- **负责人真实性核验**：用手机微信/腾讯云 APP 扫二维码 → 人脸识别 + 读数字 → 通过
- 核验时注意光线充足、免冠、不戴眼镜遮挡

### 4.5 腾讯云初审（1~2 个工作日）
- 腾讯云会**电话回访**核实信息，保持手机畅通
- 初审意见：一般让补充/修改备注，按提示改即可

### 4.6 工信部短信核验（关键，别漏！）
- 初审通过后，工信部给手机发一条验证码短信
- **24 小时内**登录 beian.miit.gov.cn 完成"短信核验"
- ⚠️ 超时未核验 = 备案申请作废，要重新提交初审

### 4.7 管局审核（1~2 周）
- 各省通信管理局人工审，等待即可（可随时在备案系统看进度）
- 期间网站继续用 http://IP 访问，不受影响

### 4.8 备案通过 ✅
- 收到短信/邮件：备案号（如 `粤ICP备2026xxxxxx号`）
- 之后才能做：解析 + HTTPS（见下文）

---

## 五、备案通过后：解析 + HTTPS

### 5.0 先核对一件容易翻车的事：www 是否也在备案域名列表里
备案时若只填了 `aiknowbase.cn` 而没填 `www.aiknowbase.cn`，**www 解析出去就是未备案域名**（会被拦）。
到腾讯云备案控制台核对"域名列表"，缺了就办"变更备案"补上，再解析 www。

### 5.1 DNSPod 解析（腾讯云域名控制台 → 解析）
```
类型  主机记录  记录值           TTL
A     @        159.75.52.172    600
A     www      159.75.52.172    600
```
解析生效验证：`nslookup aiknowbase.cn` → 再 `curl -I http://aiknowbase.cn`（能出 301/200 即通）。

### 5.2 nginx 换成域名 + 上 HTTPS
仓库有两份配置，**必须按顺序用**（顺序错了会卡在"证书签不出来"）：

| 文件 | 用途 | 何时用 |
|---|---|---|
| `deploy/nginx-http-only.conf` | 只有 80：站点先在域名上跑起来 + 提供 ACME 校验目录 | 签证书**之前**（也用于证书过期时应急回滚） |
| `deploy/nginx.conf` | 完整生产配置：443 证书 + HSTS + 80 自动 301 + 缓存/SSE | 证书签好**之后** |

> 为什么不能直接上完整配置：它的 443 段引用 `/etc/letsencrypt/live/aiknowbase.cn/fullchain.pem`，
> 证书不存在时 `nginx -t` 直接失败 → 新配置装不上 → 80 也没有 `/.well-known/acme-challenge/`
> → certbot 校验拿 404 → 永远签不出证书（先有鸡还是先有蛋）。

**本服务器实况（2026-09 核对，别再照抄 docs/02 的通用路径）**：

| 项 | 实际值 |
|---|---|
| nginx 版本 | **1.18.0** → 只能用 `listen 443 ssl http2;`（`http2 on;` 是 ≥1.25.1 的写法，1.18 会报错） |
| 站点配置 | `/etc/nginx/sites-available/kb` → `sites-enabled/kb`（**没有 default 站点**，不用删） |
| 前端根目录 | **`/opt/kb/ai-knowledge-base/apps/web/dist`** —— 不是 `/var/www/kb-web`（服务器上没这个目录）。指向项目内 dist 的好处：CI 每次部署重构完即生效，不需要额外 copy |
| 头像目录 | `/opt/kb/ai-knowledge-base/uploads/avatars/`（与后端 `AVATAR_DIR` 一致） |
| 后端 | pm2 进程名 `kb-server`，跑 `apps/server/dist/main.js`；`sudo -i` 后 PATH 缺 npm 全局 bin，先 `export PATH="$PATH:$(npm prefix -g)/bin"` 再用 pm2 |

要点：
- **80 端口要永久放行**（轻量云控制台防火墙 + ufw 两处）：certbot 每 90 天续期仍走 80 校验。
- nginx < 1.25.1 用 `listen 443 ssl http2;`，≥ 1.25.1 用 `listen 443 ssl;` + `http2 on;`。
- `proxy_buffering off` 等 SSE 配置**必须**保留在 443 的 server 块里，否则对话不再逐字输出。
- HSTS 模板里先给 `max-age=300`：`certbot renew --dry-run` 通过后再提到一年（下发长有效期后浏览器会
  在有效期内拒绝 HTTP，续期一旦出问题连应急退路都没了）。

### 5.3 收尾（代码侧已完成，见 §八）
- ✅ 页脚展示备案号并链接 `beian.miit.gov.cn`（`apps/web/src/config/site.ts` + `Layout.vue`）
- ✅ AI 生成内容显式标识（`components/common/AiBadge.vue`，挂在对话回答 / 研究报告 / 自主研究报告）
- ✅ 隐私政策 + 用户协议页（`/privacy`、`/terms`，游客可访问，页脚有入口）
- ⏳ 公安联网备案号（办完填 `POLICE_BEIAN` 即自动出现在页脚）
- ⏳ README / 简历里的 `http://IP` 换成 `https://aiknowbase.cn`

---

## 六、坑清单（预判 + 实际）

| 坑 | 说明 | 对策 |
|---|---|---|
| 短信核验超时 | 24h 不点 = 作废重来 | 初审过了盯紧手机短信 |
| 手机号和身份证不一致 | 管局直接退 | 用本人实名手机号 |
| 地址没写到门牌号 | 初审让补 | 一次写全 |
| 网站名称带"网/论坛" | 个人备案不让 | 用"我的AI知识库"这类 |
| 备案期间就解析域名 | 未备案域名指向大陆 IP 会被阻断 | **备案通过前不解析**，继续用 http://IP |
| 忘记证书续期 | Let's Encrypt 90 天 | certbot 自动续期即可，别手动删 |
| 忘底部备案号 | 抽查不达标 | 备案通过后加上 |
| `systemctl reload nginx` 显示成功但 443 没起来 | 实测：`ExecReload` code=0、新 worker 也起来了，但 `ss -lntp` 里**没有 443**、`curl http://` 仍是 200（应 301） | 直接 `sudo nginx -s reload`（给 master 发 HUP）后立即生效；诊断三连：`ss -lntp \| grep nginx`、`nginx -T \| grep 'listen 443'`、`nginx -s reload` |
| 只看 `curl https://` 失败就断定"证书/防火墙坏了" | 不同 HTTP 客户端的 TLS 栈差别很大：Windows SChannel（curl.exe / .NET）在受限环境下可能报 `SEC_E_NO_CREDENTIALS` / "基础连接已经关闭" | 换一个客户端复核（Node 的 `fetch` 走 OpenSSL、`openssl s_client` ），并用 `Test-NetConnection -Port 443` 确认 TCP 层是否真通 |
| 只为首次签发放行 80 | certbot 90 天后续期校验失败 → 证书过期、站点打不开 | 防火墙/安全组**永久**放行 80 |
| www 没一起备案 | www 解析出去被拦 | 备案域名列表补 www（变更备案） |
| 换服务器 IP 忘了变更备案 | 解析到未备案 IP → 被阻断 | 换 IP/接入商时同步办"变更备案" |

---

## 七、上线后长这样

```
用户浏览器
    │ https://aiknowbase.cn
    ▼
DNSPod 解析 → 159.75.52.172
nginx (443 TLS) ── certbot 证书
    │ /api → 反代 127.0.0.1:3000
    │ /assets /avatars
    ▼
pm2: kb-server + PostgreSQL + Redis（和 docs/39 完全一致，只多了一层域名和 TLS）
```

---

## 八、合规清单（备案通过后必须补的，别只做技术上线）

域名能访问 ≠ 合规。以下 6 条逐项对照，**前 4 条是法规硬要求**：

| # | 要求 | 依据 | 落实 |
|---|---|---|---|
| ① | **主页底部中央标明备案编号，并链接工信部备案系统** | 《非经营性互联网信息服务备案管理办法》第 13 条 | ✅ 页脚已展示 `粤ICP备2026135674号-1` 并链接 beian.miit.gov.cn（`apps/web/src/config/site.ts`，改号只动这一处） |
| ② | **公安联网备案**（上线后 30 日内） | 公安部 33 号令第 11/12 条 | ⏳ 到 beian.mps.gov.cn 登记 → 拿到编号填 `POLICE_BEIAN`，页脚自动出现 |
| ③ | **AI 生成内容显式标识** | 《人工智能生成合成内容标识办法》（**2025-09-01 施行**） | ✅ `AiBadge.vue` 挂在三处生成内容：对话回答（含流式中）、研究报告正文上方、自主研究结论顶部；页脚另有站级提示 |
| ④ | **个人信息处理告知同意** | 《个人信息保护法》 | ✅ 新增 `/privacy` + `/terms`（游客可访问，页脚入口）；注册收集邮箱、上传文档、BYO Key 存储等逐项披露，含"内容会发给哪些第三方"表 |
| ⑤ | 非经营性 | 个人备案不得从事经营性活动 | ✅ 无广告、无收费、无商城；页脚与协议均标注"个人非经营性学习项目" |
| ⑥ | 内容自查 | 互联网信息服务相关法规 | ⏳ 保持抽查习惯；用户协议已列禁止行为（违法内容、涉密、攻击、绕过限流） |

### 关于第三方披露（隐私政策里那张表不是凑数，是代码事实）
- 文档**向量化**走**系统 Key 的硅基流动** → 文档文本片段会离开本站服务器，必须披露；
- 检索**重排**同样发给硅基流动（问题 + 命中片段）；
- **生成回答/报告**发给**用户自己配置的模型服务商**（BYO Key，用用户自己的账号与费用）；
- 联网检索关键词发给 Tavily；邮箱验证码走 SMTP 服务商。
> 教程类项目最容易在这里踩坑：只写"我们重视你的隐私"，却不说文档片段会发给第三方 —— 那属于**告知不实**。

### 边界：生成式 AI 备案（个人办不了，要说清）
面向公众提供生成式 AI 服务，《生成式人工智能服务管理暂行办法》第 17 条对"具有舆论属性或社会动员能力"的服务
有安全评估 + 算法备案要求，而**算法备案/大模型备案的主体必须是企业**，个人无法办理。
本项目的安全姿态：**个人非经营性学习项目 + BYO Key（用户自己的账号与额度）+ 不面向不特定公众提供服务**，
并在显式标识、协议、隐私政策里如实说明。若要真正对外公开运营，需要企业主体另行备案 —— 这条不能靠"没人查"侥幸。

---

## 九、备案通过后的操作清单（照着做）

> 全部命令都可直接复制粘贴执行（变量只有两个：服务器 IP `159.75.52.172`、邮箱 `1701132825@qq.com`）。
> **顺序不能换**：先 80（`nginx-http-only.conf`）→ 签证书 → 再 443（`nginx.conf`）。
> 反过来装 443 会因为证书文件还不存在而 `nginx -t` 失败，certbot 走 80 校验也拿不到 404 目录，直接卡死。

```bash
# ══════════════════════════════════════════════════════════════════════════
# ① 解析：DNSPod → 域名 → 解析 → 添加记录
#    主机记录  类型  记录值            TTL
#    @         A     159.75.52.172     600
#    www       A     159.75.52.172     600   ← ⚠️ 仅当 www 也在备案域名列表里才加！
#
#    www 的坑：只备案了主域名时，解析 www 出去 = 未备案域名会被拦；更麻烦的是
#    下面 certbot 若带上 -d www.aiknowbase.cn，而 www 解析不通 → **整条签发命令失败**
#    （certbot 要求所有 -d 域名都通过校验，一个失败就一张证书都拿不到）。
#    所以策略：**先只上主域名**；www 确认已备案后，用 --expand 追加（见 ④ 备注）。
# ══════════════════════════════════════════════════════════════════════════
nslookup aiknowbase.cn 8.8.8.8        # 期望返回 159.75.52.172

# ══════════════════════════════════════════════════════════════════════════
# ② 放行端口（**先放行再签证书**，否则 ACME 校验被防火墙挡掉）
#    腾讯云轻量：控制台 → 防火墙 → 添加规则 TCP 80、TCP 443（永久）
# ══════════════════════════════════════════════════════════════════════════
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw status

# ══════════════════════════════════════════════════════════════════════════
# ③ 先装「只有 80」的最小配置：站点在域名上先跑起来 + 提供 ACME 校验目录
# ══════════════════════════════════════════════════════════════════════════
cd /opt/kb/ai-knowledge-base
sudo rm -f /etc/nginx/sites-enabled/default          # 关掉 nginx 默认站点，避免抢 80
sudo cp deploy/nginx-http-only.conf /etc/nginx/sites-available/kb
sudo ln -sf /etc/nginx/sites-available/kb /etc/nginx/sites-enabled/kb
sudo nginx -t && sudo systemctl reload nginx
curl -I http://aiknowbase.cn                         # 期望 200

# ══════════════════════════════════════════════════════════════════════════
# ④ 签证书（webroot 模式：不用停 nginx；续期也自动走这条）
# ══════════════════════════════════════════════════════════════════════════
sudo apt update && sudo apt install -y certbot
sudo mkdir -p /var/www/certbot
# 只签主域名（www 确认已备案后：把下面命令换成同一个命令 + --expand -d www.aiknowbase.cn）
sudo certbot certonly --webroot -w /var/www/certbot \
     -d aiknowbase.cn \
     --email 1701132825@qq.com --agree-tos --no-eff-email
# 期望输出：Successfully received certificate.
#   Certificate is saved at: /etc/letsencrypt/live/aiknowbase.cn/fullchain.pem
sudo ls /etc/letsencrypt/live/aiknowbase.cn/         # 必须有 fullchain.pem + privkey.pem
# 以后 www 备案通过要补上（会自动扩成同一张证书，不用重签）：
#   sudo certbot certonly --webroot -w /var/www/certbot --expand \
#        -d aiknowbase.cn -d www.aiknowbase.cn --email 1701132825@qq.com --agree-tos

# ══════════════════════════════════════════════════════════════════════════
# ⑤ 证书就位后再换完整配置（443 + 80 自动 301），此刻 nginx -t 才会通过
# ══════════════════════════════════════════════════════════════════════════
sudo cp deploy/nginx.conf /etc/nginx/sites-available/kb
sudo nginx -t && sudo systemctl reload nginx
curl -I http://aiknowbase.cn                         # 期望 301 → https://
curl -I https://aiknowbase.cn                        # 期望 200

# ══════════════════════════════════════════════════════════════════════════
# ⑥ 验证证书与自动续期（这一步别省：续期坏了 90 天后站点直接打不开）
# ══════════════════════════════════════════════════════════════════════════
echo | openssl s_client -connect aiknowbase.cn:443 -servername aiknowbase.cn 2>/dev/null \
  | openssl x509 -noout -subject -dates              # 看颁发者 + 有效期
sudo certbot renew --dry-run                         # 期望 Congratulations, all simulated renewals succeeded
systemctl list-timers | grep -i certbot              # 确认有自动续期定时器

# ══════════════════════════════════════════════════════════════════════════
# ⑦ 上线自检（curl 能过的，浏览器再走一遍）
# ══════════════════════════════════════════════════════════════════════════
curl -sI https://aiknowbase.cn | grep -i strict-transport   # HSTS 头存在
curl -s -o /dev/null -w 'privacy=%{http_code}\n' https://aiknowbase.cn/privacy   # 200（游客可访问）
curl -s -o /dev/null -w 'terms=%{http_code}\n'   https://aiknowbase.cn/terms     # 200
curl -s -o /dev/null -w 'api=%{http_code}\n'     https://aiknowbase.cn/api/docs  # Swagger
# 浏览器手测三件事：
#   · 对话页回答是否**逐字流式**输出（SSE 没被缓冲 → 否则是 proxy_buffering 没生效）
#   · 换头像是否立刻生效（/avatars no-store 生效 → 否则看到旧图）
#   · 页脚是否出现「粤ICP备2026135674号-1」且点击跳到 beian.miit.gov.cn；手机端是否"锁头"无混合内容告警

# ══════════════════════════════════════════════════════════════════════════
# ⑧ 稳定运行几天后：把 HSTS 从 300 秒提到一年
#    （deploy/nginx.conf 里 max-age=300 → 31536000，改完 reload；别在续期验证前就改）
# ══════════════════════════════════════════════════════════════════════════
sudo nano /etc/nginx/sites-available/kb && sudo nginx -t && sudo systemctl reload nginx

# ══════════════════════════════════════════════════════════════════════════
# ⑨ 上线后 30 日内：公安联网备案（免费）
#    beian.mps.gov.cn 注册 → 网站备案 → 填域名/服务器信息 → 拿到「粤公网安备 xxxxxxxx 号」
#    然后把编号填进 apps/web/src/config/site.ts 的 POLICE_BEIAN，页脚会自动多一行
# ══════════════════════════════════════════════════════════════════════════
```

### 排障速查（这几条最容易遇到）

| 现象 | 原因 | 处理 |
|---|---|---|
| 装完 `nginx.conf` 报 `cannot load certificate ... No such file` | 跳过了 ③④，证书还没签 | 先装 `nginx-http-only.conf` → 签证书 → 再换完整配置 |
| certbot 报 `Timeout during connect` / 403 | 80 没放行（云防火墙），或 `server_name` 没写域名 | ② 放行 80；确认 server_name 是 `aiknowbase.cn www.aiknowbase.cn` |
| `curl http://域名` 返回 nginx 默认页 | `sites-enabled/default` 还在抢 80 | `sudo rm -f /etc/nginx/sites-enabled/default` 后 reload |
| 证书签好但浏览器仍提示不安全 | 只签了主域名、访问的是 www（或反之） | 两个域名写在同一条 `-d` 命令里重签 |
| 站点能开但对话不逐字出字 | 443 段漏了 `proxy_buffering off` | 对照 `deploy/nginx.conf` 的 `/api/` 段补齐后 reload |
| 换了头像还是旧图 | `/avatars/` 的 alias 目录与后端写入目录不一致，或缺 no-store | 对齐 `AVATAR_DIR`（`<项目根>/uploads/avatars`） |
| 90 天后站点突然打不开 | 续期失败（80 被关/证书目录被删） | `sudo certbot renew --force-renewal`，并保持 80 永久放行 |

> 邮箱：合规文本里的联系邮箱与备案/证书邮箱统一用 **1701132825@qq.com**
> （已写入 `apps/web/src/config/site.ts` 的 `CONTACT_EMAIL`；想换成域名邮箱改这一行即可）。

---

## 十、上线结果（2026-09-12 实测，公网视角）

服务端自检全绿：

| 项 | 实测值 |
|---|---|
| `http://aiknowbase.cn` | **301** → `https://aiknowbase.cn/` |
| `https://aiknowbase.cn/` | **200**，`Server: nginx/1.18.0`，`Strict-Transport-Security: max-age=300` |
| `https://aiknowbase.cn/privacy` · `/terms` | **200**（未登录可访问，合规要求） |
| `https://aiknowbase.cn/api/docs` | **200**（后端反代正常） |
| 证书 | `subject=CN=aiknowbase.cn`，`issuer=Let's Encrypt`，`notAfter=2026-12-10` |
| 续期 | `certbot renew --dry-run` → all simulated renewals succeeded；`certbot.timer` 已建（每天两跑） |
| 监听 | `0.0.0.0:80` + `0.0.0.0:443`（含 IPv6），后端 3000 不对外 |
| nginx | `enabled`（重启自启） |

**验证方法要点**：`curl.exe` / .NET 在本机受限环境下 SChannel 报 `SEC_E_NO_CREDENTIALS`，换 **Node `fetch`（OpenSSL）** 才能拿到真实结果 —— 这也说明"某个客户端连不上"不等于"服务端有问题"，先换客户端复核再改服务器。

浏览器侧（只有真人能验）待确认清单：锁头正常 → 页脚备案号可点 → 对话逐字流式 + `AI 生成` 标识 → 无痕窗口能开隐私政策 → 换头像即时生效。


