<script setup lang="ts">
import { ref } from "vue";
import { solveShopoint } from "../features/shopoint.js";

const text = ref("");
const result = ref("");
const model = ref("");
const loading = ref(false);
const error = ref("");

async function solve() {
  error.value = "";
  result.value = "";
  model.value = "";
  loading.value = true;
  try {
    const response = await solveShopoint(text.value);
    result.value = response.result;
    model.value = response.model;
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : "处理失败，请稍后重试。";
  } finally {
    loading.value = false;
  }
}
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
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="result" class="shopoint-result">
      <h2>结果</h2>
      <p>{{ result }}</p>
      <small class="model">模型：{{ model }}</small>
    </section>
  </main>
</template>
