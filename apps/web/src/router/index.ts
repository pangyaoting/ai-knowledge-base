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
          path: 'knowledge/:id/graph',
          name: 'knowledge-graph',
          component: () => import('@/views/KnowledgeGraph.vue'),
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
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/views/Dashboard.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/views/Settings.vue'),
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
router.beforeEach((to) => {
  const auth = useAuthStore();

  // 已登录用户访问登录/注册页，重定向到首页（404 页除外：任何状态下都应展示 404）
  if (to.meta.public && auth.isLoggedIn && to.name !== 'not-found') {
    return { name: 'home' };
  }

  // 未登录用户访问受保护页面，重定向到登录页
  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
});

export default router;
