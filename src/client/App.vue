<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Shopoint from "./components/Shopoint.vue";
import TwentyFourGame from "./components/TwentyFourGame.vue";

type Feature = {
  id: string;
  title: string;
  description: string;
  path: string;
};

const features: Feature[] = [
  {
    id: "twenty-four",
    title: "24 点计算器",
    description: "使用四个数字各一次，通过加减乘除得到 24。",
    path: "/features/24-game"
  },
  {
    id: "shopoint",
    title: "Shopoint",
    description: "输入和处理多行文本。",
    path: "/features/shopoint"
  }
];

const currentPath = ref(window.location.pathname);
const currentFeature = () => features.find((feature) => feature.path === currentPath.value);

function navigate(path: string) {
  if (path === currentPath.value) return;
  window.history.pushState({}, "", path);
  currentPath.value = path;
}

function handlePopState() {
  currentPath.value = window.location.pathname;
}

onMounted(() => window.addEventListener("popstate", handlePopState));
onUnmounted(() => window.removeEventListener("popstate", handlePopState));
</script>

<template>
  <main v-if="currentPath === '/'" class="hub card">
    <div class="eyebrow">HELLO PROMPT</div>
    <h1>功能中心</h1>
    <p class="intro">选择一个功能开始使用。</p>
    <div class="feature-list">
      <button v-for="feature in features" :key="feature.id" class="feature-card" @click="navigate(feature.path)">
        <strong>{{ feature.title }}</strong>
        <span>{{ feature.description }}</span>
      </button>
    </div>
  </main>
  <main v-else-if="currentFeature()" class="feature-page">
    <nav class="feature-nav" aria-label="页面导航">
      <button class="back-link" @click="navigate('/')">← 返回功能中心</button>
    </nav>
    <TwentyFourGame v-if="currentPath === '/features/24-game'" />
    <Shopoint v-else-if="currentPath === '/features/shopoint'" />
  </main>
  <main v-else class="not-found card">
    <div class="eyebrow">404</div>
    <h1>页面不存在</h1>
    <p class="intro">找不到你访问的功能。</p>
    <button class="primary" @click="navigate('/')">返回功能中心</button>
  </main>
</template>
