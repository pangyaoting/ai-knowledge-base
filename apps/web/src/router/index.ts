import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
      meta: { public: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/Register.vue'),
      meta: { public: true },
    },
    {
      path: '/forgot-password',
      name: 'forgot-password',
      component: () => import('@/views/ForgotPassword.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('@/views/Layout.vue'),
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('@/views/Home.vue'),
        },
        {
          path: 'knowledge',
          name: 'knowledge',
          component: () => import('@/views/KnowledgeBases.vue'),
        },
        {
          path: 'knowledge/:id',
          name: 'knowledge-documents',
          component: () => import('@/views/KnowledgeDocuments.vue'),
        },
        {
          path: 'chat',
          name: 'chat',
          component: () => import('@/views/Chat.vue'),
        },
        {
          path: 'research',
          name: 'research',
          component: () => import('@/views/Research.vue'),
        },
        {
          path: 'research-agent',
          name: 'research-agent',
          component: () => import('@/views/ResearchAgent.vue'),
        },
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/views/Dashboard.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/views/Settings.vue'),
        },
        {
          path: 'model-configs',
          name: 'model-configs',
          component: () => import('@/views/ModelConfigs.vue'),
        },
        {
          // 合规页：未登录也必须能看（注册前就要能读到隐私政策）
          path: 'privacy',
          name: 'privacy',
          component: () => import('@/views/Privacy.vue'),
          meta: { public: true },
        },
        {
          path: 'terms',
          name: 'terms',
          component: () => import('@/views/Terms.vue'),
          meta: { public: true },
        },
      ],
    },
    {
      // 兜底：未匹配的路径 → 404 页
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFound.vue'),
      meta: { public: true },
    },
  ],
});

// 全局前置守卫
/** 已登录也**不**跳走的公开页：404 + 两份合规文本（登录后点页脚隐私政策不能被弹回首页） */
const PUBLIC_ALWAYS = new Set(['not-found', 'privacy', 'terms']);

router.beforeEach((to) => {
  const auth = useAuthStore();

  // 已登录用户访问登录/注册页，重定向到首页（合规页与 404 除外：任何状态下都应展示）
  if (to.meta.public && auth.isLoggedIn && !PUBLIC_ALWAYS.has(String(to.name))) {
    return { name: 'home' };
  }

  // 未登录用户访问受保护页面，重定向到登录页
  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
});

export default router;
