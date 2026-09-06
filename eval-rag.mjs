import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3000/api';
const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error('usage: node eval-rag.mjs <email> <password>');
  process.exit(1);
}

async function api(path, token, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  const body =
    json && typeof json === 'object' && 'data' in json && 'code' in json ? json.data : json;
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

const QUESTIONS = [
  { id: 'A1', q: '解析 HomeCosmos.vue 中黑洞的每一行代码' },
  { id: 'B1', q: 'compressAvatar 函数是在哪里被调用的？完整流程是什么' },
  { id: 'C1', q: '用户上传头像的完整流程是怎样的（前端到后端每一层）' },
  { id: 'C2', q: '登录鉴权是怎么实现的？从输入账号密码到拿到 token' },
  { id: 'C3', q: '文件上传后是怎么被处理成可检索内容的？完整流程' },
  { id: 'D1', q: '父子分块是什么？解决什么问题' },
  { id: 'D2', q: '研究报告的取消是怎么防止竞态的？' },
  { id: 'E1', q: '项目支持 OCR 识别扫描件吗' },
  { id: 'E2', q: '知识图谱功能现在还在用吗' },
  { id: 'F1', q: '怎么防止用户A看到用户B的知识库内容' },
  { id: 'F2', q: '用户的模型 API Key 存在哪里？安全吗' },
  { id: 'G1', q: '切换暗色模式是在哪个文件实现的' },
  { id: 'G2', q: '会话导出的功能代码在哪里' },
];

const loginRes = await api('/auth/login', null, {
  method: 'POST',
  body: JSON.stringify({ email, password }),
});
const token =
  loginRes.accessToken ?? loginRes.data?.accessToken ?? loginRes.access_token;
if (!token) throw new Error(`no token: ${JSON.stringify(loginRes).slice(0, 300)}`);
console.log('login ok');

const kbs = await api('/knowledge', token);
const arr = Array.isArray(kbs) ? kbs : (kbs?.data ?? []);
const mainKb = arr.find((k) => k.name === '主项目');
if (!mainKb)
  throw new Error(`kb not found, have: ${arr.map((k) => k.name).join(', ') || '(empty)'}`);
console.log(`kb: ${mainKb.name}`);

const session = await api('/chat/sessions', token, {
  method: 'POST',
  body: JSON.stringify({
    title: 'RAG评测',
    knowledgeBaseIds: [mainKb.id],
    useKnowledgeBase: true,
  }),
});
const sessionId = session.id ?? session.data?.id;
console.log(`session: ${sessionId}`);

async function ask(question) {
  const res = await fetch(`${BASE}/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: question, useWebSearch: false }),
  });
  if (!res.ok) {
    const txt = await res.text();
    return { kbFiles: [], answer: `[HTTP ${res.status}] ${txt.slice(0, 300)}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  const kbFiles = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(t.slice(5).trim());
        if (msg.event === 'sources') {
          for (const s of msg.data?.kb ?? []) kbFiles.push(s.filename ?? '(unknown)');
        } else if (msg.event === 'delta') {
          answer += msg.data?.content ?? '';
        }
      } catch {}
    }
  }
  return { kbFiles: [...new Set(kbFiles)], answer: answer.trim() };
}

const results = [];
for (const item of QUESTIONS) {
  process.stdout.write(`[${item.id}] ${item.q.slice(0, 22)}... `);
  const r = await ask(item.q);
  results.push({ ...item, ...r });
  console.log(`hit ${r.kbFiles.length} files`);
  await new Promise((r2) => setTimeout(r2, 3000));
}

writeFileSync('/tmp/kb-eval-result.json', JSON.stringify(results, null, 2), 'utf8');
console.log(`done ${results.length} -> /tmp/kb-eval-result.json`);
