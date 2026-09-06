# 42 · 线上问题排查实录：NUL 崩溃与 CI 假绿

> 一句话：一次线上"对话回答落库崩溃"（PG 22P05），牵出**两个连环隐藏 bug**——
> ① 代码文件入库漏清洗 NUL 控制字符；② CI 部署"假绿"（GITHUB_OUTPUT 没写导致部署永远被跳过，绿了等于没部署）。
> 本篇记录完整排查链与修复，面试可整套复述。

---

## 一、现象

用户上传一个含隐藏 NUL 字符的 `14-综合案例.html`，在对话里问"解析每行代码"，
流式回答结束时落库崩溃，报错：

```
PostgresError { code: "22P05", message: "unsupported Unicode escape sequence",
                detail: Some("\\u0000 cannot be converted to text.") }
```

位置：`chat.service.ts` 助手消息落库（chatMessage.create）。

**知识点**：PostgreSQL 的 text 类型**明文禁止 NUL（\u0000）**——任何含 NUL 的字符串写入都会报 22P05。

## 二、排查链（为什么 NUL 能一路走到数据库）

梳理所有"文本进数据库"的路径，看哪些清洗了 NUL：

| 路径 | 清洗 NUL？ |
|---|---|
| 对话上传文件（chat.service extractFile） | ✅ 走 `cleanText` |
| 知识库入库·md/txt（document-processor） | ✅ 走 `cleanText` |
| 知识库入库·**代码/HTML**（document-processor） | ❌ **只 trim，漏清洗** |
| 模型回答落库（chat.service:421） | ❌ 无兜底 |

根因 1：`document-processor.service.ts` 对 code 类型只做 `replace(/\r\n/g,'\n').trim()`，
没删控制字符。用户把**整个主项目拖进知识库**，损坏的 html 走 code 路径入库，
NUL 存进了 chunk → 对话绑定该知识库提问 → 检索命中 → 模型复述含 NUL 的行 → 落库崩。

## 三、修复 1：源头清洗 + 落库兜底（双层）

1. `document-parser.ts` 新增导出 `sanitizeControlChars()`：
   ```ts
   export function sanitizeControlChars(raw: string): string {
     return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
   }
   ```
   `cleanText` 改为复用它（行为不变）。
2. `document-processor.service.ts` code 入库路径补 `sanitizeControlChars`。
3. `chat.service.ts` 落库兜底：用户消息、助手回答、引用 sources JSON 全部清洗
   （防模型输出偶发夹带）。
4. 新增 5 个单测（`document-parser.spec.ts`）验证 NUL 删除、保留 \t\n。

> 附带发现：PG 连 `chr(0)` 比较都禁止（`null character not permitted`）——
> 所以**库里从来不存在 NUL 脏数据**（写不进），清理 SQL 不需要。

## 四、修复 2：CI"假绿"（最大坑）

代码修好 push 后，线上**仍然复现**。排查发现：

- GitHub Actions run 显示 **Success，总时长仅 1m4s**——真部署（SSH + 装依赖 + 构建）
  不可能这么快 → deploy job 没真正执行。
- 服务器进程 uptime 75 小时不重启 → pm2 从没 restart。
- 服务器 dist `grep sanitizeControlChars` = 0 → 代码没到服务器。

真相：deploy.yml 的 "Check deploy config" 步骤：

```bash
# ❌ 错误写法：只 echo 到日志，没写进 GITHUB_OUTPUT
echo "deploy_enabled=true"
```

GitHub Actions 的步骤输出**必须写入 `$GITHUB_OUTPUT` 文件**才能被后续步骤读取。
上面写法导致 `steps.deploy-check.outputs.deploy_enabled` **恒为空** →
`if: ... == 'true'` 永远不成立 → "Deploy to server" 步骤**每次静默跳过**。
但 job 没有失败步骤 → **整体显示绿**。假绿持续了多次 push，部署从未生效。

修复：
```bash
echo "deploy_enabled=true" >> "$GITHUB_OUTPUT"   # ✅ 写进输出文件
echo "deploy_enabled=false" >> "$GITHUB_OUTPUT"
```

**教训：CI 绿 ≠ 部署成功。要看 deploy job 内部步骤是否真的执行（是否 skipped）。**

## 五、修复 3：部署权限（/tmp 旧文件覆盖）

修好 GITHUB_OUTPUT 后 deploy 真跑了，又挂在服务器端：

```
/tmp/kb.tar.gz: Permission denied
```

原因：`/tmp/kb.tar.gz` 是 9 月 1 日手动部署遗留、属主 `ubuntu:ubuntu`，
CI 脚本直接 `wget -O` 覆盖**已存在的他人文件**被拒（手动删掉后下载即成功）。

修复：下载前先 `rm -f /tmp/kb.tar.gz`（脚本加 `whoami` 便于排查登录用户）。

## 六、最终验证

1. CI deploy 真执行 → 服务器 pm2 重启（进程 uptime 从 75 小时归零到 16 秒）。
2. 服务器 `grep -c sanitizeControlChars dist/.../document-parser.js` = 1。
3. 重新上传该 html 问"解析每行代码" → 不再报 22P05 ✅

## 七、经验与面试话术

| 教训 | 一句话 |
|---|---|
| 数据进库前的清洗要覆盖**所有路径** | "文本入库前统一过控制字符清洗，双层兜底" |
| CI 绿不等于部署成功 | "排查发现 Actions 步骤输出没写 GITHUB_OUTPUT 导致部署假绿" |
| 部署脚本要考虑文件属主 | "覆盖旧文件前先删除，避免 Permission denied" |
| 错误堆栈行号能判断代码版本 | "报错行号是旧的 → 服务器没跑新代码 → 查部署链路" |

完整故事线：**22P05 崩溃 → 找到漏清洗路径 → 双层修复 → push 后仍复现 →
发现 CI 假绿（GITHUB_OUTPUT）→ 修复 → 又遇 /tmp 权限 → 修复 → 验证通过**。
每段都能展开讲细节，是"真实线上问题排查"的完整样本。
