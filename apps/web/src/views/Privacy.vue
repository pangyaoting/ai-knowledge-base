<script setup lang="ts">
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { CONTACT_EMAIL, SITE_DOMAIN } from '@/config/site';

/**
 * 隐私政策。内容必须与代码实际行为一致（否则本身就是合规风险），因此每条都对应真实实现：
 * 注册字段 = 邮箱+验证码+密码+昵称（见 register.dto.ts）、无手机号；
 * 文档向量化走**系统 Key 的硅基流动** → 文档片段会离开服务器，必须披露；
 * 对话走**用户自己配置的模型服务商**（BYO Key）→ 提问与检索片段发往该服务商，必须披露。
 */
const router = useRouter();
const UPDATED = '2026-09-11';
</script>

<template>
  <div class="container max-w-3xl py-10">
    <div class="mb-6 flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">隐私政策</h1>
        <p class="mt-1 text-xs text-muted-foreground">
          生效日期：{{ UPDATED }} · 适用站点：{{ SITE_DOMAIN }}
        </p>
      </div>
      <Button variant="outline" size="sm" @click="router.back()">返回</Button>
    </div>

    <div class="space-y-6 text-sm leading-relaxed text-foreground/90">
      <section class="rounded-lg border bg-card p-5">
        <p>
          本平台是<strong>个人非经营性学习项目</strong>（AI
          知识库问答演示），不收费、不投放广告、不从事经营性活动。
          我们只收集为提供服务所必需的最少信息，并如实告知这些信息会流向哪里。使用本平台前请阅读本政策。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">一、我们收集哪些信息</h2>
        <div class="overflow-x-auto rounded-lg border bg-card">
          <table class="w-full text-xs">
            <thead class="bg-muted/50 text-left">
              <tr>
                <th class="px-3 py-2">类别</th>
                <th class="px-3 py-2">具体内容</th>
                <th class="px-3 py-2">用途</th>
              </tr>
            </thead>
            <tbody>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">账号信息</td>
                <td class="px-3 py-2">
                  邮箱、密码（bcrypt 哈希后存储，我们看不到明文）、昵称（可选）、头像（可选）
                </td>
                <td class="px-3 py-2">注册登录、邮箱验证码找回密码、页面展示</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">你提交的内容</td>
                <td class="px-3 py-2">
                  上传的文档（PDF/Word/Markdown/TXT/代码）、提问与对话记录、研究报告主题
                </td>
                <td class="px-3 py-2">解析分块、向量化、检索与生成回答/报告</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">模型配置</td>
                <td class="px-3 py-2">
                  你自带的 API Key、接口地址、模型名（Key 以 AES-256-GCM
                  加密后落库，接口只返回掩码）
                </td>
                <td class="px-3 py-2">用你自己的 Key 调用大模型</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">使用统计</td>
                <td class="px-3 py-2">提问次数、token 消耗量、模型名、引用到的文档名</td>
                <td class="px-3 py-2">数据看板（仅你自己可见，按账号隔离）</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">必要技术信息</td>
                <td class="px-3 py-2">
                  浏览器本地存储的登录凭证（token）、服务端访问日志（含 IP）
                </td>
                <td class="px-3 py-2">保持登录态、排查故障与防滥用</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          我们<strong>不收集</strong>手机号、身份证、位置、通讯录，也不使用第三方广告或行为追踪
          SDK。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">二、你的内容会发送给哪些第三方（重要）</h2>
        <p class="mb-2">
          本平台依赖外部 AI
          服务，<strong>以下环节会把相应内容发送到本站服务器之外</strong>，请勿上传涉密或个人敏感资料：
        </p>
        <div class="overflow-x-auto rounded-lg border bg-card">
          <table class="w-full text-xs">
            <thead class="bg-muted/50 text-left">
              <tr>
                <th class="px-3 py-2">环节</th>
                <th class="px-3 py-2">发送内容</th>
                <th class="px-3 py-2">接收方</th>
              </tr>
            </thead>
            <tbody>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">文档向量化</td>
                <td class="px-3 py-2">上传文档的文本片段</td>
                <td class="px-3 py-2">硅基流动（bge-m3 向量化服务，本站系统 Key）</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">检索精排</td>
                <td class="px-3 py-2">你的问题 + 命中的文档片段</td>
                <td class="px-3 py-2">硅基流动（bge-reranker 重排服务）</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">生成回答 / 报告</td>
                <td class="px-3 py-2">你的问题、对话上下文、检索到的资料片段</td>
                <td class="px-3 py-2">
                  <strong>你自己配置的模型服务商</strong>（如 DeepSeek，用你自己的 Key、你的账号）
                </td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">联网检索</td>
                <td class="px-3 py-2">检索关键词</td>
                <td class="px-3 py-2">Tavily 搜索服务</td>
              </tr>
              <tr class="border-t">
                <td class="px-3 py-2 font-medium">邮箱验证码</td>
                <td class="px-3 py-2">你的邮箱地址</td>
                <td class="px-3 py-2">邮件服务商（SMTP）</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          这些第三方对其收到的数据有各自的隐私政策与保存策略，请同时阅读你所用模型服务商的条款。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">三、存储与安全</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            服务器位于<strong>中国大陆境内</strong>（腾讯云），本站已完成 ICP
            备案与公安联网备案登记。
          </li>
          <li>密码使用 bcrypt 哈希、API Key 使用 AES-256-GCM 加密存储，数据库不对公网开放。</li>
          <li>账号间数据严格隔离：知识库、文档、会话、统计只对所有者可见。</li>
          <li>
            保存期限：账号与内容数据保存至你主动删除或申请注销后 30
            日内清除（备份副本随备份周期滚动覆盖）。
          </li>
          <li>请注意：互联网上没有绝对安全。若你上传的是他人个人信息，请确保已获得合法授权。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">四、我们不做的事</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>不出售、出租、交换你的个人信息；</li>
          <li>不将你的文档与对话用于训练模型；</li>
          <li>不投放广告、不做用户画像与自动化营销；</li>
          <li>除法律法规要求或你另行同意外，不向上述第三方之外的任何方提供你的信息。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">五、你的权利</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li><strong>查阅 / 更正</strong>：个人中心可查看并修改昵称、头像、密码。</li>
          <li><strong>删除内容</strong>：知识库、文档、会话、报告、模型配置均可在页面自助删除。</li>
          <li>
            <strong>注销账号</strong
            >：目前未开放自助注销入口，可发邮件到下方邮箱申请，我们核实身份后
            <strong>15 个工作日内</strong>删除账号及其关联数据。
          </li>
          <li>
            <strong>撤回同意</strong>：停止使用并申请删除即可；撤回不影响此前基于同意进行的处理。
          </li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">六、未成年人</h2>
        <p>
          本平台面向开发者学习演示，不面向未成年人提供服务。若你未满 18
          周岁，请在监护人陪同下使用并取得同意。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">七、关于 AI 生成内容</h2>
        <p>
          站内回答与报告由大模型生成，可能<strong>存在错误、过时或不完整</strong>，不构成法律、医疗、投资等专业意见，
          请自行核实后使用。我们已按《人工智能生成合成内容标识办法》在生成内容处添加"AI 生成"标识。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">八、政策变更与联系方式</h2>
        <p>
          政策如有实质变更，会在本页面更新生效日期并站内提示。任何疑问、投诉或权利行使请求，请联系：
          <a :href="`mailto:${CONTACT_EMAIL}`" class="font-medium text-primary hover:underline">{{
            CONTACT_EMAIL
          }}</a>
          。
        </p>
      </section>
    </div>
  </div>
</template>
