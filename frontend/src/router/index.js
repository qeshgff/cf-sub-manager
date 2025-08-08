import { createRouter, createWebHashHistory } from 'vue-router';
import AdminLayout from '../views/AdminLayout.vue';
import Login from '../views/Login.vue';
import Dashboard from '../views/Dashboard.vue';
import GroupDetails from '../views/GroupDetails.vue';
import Settings from '../views/Settings.vue';
import Setup from '../views/Setup.vue';

// 使用 Hash 模式，这对 Cloudflare Pages 的单页应用更友好
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', name: 'Login', component: Login },
    { path: '/setup', name: 'Setup', component: Setup },
    {
      path: '/',
      component: AdminLayout,
      // 路由守卫，检查认证
      beforeEnter: (to, from, next) => {
        if (!localStorage.getItem('auth_token')) {
          next({ name: 'Login' });
        } else {
          next();
        }
      },
      children: [
        { path: '', name: 'Dashboard', component: Dashboard, meta: { title: '仪表盘' } },
        { path: 'group/:id', name: 'GroupDetails', component: GroupDetails, props: true, meta: { title: '分组详情' } },
        { path: 'settings', name: 'Settings', component: Settings, meta: { title: '设置' } },
      ],
    },
  ],
});

router.beforeEach(async (to, from, next) => {
  // 检查是否已配置
  try {
    const response = await fetch('/api/getConfig');
    const data = await response.json();

    // 如果未配置且目标不是Setup页面，则强制跳转到Setup
    if (!data.isConfigured && to.name !== 'Setup') {
      next({ name: 'Setup' });
    } 
    // 如果已配置且用户访问Setup页面，则跳转到登录页
    else if (data.isConfigured && to.name === 'Setup') {
      next({ name: 'Login' });
    }
    // 如果已登录但想访问Login或Setup，则跳转到主页
    else if (localStorage.getItem('auth_token') && (to.name === 'Login' || to.name === 'Setup')) {
      next({ name: 'Dashboard' });
    }
    else {
      next();
    }
  } catch (error) {
     // 如果API请求失败（例如网络问题或后端未就绪），允许进入setup页面
     if (to.name !== 'Setup') {
        next({ name: 'Setup' });
     } else {
        next();
     }
  }
});

export default router;
