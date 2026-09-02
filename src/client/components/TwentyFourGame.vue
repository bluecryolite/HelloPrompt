<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { solveTwentyFour, type SolveResponse } from "../features/twenty-four.js";

const numbers = ref([1, 2, 3, 4]);
const loading = ref(false);
const elapsed = ref(0);
const result = ref<SolveResponse | null>(null);
const error = ref("");
const fieldErrors = ref(["", "", "", ""]);
const showSteps = ref(false);
let timer = 0;
let started = 0;

async function solve() {
  error.value = "";
  result.value = null;
  showSteps.value = false;
  fieldErrors.value = numbers.value.map((n) => Number.isInteger(n) && n >= 1 && n <= 10 ? "" : "请输入 1–10 的整数。");
  if (fieldErrors.value.some(Boolean)) {
    error.value = "请先修正输入框中的错误。";
    return;
  }

  loading.value = true;
  started = performance.now();
  timer = window.setInterval(() => elapsed.value = Math.round((performance.now() - started) / 100) / 10, 100);
  try {
    const body = await solveTwentyFour(numbers.value);
    result.value = body;
    elapsed.value = Math.round(body.elapsedMs / 100) / 10;
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : "计算失败，请稍后重试。";
  } finally {
    loading.value = false;
    clearInterval(timer);
  }
}

onUnmounted(() => clearInterval(timer));
</script>

<template>
  <main class="card">
    <div class="eyebrow">NUMBER PUZZLE</div>
    <h1>24 点计算器</h1>
    <p class="intro">使用下面四个数字各一次，通过加、减、乘、除和括号得到 24。</p>
    <div class="inputs">
      <label v-for="(_, index) in numbers" :key="index">
        数字 {{ index + 1 }}
        <input v-model.number="numbers[index]" type="number" min="1" max="10" step="1" :disabled="loading" :aria-invalid="Boolean(fieldErrors[index])">
        <small v-if="fieldErrors[index]" class="field-error">{{ fieldErrors[index] }}</small>
      </label>
    </div>
    <button class="primary" :disabled="loading" @click="solve">{{ loading ? "计算中…" : "计算 24" }}</button>
    <div v-if="loading" class="loading" aria-live="polite"><span class="spinner"></span>正在搜索解法 · {{ elapsed.toFixed(1) }} 秒</div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="result" class="answer">
      <span class="success">找到解法</span>
      <div class="expression">{{ result.formattedExpression }}</div>
      <button class="link" @click="showSteps = !showSteps">{{ showSteps ? "隐藏求解步骤" : "显示求解步骤" }}</button>
      <div v-if="showSteps" class="steps">
        <div v-for="(step, index) in result.steps" :key="index">
          <b>{{ index + 1 }}</b>
          <span>{{ step.operation }} = {{ step.result }}</span>
          <small>剩余：{{ step.remaining.join("、") }}</small>
        </div>
      </div>
      <small class="duration">服务端耗时 {{ (result.elapsedMs / 1000).toFixed(1) }} 秒</small>
      <small class="model">模型：{{ result.model }}</small>
    </section>
  </main>
</template>
