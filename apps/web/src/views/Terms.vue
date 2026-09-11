<script setup lang="ts">
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { CONTACT_EMAIL, SITE_DOMAIN } from '@/config/site';

/**
 * 用户协议。核心是把"这是一个个人非经营性学习项目"讲清楚：
 * 免费、无 SLA、随时可能调整或下线；BYO Key 的费用与风险由用户承担；
 * AI 输出不保证准确（配合 AiBadge 的显式标识）。
 */
const router = useRouter();
const UPDATED = '2026-09-11';
</script>

<template>
  <div class="container max-w-3xl py-10">
    <div class="mb-6 flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">用户协议</h1>
        <p class="mt-1 text-xs text-muted-foreground">
          生效日期：{{ UPDATED }} · 适用站点：{{ SITE_DOMAIN }}
        </p>
      </div>
      <Button variant="outline" size="sm" @click="router.back()">返回</Button>
    </div>

    <div class="space-y-6 text-sm leading-relaxed text-foreground/90">
      <section class="rounded-lg border bg-card p-5">
        <p>
          欢迎使用本平台。本平台是<strong>个人开发者的非经营性学习项目</strong>，用于演示检索增强生成（RAG）、
          研究报告与自主研究 Agent 等技术能力，<strong>免费提供、不收费、不含商业广告</strong>。
          注册或使用即表示你已阅读并同意本协议与
          <RouterLink to="/privacy" class="text-primary hover:underline">《隐私政策》</RouterLink>。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">一、服务内容与性质</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            服务包括：知识库文档管理与检索、AI 对话问答、研究报告生成、自主研究
            Agent、使用数据看板。
          </li>
          <li>
            本服务按<strong>"现状"提供</strong>，不承诺可用性、响应时间或数据不丢失（无
            SLA）；可能因维护、 服务器故障、第三方 AI
            服务变动或开发者个人原因<strong>随时调整、暂停或终止</strong>。
          </li>
          <li>请不要将本服务用于重要或唯一的数据存档用途；重要资料请自行保留副本。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">二、账号</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            注册需使用你本人可正常收信的邮箱，并妥善保管密码；因密码泄露造成的损失由你自行承担。
          </li>
          <li>账号仅供本人使用，请勿出借、共享、批量注册或用于自动化刷量。</li>
          <li>如发现账号存在异常或违规使用，我们有权限制功能或停用账号。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">三、使用规范（禁止行为）</h2>
        <p class="mb-2">
          你承诺不利用本服务从事下列行为，否则我们有权删除内容并停用账号，必要时向有关部门报告：
        </p>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            上传、生成或传播违反法律法规的内容（危害国家安全、色情低俗、暴力恐怖、赌博诈骗、侵犯他人权益等）；
          </li>
          <li>上传涉密文件、他人个人信息、商业秘密等你无合法授权的资料；</li>
          <li>对本站或第三方 AI 服务进行攻击、渗透、爬取、压测，或绕过额度与限流机制；</li>
          <li>将本服务用于违法用途，或冒用他人身份、伪造信息来源；</li>
          <li>其他违反《网络安全法》《生成式人工智能服务管理暂行办法》等规定的行为。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">四、自带 Key（BYO）与费用</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            大模型调用使用<strong>你自己申请并配置的 API Key</strong
            >，产生的费用由你与对应服务商结算， 本平台不代收、不承担；你的 Key
            以加密形式存储，但请自行评估风险，勿使用额度敏感的账号 Key。
          </li>
          <li>你与第三方模型服务商之间同时适用其服务条款，请自行阅读并遵守。</li>
          <li>文档向量化、检索精排由本站系统 Key 提供，额度有限，请勿恶意占用。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">五、你的内容与知识产权</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            你上传的文档、提问与生成结果的权利归你（或原权利人）所有；你仅为提供服务之目的，授权我们存储与处理这些内容。
          </li>
          <li>删除文档、会话或知识库后，相应内容不再被检索与引用。</li>
          <li>
            本平台的代码、界面与文档由开发者享有知识产权，仅供学习交流，未经许可请勿用于商业用途。
          </li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">六、AI 生成内容免责</h2>
        <p>
          站内所有回答、研究报告与自主研究结论均由大模型自动生成，已在展示处标注"AI 生成"标识。
          生成内容<strong>可能不准确、不完整或已过时</strong>，且可能与你上传资料的原意存在偏差，
          <strong>不构成法律、医疗、投资、税务等专业意见</strong
          >。请务必自行核实关键信息后再作决策， 因依赖生成内容造成的损失由你自行承担。
        </p>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">七、责任限制</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            本服务免费提供，在法律允许的最大范围内，我们不对因使用或无法使用本服务产生的间接损失、数据丢失、第三方服务中断承担责任。
          </li>
          <li>
            第三方 AI 服务（模型、向量化、联网搜索、邮件）的中断、限流、变更或终止，不视为我们违约。
          </li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">八、协议变更与终止</h2>
        <ul class="list-disc space-y-1 pl-5">
          <li>协议更新会在本页面更新生效日期；继续使用即视为接受更新内容。</li>
          <li>你可以随时停止使用并申请注销账号；我们也可在提前告知或存在违规情形时终止服务。</li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-base font-semibold">九、法律适用与联系方式</h2>
        <p>
          本协议适用中华人民共和国法律。争议应先友好协商；协商不成，提交开发者所在地有管辖权的人民法院解决。
          联系方式：<span class="font-medium">{{ CONTACT_EMAIL }}</span
          >。
        </p>
      </section>
    </div>
  </div>
</template>
