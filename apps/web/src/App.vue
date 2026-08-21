<script setup lang="ts">
import { RouterView } from 'vue-router';
import ToastContainer from '@/components/ToastContainer.vue';
import { useTheme } from '@/composables/useTheme';

// 全局初始化：进入页面就应用主题（浅色/暗色），登录页/注册页同样生效
useTheme().initTheme();
</script>

<template>
  <RouterView />
  <ToastContainer />
</template>
