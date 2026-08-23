# 24 点计算器页面设计

## 结论

### 1. GitHub Copilot SDK 是否能实现

**可以实现。** 采用 TypeScript 的 `@github/copilot-sdk`，由 Node.js 后端调用 SDK 创建一次性会话，将四个数字和 `prompts/24.md` 的求解规则提交给 Copilot 模型，再把结构化结果返回浏览器。

SDK 是客户端库，不是浏览器可直接调用的 HTTP API；其底层会管理 Copilot CLI 的 JSON-RPC 运行时。因此：

- 令牌只能保存在后端环境变量，绝不能写入前端代码、构建产物或返回给浏览器。
- 当前的 Fine-grained PAT（`github_pat_`，权限为 **Copilot Requests**）属于 SDK 文档支持的令牌类型，可通过 `COPILOT_GITHUB_TOKEN` 使用。
- SDK 使用 Copilot 订阅和请求配额；令牌所属账号必须可使用 Copilot。
- 本功能不需要模型工具调用，后端应以 `mode: "empty"` 启动 SDK，并显式禁止/不注册工具，避免模型获得不必要的宿主机能力。

### 2. 仍需完成的配置

**需要。** 除已创建的令牌外，以下配置是上线前必需项：

| 配置 | 要求 |
| --- | --- |
| Node.js | 选择并固定当前 SDK 支持的 LTS 版本；使用 TypeScript。 |
| 依赖 | 安装 `@github/copilot-sdk`、`express`、`vue`、`vite` 及 TypeScript/开发依赖。Node.js 版 SDK 会自动携带所需 Copilot CLI，无须另行安装 CLI。 |
| 启动脚本 | 根目录 `package.json` 必须提供 `npm start`；该命令启动同一 Node 进程中的 Express API 和 Vite 中间件前端，共用 `30001`，不要求分别执行前后端命令。 |
| 密钥 | 在服务进程的安全环境变量中设置 `COPILOT_GITHUB_TOKEN=<github_pat_...>`；`.env` 仅供本机开发、加入 `.gitignore`，生产环境使用宿主机/密钥管理服务注入。 |
| Copilot 权限 | 确认令牌未过期、账号拥有可用 Copilot 订阅/席位且许可策略允许 Copilot Requests；首次部署须用健康检查实际发起一次请求验证。 |
| 域名与 TLS | Nginx/Caddy 等反向代理应监听 `https://www.bluecryolite.com:30000`，配置有效证书，并代理到应用服务器的私网地址（例如 `http://192.168.3.133:30001`）；防火墙仅允许反向代理访问后端端口。 |
| 进程管理 | 以 systemd、Docker Compose 或等效服务管理器运行 Node 服务，配置自动重启、环境变量与日志轮转。 |
| 限流 | 对 `POST /api/solve` 按 IP/会话限流，并限制请求体大小和单次超时，避免消耗 Copilot Requests 配额。 |

**不需要配置模型 API 地址。** Copilot SDK 通过其管理的 Copilot CLI 与 GitHub Copilot 服务通信，不应把未公开的 Copilot 网关地址硬编码为应用配置。唯一由本项目配置的外部访问地址是反向代理目标：`127.0.0.1:30001`。只有改为 SDK 的高级 Direct API/BYOK 认证时，才需另行配置相应地址和凭据；本设计不采用该路径。

## 架构

为满足“前端和后端均为 30001”且避免同一主机端口冲突，采用**单一 Node 服务**：

```text
Browser
  │ HTTPS https://www.bluecryolite.com:30000
  ▼
Reverse proxy (TLS, public port 30000)
  │ http://192.168.3.133:30001
  ▼
Express application (port 30001)
  ├─ GET /*       -> Vue/Vite 打包后的静态文件
  └─ POST /api/solve
       └─ @github/copilot-sdk -> bundled Copilot CLI -> GitHub Copilot
```

根目录只暴露一个启动入口：`npm start`。该命令先执行 Vite 构建，再由 Express 在 `30001` 提供 `dist/` 静态文件和 `/api/solve`；运行时不加载 Vite middleware、Vite client 或 HMR WebSocket。这同时启动了前端与后端，不会让两个独立进程争抢端口。

生产环境先执行 `npm run build`；`npm start` 设置 `NODE_ENV=production` 后，Express 在同一端口提供 `dist/` 静态资源和 `/api/solve`。因此线上进程管理器也只需执行根目录的 `npm start`。

建议根目录脚本契约：

```json
{
  "scripts": {
    "start": "tsx src/server/app.ts",
    "build": "vite build",
    "test": "..."
  }
}
```

`app.ts` 根据 `NODE_ENV` 选择 Vite middleware 或 `dist/` 静态文件；端口固定从 `PORT` 读取并默认/生产配置为 `30001`。若部署平台不允许 `tsx` 运行 TypeScript，`start` 改为先编译后执行 `node dist-server/app.js`，但仍保持单一命令和单端口。

建议目录：

```text
src/
  client/                 # Vue 页面、样式和 API 调用
  server/
    app.ts                # Express、静态文件和路由注册
    copilot.ts            # SDK 单例、会话和超时管理
    solver.ts             # 请求构造、结果解析与表达式验证
    prompt.ts             # 读取/嵌入 24.md 内容
    validation.ts         # 输入和表达式验证
prompts/24.md
```

## 页面与交互

1. 页面标题和简短规则说明。
2. 四个数字输入框，均为 `type="number"`，`min="1"`、`max="10"`、`step="1"`、默认值可设为 `1`；输入时显示字段级错误。
3. “计算 24”按钮；提交中禁用按钮和输入框，显示加载状态及已耗时秒数（前端使用 `performance.now()` 每 100ms 刷新）。
4. 成功后默认显示唯一的最终算式及验证值，例如 `(8 - 5) × 8 = 24`；显示服务端返回的总耗时。
5. “显示求解步骤”按钮默认折叠；点击后展开由后端返回的有限、结构化步骤，再次点击折叠。
6. 无解、输入错误、Copilot 鉴权/限流/超时、模型输出无效时显示明确错误，并恢复可提交状态。

“求解步骤”应显示**可审计的运算分支摘要和最终验算**，而不是要求或展示模型私有的逐词思维链。提示词要求模型返回可供用户理解的候选运算和选择依据；前端仅呈现该摘要。

## API 契约

### `POST /api/solve`

请求：

```json
{ "numbers": [8, 8, 3, 3] }
```

成功响应：

```json
{
  "expression": "(8 - 5) * 8",
  "formattedExpression": "(8 - 5) × 8 = 24",
  "steps": [
    { "operation": "8 - 5", "result": 3, "remaining": [3, 8] },
    { "operation": "3 * 8", "result": 24, "remaining": [24] }
  ],
  "elapsedMs": 1234
}
```

实际步骤中的操作数和 `remaining` 必须对应输入数字；示例仅用于描述字段格式。无解时返回 HTTP 422：`{ "code": "NO_SOLUTION", "message": "这四个数字无法组成 24。" }`。输入无效返回 400；认证失败返回 502（不暴露令牌细节）；上游超时返回 504；限流返回 429。

## 后端求解流程

1. 校验请求为恰好四个整数，且每个值为 1 至 10；拒绝任何额外的计算参数或提示词内容。
2. 记录服务端单调时钟开始时间，创建独立 SDK session；设置有限超时并确保成功、失败、超时均关闭 session。
3. 组装系统指令和 `prompts/24.md`：仅使用这四个数字各一次、只允许 `+ - * / ()`、以严格 JSON 返回 `expression`、`steps` 和 `status`；不允许工具调用。
4. 调用指定的可用 Copilot 模型。模型名不硬编码为假定值：启动时/首次请求查询可用模型，使用环境变量 `COPILOT_MODEL` 所指定且确实可用的模型；未配置时选取 SDK 返回的默认模型。
5. 严格解析 JSON，拒绝 Markdown 围栏、额外字段和不可识别数值。
6. 独立验证表达式：词法层只接受四个输入数字、运算符和括号；解析为 AST（不用 `eval`）；检查数字多重集恰好一致、无除零、计算结果以有理数精确等于 24。也验证每个展示步骤与合法运算一致。
7. 仅在验证通过后返回结果和耗时。模型声明无解时，也应由本地穷举验证器确认；若模型输出错误或验证失败，返回可重试的 502，不把未经验证的表达式展示给用户。

本地验证器不替代“通过 Copilot SDK 调用模型”的功能，而是防止模型格式漂移、幻觉或恶意输出导致错误计算、XSS 或表达式执行风险。

## 可靠性与安全边界

- 服务器日志只记录请求 ID、耗时、状态和脱敏错误；不记录 `COPILOT_GITHUB_TOKEN` 或完整用户提示词。
- 前端使用文本节点渲染算式和步骤，不使用 `v-html`。
- CORS 默认不启用，因为页面与 API 同源；若确需跨域，白名单只允许 `https://www.bluecryolite.com:30000`。
- SDK 客户端在应用生命周期内复用；每次计算使用独立短生命周期 session，防止上下文串扰。
- 设定 API 请求超时、SDK 会话空闲超时和最大并发量；将上游网络错误转换为可理解的 5xx 响应。
- 反向代理设置 `X-Forwarded-*`；Express 仅在已知代理后启用 `trust proxy`，使限流获取真实客户端地址。

## 验收标准

1. `1, 2, 3, 4` 等有效输入可提交，页面持续显示计算耗时，成功后默认只显示最终算式。
2. 0、11、小数、空值、非四个数字均在调用 API 前被拒绝。
3. 所有展示算式均通过服务端精确验证：四个输入数各用一次且结果为 24。
4. “显示/隐藏求解步骤”不会重新调用模型。
5. Copilot 认证、模型无解、超时、限流和无效模型输出都有正确状态码与用户可读提示。
6. 在项目根目录执行 `npm start` 后，前端页面和 `/api/solve` 均可通过应用服务器地址的 `30001` 端口访问；运行时没有 Vite client、HMR WebSocket 或第二个监听端口。
7. 生产环境经 `https://www.bluecryolite.com:30000` 可访问页面和 API，防火墙仅向反向代理开放 `30001`，令牌不出现在仓库、浏览器或响应中。

## 实施顺序

1. 初始化 TypeScript、Vue/Vite、Express 工程；实现根目录 `npm start`，以 Vite middleware mode 和 Express 在 `30001` 同时提供前端与后端。
2. 实现输入校验、SDK 客户端、结构化提示、JSON 解析与精确表达式验证。
3. 实现 Vue 页面、耗时显示、结果/步骤折叠和错误状态。
4. 添加单元与接口测试，覆盖合法解、无解、非法输入、模型错误及表达式验证。
5. 配置生产环境变量、反向代理和服务管理器，并进行真实 Copilot 请求验证。

## 参考

- GitHub Copilot SDK README: <https://github.com/github/copilot-sdk>
- SDK 认证说明: <https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md>
- SDK 多用户/服务端部署说明: <https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md>
