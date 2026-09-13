<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { solveShopoint, type ShopointResponse } from "../features/shopoint.js";

const text = ref("");
const result = ref<ShopointResponse | null>(null);
const elapsed = ref(0);
const loading = ref(false);
const error = ref("");
let timer = 0;
let started = 0;

function comparisonStatus(matches: boolean | null) {
  return matches === true ? "一致" : matches === false ? "不一致" : "未完成";
}

async function solve() {
  error.value = "";
  result.value = null;
  loading.value = true;
  started = performance.now();
  timer = window.setInterval(() => elapsed.value = Math.round((performance.now() - started) / 100) / 10, 100);
  try {
    result.value = await solveShopoint(text.value);
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : "处理失败，请稍后重试。";
  } finally {
    loading.value = false;
    clearInterval(timer);
  }
}

onUnmounted(() => clearInterval(timer));
</script>

<template>
  <main class="card shopoint">
    <div class="eyebrow">SHOPOINT</div>
    <h1>Shopoint</h1>
    <p class="intro">输入多行文本开始处理。</p>
    <label class="textarea-label" for="shopoint-input">文本</label>
    <textarea
      id="shopoint-input"
      v-model="text"
      class="shopoint-input"
      rows="12"
      placeholder="请输入多行文本"
      :disabled="loading"
    ></textarea>
    <button class="primary" :disabled="loading" @click="solve">{{ loading ? "处理中…" : "处理文本" }}</button>
    <div v-if="loading" class="loading" aria-live="polite"><span class="spinner"></span>正在处理 · {{ elapsed.toFixed(1) }} 秒</div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="result" class="shopoint-result">
      <h2>结果</h2>
      <p>{{ result.result }}</p>
      <small class="model">模型：{{ result.model }}</small>
      <small class="model">模型调用时间：{{ (result.elapsedMs / 1000).toFixed(1) }} 秒</small>
      <small class="model">输入 token：{{ result.inputTokens }}</small>
      <small class="model">输出 token：{{ result.outputTokens }}</small>
      <small class="model">缓存读 token：{{ result.cacheReadTokens }}</small>
      <small class="model">缓存写 token：{{ result.cacheWriteTokens }}</small>
      <section class="address-comparison">
        <h3>接口地址对比</h3>
        <dl>
          <dt>官方接口地址</dt>
          <dd>{{ result.addressComparison.officialInterfaceUrl ?? "未解析到" }}</dd>
          <dt>报文接口地址</dt>
          <dd>{{ result.addressComparison.reportInterfacePath ?? "未提供" }}</dd>
          <dt>官方与报文</dt>
          <dd>{{ comparisonStatus(result.addressComparison.reportMatchesOfficial) }}</dd>
          <dt>代码路由</dt>
          <dd>{{ result.addressComparison.codeRoutePath ?? "未确认" }}</dd>
          <dt>官方与代码</dt>
          <dd>{{ comparisonStatus(result.addressComparison.codeMatchesOfficial) }}</dd>
        </dl>
      </section>
      <section class="code-searches">
        <h3>代码搜索定位</h3>
        <p v-if="result.codeSearches.length === 0" class="search-empty">本次未获得代码搜索定位。</p>
        <div v-for="(search, searchIndex) in result.codeSearches" :key="`${search.root}:${search.query}:${searchIndex}`" class="code-search">
          <p>关键词：<code>{{ search.query }}</code></p>
          <ul v-if="search.matches.length">
            <li v-for="match in search.matches" :key="`${match.path}:${match.line}`">
              <code>{{ match.path }}:{{ match.line }}</code>
              <span>{{ match.text }}</span>
            </li>
          </ul>
          <p v-else class="search-empty">未命中。</p>
          <small v-if="search.truncated" class="search-empty">结果已截断。</small>
        </div>
      </section>
    </section>
  </main>
</template>
