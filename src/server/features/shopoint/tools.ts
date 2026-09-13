import { defineTool, ToolSet, type Tool } from "@github/copilot-sdk";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const ALLINPAY_DOC_URL = "https://prodoc.allinpay.com/doc/1549/";

const MAX_DOCUMENT_LENGTH = 16000;
const MAX_LINKED_DOCUMENT_LENGTH = 24000;
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_SEARCH_RESULTS = 50;
const IGNORED_DIRECTORIES = new Set([".git", "target", "node_modules", "dist", "build"]);
const TEXT_EXTENSIONS = new Set([
    ".java",
    ".xml",
    ".yml",
    ".yaml",
    ".properties",
    ".json",
    ".md",
    ".sql",
    ".txt",
]);

type ReadDocumentArgs = {
    url?: string;
    keyword?: string;
    maxPages?: number;
};

type ExtractInputArgs = {
    text: string;
};

type SearchCodeArgs = {
    root: string;
    query: string;
    filePattern?: string;
    maxResults?: number;
};

type ReadCodeFileArgs = {
    root: string;
    path: string;
    startLine?: number;
    endLine?: number;
};

type VerifyEntryArgs = {
    root: string;
    path: string;
    expectedPath: string;
};

type TraceEntryArgs = {
    root: string;
    path: string;
    line: number;
    expectedPath: string;
};

type DocumentLink = {url: string; title: string};
export type DocumentEndpoint = {
    url: string;
    path: string;
    routePath: string;
    kind: "production" | "test";
    sourceUrl: string;
};
export type OfficialInterfaceDefinition = {
    keyword: string;
    documentUrl: string;
    documentTitle: string;
    interfaceUrl: string;
    routePath: string;
};

const extractInputTool = defineTool<ExtractInputArgs>("extract_shopoint_facts", {
    description: "从用户原文提取接口路径、错误信息、响应字段和代码搜索关键词。必须作为第一次工具调用。",
    skipPermission: true,
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
            text: {
                type: "string",
                description: "完整的用户原文，不得改写或省略。",
            },
        },
        required: ["text"],
    },
    handler: async (args) => extractShopointFacts(args),
});

const readDocumentTool = defineTool<ReadDocumentArgs>("read_allinpay_doc", {
    description: "读取一码付官方文档，提取接口标题、官方接口地址、请求参数和响应参数。必须先于代码搜索调用。仅允许访问 prodoc.allinpay.com 的文档页面。",
    skipPermission: true,
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
            url: {
                type: "string",
                description: `文档 URL，默认使用 ${ALLINPAY_DOC_URL}。`,
            },
            keyword: {
                type: "string",
                description: "要定位的文档标题或关键词，例如“3.1统一扫码”。",
            },
            maxPages: {
                type: "number",
                description: "最多读取多少个关键词匹配的子文档，范围 1-3。",
            },
        },
    },
    handler: async (args) => readAllinpayDocument(args),
});

function createSearchCodeTool(codeBasePath: string | undefined) {
    return defineTool<SearchCodeArgs>("search_shopoint_code", {
        description: "在配置的一码付本地代码目录中搜索接口入口、类名、方法名或错误文本。必须先调用 extract_shopoint_facts；只读，不执行命令。",
        skipPermission: true,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                root: {
                    type: "string",
                    enum: [
                        "controller",
                        "syb",
                        "organization-common",
                        "organization",
                        "activity-common",
                        "activity",
                        "order-common",
                        "order",
                        "basic-common",
                        "basic",
                        "goods-common",
                        "goods",
                        "third-party-common",
                        "third-party",
                    ],
                    description: "要搜索的代码库根目录标识。",
                },
                query: {
                    type: "string",
                    description: "要搜索的文本，例如统一扫码、scanqrpay、类名或错误信息。",
                },
                filePattern: {
                    type: "string",
                    description: "可选文件名模式，例如 *.java 或 *.xml。",
                },
                maxResults: {
                    type: "number",
                    description: "最多返回结果数，范围 1-50。",
                },
            },
            required: ["root", "query"],
        },
        handler: async (args) => searchShopointCode(codeBasePath, args),
    });
}

function createReadCodeFileTool(codeBasePath: string | undefined) {
    return defineTool<ReadCodeFileArgs>("read_shopoint_file", {
        description: "入口确认后读取代码文件；第一次读取必须是已确认的入口文件，然后沿调用关系读取请求参数和下游逻辑。只读，不允许修改或删除文件。",
        skipPermission: true,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                root: {
                    type: "string",
                    description: "search_shopoint_code 返回的代码库根目录标识。",
                },
                path: {
                    type: "string",
                    description: "相对于 root 的文件路径。",
                },
                startLine: {
                    type: "number",
                    description: "起始行号，默认 1。",
                },
                endLine: {
                    type: "number",
                    description: "结束行号，默认最多读取起始行之后 200 行。",
                },
            },
            required: ["root", "path"],
        },
        handler: async (args) => readShopointFile(codeBasePath, args),
    });
}

function createVerifyEntryTool(codeBasePath: string | undefined) {
    return defineTool<VerifyEntryArgs>("verify_shopoint_entry", {
        description: "根据搜索结果验证候选文件是否实现用户原文中的接口入口。只有 matched=true 才算入口确认。",
        skipPermission: true,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                root: {
                    type: "string",
                    description: "search_shopoint_code 返回的代码库根目录标识。",
                },
                path: {
                    type: "string",
                    description: "search_shopoint_code 返回的候选文件路径。",
                },
                expectedPath: {
                    type: "string",
                    description: "read_allinpay_doc 从官方接口地址解析出的控制器路由路径，例如 /szyx/apiweb/unitorder/scanqrpay。",
                },
            },
            required: ["root", "path", "expectedPath"],
        },
        handler: async (args) => verifyShopointEntry(codeBasePath, args),
    });
}

function createTraceEntryTool(codeBasePath: string | undefined) {
    return defineTool<TraceEntryArgs>("trace_shopoint_entry", {
        description: "从服务实现中的错误行，沿 InterfaceType 分支反向追踪到调用该服务的 Controller 方法及其接口映射。用于错误文本命中 service/impl 文件且候选文件自身没有路由注解的情况。",
        skipPermission: true,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                root: {
                    type: "string",
                    enum: ["syb"],
                    description: "search_shopoint_code 返回错误行所在文件的代码库根目录标识。",
                },
                path: {
                    type: "string",
                    description: "search_shopoint_code 返回的服务实现文件路径。",
                },
                line: {
                    type: "number",
                    description: "search_shopoint_code 返回的错误信息所在行号。",
                },
                expectedPath: {
                    type: "string",
                    description: "官方接口地址解析出的 production routePath，用于在反推到的接口映射中精确确认入口。",
                },
            },
            required: ["root", "path", "line", "expectedPath"],
        },
        handler: async (args) => traceShopointEntry(codeBasePath, args),
    });
}

export function createShopointTools(codeBasePath: string | undefined): {
    tools: Tool[];
    availableTools: string[];
} {
    // Tool's generic argument is invariant in the SDK declaration, although each
    // handler is independently validated by its JSON schema.
    const tools: Tool[] = [
        extractInputTool as Tool,
        readDocumentTool as Tool,
        createSearchCodeTool(codeBasePath) as Tool,
        createVerifyEntryTool(codeBasePath) as Tool,
        createTraceEntryTool(codeBasePath) as Tool,
        createReadCodeFileTool(codeBasePath) as Tool,
    ];
    const availableTools = new ToolSet()
        .addCustom("extract_shopoint_facts")
        .addCustom("read_allinpay_doc")
        .addCustom("search_shopoint_code")
        .addCustom("verify_shopoint_entry")
        .addCustom("trace_shopoint_entry")
        .addCustom("read_shopoint_file")
        .toArray();
    return {tools, availableTools};
}

export function extractShopointFacts(args: ExtractInputArgs) {
    const text = args.text.trim();
    if (!text) throw new Error("用户原文不能为空。");
    const analysisText = text.replace(/<[^>]+>/g, " ");

    const interfacePaths = unique([
        ...Array.from(
            analysisText.matchAll(
                /(?:method|报文(?:接口)?地址|接口(?:路径|地址)?|url|path)\s*[:：]\s*[`"']*(\/[A-Za-z0-9_./-]+)/gi,
            ),
        ).map((match) => match[1]),
        ...Array.from(analysisText.replace(/https?:\/\/[^\s<"'，。]+/gi, " ").matchAll(/\/[A-Za-z0-9][A-Za-z0-9_./-]*/g))
            .map((match) => match[0])
            .filter((path) => !/^\/(?:doc|Users|var|tmp|home|src)\b/i.test(path)),
    ]);
    const quotedValues = unique(
        Array.from(analysisText.matchAll(/[“"]([^”"\r\n]{2,})[”"]/g))
            .map((match) => match[1].trim())
            .filter((value) => !value.startsWith("/") && /[\u4e00-\u9fff]/.test(value)),
    );
    const responseFields = unique(
        Array.from(analysisText.matchAll(/\b(?:retcode|retmsg|retmsge|body|method)\b/gi)).map((match) => match[0].toLowerCase()),
    );
    const retcode = analysisText.match(/\bretcode\s*[:：]\s*["']?([A-Za-z_]+)/i)?.[1] ?? null;
    const request = extractRequestPayload(analysisText);
    const documentKeywords = unique(
        Array.from(analysisText.matchAll(/(\d+(?:\.\d+)+\s*[^\n，。:：]{1,30}?)(?:接口|时|，|。|$)/g))
            .map((match) => match[1].trim()),
    );
    const searchQueries = unique([
        ...interfacePaths,
        ...interfacePaths.flatMap((path) => path.split("/").filter((segment) => segment.length >= 4).slice(-2)),
        ...quotedValues,
        ...request.fields,
        retcode,
    ].filter((value): value is string => Boolean(value)));

    return {
        interfacePaths,
        expectedInterfacePath: interfacePaths[0] ?? null,
        errorMessages: quotedValues,
        retcode,
        responseFields,
        documentKeywords,
        requestPayloadProvided: request.provided,
        requestPayload: request.payload,
        requestFields: request.fields,
        searchQueries,
    };
}

function extractRequestPayload(text: string): {
    provided: boolean;
    payload: string | null;
    fields: string[];
} {
    const marker = /(?:请求(?:报文|参数|体)|request\b(?:\s*(?:payload|body|data))?)[\s]*(?:为|是)?[\s]*[:：]?\s*/i.exec(text);
    if (!marker) return {provided: false, payload: null, fields: []};

    const remainder = text.slice(marker.index + marker[0].length);
    const nextSectionIndex = remainder.search(
        /\n\s*(?:响应|返回|response|retcode|retmsg|retmsge|method)(?:报文)?\s*(?:为|是)?\s*[:：]?/i,
    );
    const candidate = remainder.slice(0, nextSectionIndex >= 0 ? nextSectionIndex : undefined).trim();
    if (!candidate) return {provided: false, payload: null, fields: []};

    const fields = unique(
        Array.from(candidate.matchAll(/["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[:=]/g)).map((match) => match[1]),
    );
    return {
        provided: true,
        payload: candidate,
        fields,
    };
}

async function readAllinpayDocument(args: ReadDocumentArgs) {
    const url = args.url?.trim() || ALLINPAY_DOC_URL;
    const keyword = args.keyword?.trim() || "";
    const rootDocument = await fetchDocument(url);
    const allMatchingLinks = uniqueDocumentLinks(extractDocumentLinks(rootDocument.html)
        .filter((link) => !keyword || link.title.includes(keyword)));
    const matchingLinks = allMatchingLinks.slice(0, clamp(args.maxPages ?? 3, 1, 3));
    const linkedDocuments: Array<{
        url: string;
        title: string;
        content: string;
        endpoints: DocumentEndpoint[];
    }> = [];

    for (const link of matchingLinks) {
        const document = await fetchDocument(link.url);
        linkedDocuments.push({
            url: link.url,
            title: document.title || link.title,
            content: truncate(stripHtml(document.html), MAX_LINKED_DOCUMENT_LENGTH),
            endpoints: extractDocumentEndpoints(document.html, document.url),
        });
    }

    const documentEndpoints = [
        ...extractDocumentEndpoints(rootDocument.html, rootDocument.url),
        ...linkedDocuments.flatMap((document) => document.endpoints),
    ];
    return {
        sourceUrl: rootDocument.url,
        title: rootDocument.title,
        keyword: keyword || null,
        matchingLinks,
        matchingLinkCount: allMatchingLinks.length,
        content: truncate(stripHtml(rootDocument.html), MAX_DOCUMENT_LENGTH),
        linkedDocuments,
        documentEndpoints,
    };
}

export async function resolveAllinpayInterface(keyword: string): Promise<OfficialInterfaceDefinition | null> {
    const normalizedKeyword = keyword.trim();
    if (!normalizedKeyword) return null;

    const document = await readAllinpayDocument({
        url: ALLINPAY_DOC_URL,
        keyword: normalizedKeyword,
        maxPages: 3,
    });
    if (document.matchingLinkCount !== 1) return null;
    const endpoint = selectUniqueProductionEndpoint(document.linkedDocuments);
    if (!endpoint) return null;

    const linkedDocument = document.linkedDocuments.find((item) => item.url === endpoint.sourceUrl);
    if (!linkedDocument) return null;

    return {
        keyword: normalizedKeyword,
        documentUrl: linkedDocument.url,
        documentTitle: linkedDocument.title,
        interfaceUrl: endpoint.url,
        routePath: endpoint.routePath,
    };
}

export function selectUniqueProductionEndpoint(documents: Array<{
    url: string;
    endpoints: DocumentEndpoint[];
}>): DocumentEndpoint | null {
    const endpoints = documents
        .flatMap((document) => document.endpoints)
        .filter((endpoint) => endpoint.kind === "production" && Boolean(endpoint.routePath));
    const uniqueEndpoints = uniqueDocumentEndpoints(endpoints);
    return uniqueEndpoints.length === 1 ? uniqueEndpoints[0] : null;
}

export function extractDocumentEndpoints(html: string, sourceUrl: string): DocumentEndpoint[] {
    const endpoints: DocumentEndpoint[] = [];
    const endpointPattern = /(接口地址|测试地址)\s*[:：]\s*(https?:\/\/[^\s<"'，。]+)/gi;
    for (const match of html.matchAll(endpointPattern)) {
        const endpointUrl = new URL(match[2]);
        const path = endpointUrl.pathname;
        endpoints.push({
            url: endpointUrl.toString(),
            path,
            routePath: extractControllerRoutePath(path),
            kind: match[1] === "测试地址" ? "test" : "production",
            sourceUrl,
        });
    }
    return uniqueDocumentEndpoints(endpoints);
}

function extractControllerRoutePath(path: string): string {
    const segments = path.split("/").filter(Boolean);
    const contextIndex = segments.findIndex((segment) => /(?:^|-)openapis-web$/i.test(segment));
    const routeSegments = contextIndex >= 0 ? segments.slice(contextIndex + 1) : segments;
    return `/${routeSegments.join("/")}`;
}

function uniqueDocumentEndpoints(endpoints: DocumentEndpoint[]): DocumentEndpoint[] {
    const seen = new Set<string>();
    return endpoints.filter((endpoint) => {
        const key = `${endpoint.kind}:${endpoint.url}:${endpoint.sourceUrl}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function uniqueDocumentLinks(links: DocumentLink[]): DocumentLink[] {
    const seen = new Set<string>();
    return links.filter((link) => {
        if (seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
    });
}

async function fetchDocument(inputUrl: string) {
    const url = new URL(inputUrl);
    if (
        url.protocol !== "https:" ||
        url.hostname !== "prodoc.allinpay.com" ||
        !url.pathname.startsWith("/doc/")
    ) {
        throw new Error("只允许读取 https://prodoc.allinpay.com/doc/ 下的文档。");
    }

    const response = await fetch(url, {
        headers: {"user-agent": "HelloPrompt-Shopoint/1.0"},
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
        throw new Error(`一码付文档请求失败：HTTP ${response.status}。`);
    }

    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > 4 * MAX_FILE_SIZE) {
        throw new Error("一码付文档响应过大，已拒绝读取。");
    }
    return {
        url: url.toString(),
        title: extractTitle(html),
        html,
    };
}

function extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? decodeHtmlEntities(stripHtml(match[1])).trim() : "";
}

function extractDocumentLinks(html: string): DocumentLink[] {
    const links: DocumentLink[] = [];
    const linkPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(linkPattern)) {
        const attributes = match[1];
        const href = attributes.match(/\bhref=["']([^"']+)["']/i)?.[1];
        const title = attributes.match(/\btitle=["']([^"']*)["']/i)?.[1] ||
            stripHtml(match[2]).trim();
        if (!href || !title) continue;
        const url = new URL(href, ALLINPAY_DOC_URL);
        if (url.hostname === "prodoc.allinpay.com" && url.pathname.startsWith("/doc/")) {
            links.push({url: url.toString(), title: decodeHtmlEntities(title).trim()});
        }
    }
    return links;
}

async function searchShopointCode(codeBasePath: string | undefined, args: SearchCodeArgs) {
    const root = await realpath(resolveCodeRoot(codeBasePath, args.root));
    const query = args.query.trim();
    if (!query) throw new Error("代码搜索关键词不能为空。");

    const maxResults = clamp(args.maxResults ?? MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
    const filePattern = args.filePattern?.trim();
    const matches: Array<{path: string; line: number; text: string}> = [];
    await walkAndSearch(root, root, query, filePattern, maxResults, matches);

    return {
        root: args.root,
        query,
        matches,
        truncated: matches.length >= maxResults,
    };
}

async function verifyShopointEntry(codeBasePath: string | undefined, args: VerifyEntryArgs) {
    const root = await realpath(resolveCodeRoot(codeBasePath, args.root));
    const expectedPath = args.expectedPath.trim();
    if (!expectedPath) throw new Error("expectedPath 必须是接口路径。");
    const normalizedExpectedPath = normalizeInterfacePath(expectedPath);

    const filePath = await resolveExistingWithinRoot(root, args.path);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("指定路径不是文件。");
    if (fileInfo.size > MAX_FILE_SIZE) throw new Error("文件过大，拒绝读取。");

    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
    const mappingRoutes = extractMappingRoutes(lines);
    const matchedRoute = mappingRoutes.find((_, index) =>
        buildRouteCandidates(mappingRoutes, index).some((candidate) => candidate.path === normalizedExpectedPath),
    );
    const matched = mappingRoutes.some((_, index) =>
        buildRouteCandidates(mappingRoutes, index).some((candidate) => candidate.path === normalizedExpectedPath),
    );
    const detectedPath = matched
        ? buildRouteCandidates(mappingRoutes, mappingRoutes.indexOf(matchedRoute!))
            .find((candidate) => candidate.path === normalizedExpectedPath)?.path ?? ""
        : "";
    const evidence = matched
        ? uniqueEvidence(
            buildRouteCandidates(mappingRoutes, mappingRoutes.indexOf(matchedRoute!))
                .find((candidate) => candidate.path === normalizedExpectedPath)?.evidence ?? [],
        )
        : uniqueEvidence(mappingRoutes).slice(0, 12);

    return {
        root: args.root,
        path: args.path,
        expectedPath,
        normalizedExpectedPath,
        matched,
        detectedPath,
        evidence,
        reason: matched
            ? "候选文件中的映射注解组合后，与期望接口完整路径一致（仅忽略首个斜杠差异）。"
            : "候选文件未发现与期望接口完整路径一致且大小写相同的映射证据。",
    };
}

type EntryTraceCandidate = {
    root: "controller";
    path: string;
    routePath: string;
    implementationPath: string;
    implementationLine: number;
    controllerMethod: string;
    evidence: Array<{line: number; text: string}>;
};

async function traceShopointEntry(codeBasePath: string | undefined, args: TraceEntryArgs) {
    const sourceRoot = await realpath(resolveCodeRoot(codeBasePath, args.root));
    const sourcePath = await resolveExistingWithinRoot(sourceRoot, args.path);
    const sourceInfo = await stat(sourcePath);
    if (!sourceInfo.isFile()) throw new Error("指定路径不是文件。");
    if (sourceInfo.size > MAX_FILE_SIZE) throw new Error("文件过大，拒绝读取。");
    if (!Number.isSafeInteger(args.line) || args.line < 1) {
        throw new Error("line 必须是有效的文件行号。");
    }

    const expectedPath = args.expectedPath.trim();
    if (!expectedPath) throw new Error("expectedPath 必须是接口路径。");
    const normalizedExpectedPath = normalizeInterfacePath(expectedPath);
    const sourceLines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
    if (args.line > sourceLines.length) throw new Error("line 超出文件范围。");

    const serviceMethod = findEnclosingJavaMethod(sourceLines, args.line - 1);
    const discriminator = findInterfaceTypeDiscriminator(sourceLines, args.line - 1, serviceMethod?.line ?? 0);
    if (!serviceMethod || !discriminator) {
        return createTraceResult({
            args,
            expectedPath,
            normalizedExpectedPath,
            serviceMethod: serviceMethod?.name ?? "",
            discriminator: discriminator?.value ?? "",
            candidates: [],
        });
    }

    const controllerRoot = await realpath(resolveCodeRoot(codeBasePath, "controller"));
    const controllerFiles = await collectJavaFiles(controllerRoot);
    const interfaces = new Map<string, {path: string; lines: string[]}>();
    for (const filePath of controllerFiles) {
        const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
        const interfaceName = lines.join("\n").match(/\binterface\s+([A-Za-z_]\w*)\b/)?.[1];
        if (interfaceName) interfaces.set(interfaceName, {path: relative(controllerRoot, filePath), lines});
    }

    const candidates: EntryTraceCandidate[] = [];
    for (const filePath of controllerFiles) {
        const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
        const implementedInterface = lines.join("\n").match(/\bimplements\s+([A-Za-z_]\w*)\b/)?.[1];
        if (!implementedInterface || !containsServiceMethodCall(lines, serviceMethod.name)) continue;

        const interfaceFile = interfaces.get(implementedInterface);
        if (!interfaceFile) continue;
        for (const enumLine of findLinesContaining(lines, discriminator.value)) {
            const controllerMethod = findEnclosingJavaMethod(lines, enumLine);
            if (!controllerMethod) continue;
            const mapping = findInterfaceMethodMapping(interfaceFile.lines, controllerMethod.name);
            if (!mapping) continue;
            for (const route of mapping.routes) {
                candidates.push({
                    root: "controller",
                    path: interfaceFile.path,
                    routePath: route.path,
                    implementationPath: relative(controllerRoot, filePath),
                    implementationLine: controllerMethod.line,
                    controllerMethod: controllerMethod.name,
                    evidence: uniqueEvidence([
                        {line: args.line, text: sourceLines[args.line - 1].trim()},
                        {line: discriminator.line, text: sourceLines[discriminator.line - 1].trim()},
                        {line: controllerMethod.line, text: lines[controllerMethod.line - 1].trim()},
                        ...findServiceMethodCallEvidence(lines, serviceMethod.name, controllerMethod.line - 1),
                        ...route.evidence,
                    ]),
                });
            }
        }
    }

    return createTraceResult({
        args,
        expectedPath,
        normalizedExpectedPath,
        serviceMethod: serviceMethod.name,
        discriminator: discriminator.value,
        candidates,
    });
}

function createTraceResult(input: {
    args: TraceEntryArgs;
    expectedPath: string;
    normalizedExpectedPath: string;
    serviceMethod: string;
    discriminator: string;
    candidates: EntryTraceCandidate[];
}) {
    const uniqueCandidates = uniqueTraceCandidates(input.candidates);
    const matches = uniqueCandidates.filter((candidate) => candidate.routePath === input.normalizedExpectedPath);
    const entry = matches.length === 1 ? matches[0] : undefined;
    return {
        root: entry?.root ?? "controller",
        path: entry?.path ?? "",
        expectedPath: input.expectedPath,
        normalizedExpectedPath: input.normalizedExpectedPath,
        source: {root: input.args.root, path: input.args.path, line: input.args.line},
        serviceMethod: input.serviceMethod || null,
        discriminator: input.discriminator || null,
        matched: Boolean(entry),
        detectedPath: entry?.routePath ?? "",
        evidence: entry?.evidence ?? [],
        candidates: uniqueCandidates,
        reason: entry
            ? "已从服务错误所在的 InterfaceType 分支反推到 Controller 方法，并在其实现的接口映射中确认了期望路由。"
            : input.serviceMethod && input.discriminator
                ? "已识别服务分支，但未能唯一确认与期望接口完整路径一致的 Controller 映射。"
                : "错误行不在可识别的服务方法 InterfaceType 分支中，无法安全反推 Controller 入口。",
    };
}

function findEnclosingJavaMethod(lines: string[], line: number): {name: string; line: number} | null {
    for (let index = line; index >= 0; index -= 1) {
        const match = lines[index].match(
            /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>, ?\[\].]+\s+([A-Za-z_]\w*)\s*\(/,
        );
        if (match) return {name: match[1], line: index + 1};
    }
    return null;
}

function findInterfaceTypeDiscriminator(
    lines: string[],
    line: number,
    methodLine: number,
): {value: string; line: number} | null {
    for (let index = line; index >= methodLine - 1; index -= 1) {
        const match = lines[index].match(/\b(InterfaceType\.[A-Z_]+\s*\.getValue\(\))/);
        if (match) return {value: match[1].replace(/\s+/g, ""), line: index + 1};
    }
    return null;
}

function containsServiceMethodCall(lines: string[], serviceMethod: string): boolean {
    return new RegExp(`\\bsybService\\s*\\.\\s*${escapeRegExp(serviceMethod)}\\s*\\(`).test(lines.join("\n"));
}

function findLinesContaining(lines: string[], value: string): number[] {
    const normalizedValue = value.replace(/\s+/g, "");
    return lines.flatMap((line, index) =>
        line.replace(/\s+/g, "").includes(normalizedValue) ? [index] : [],
    );
}

function findServiceMethodCallEvidence(lines: string[], serviceMethod: string, controllerMethodLine: number) {
    const expression = new RegExp(`\\bsybService\\s*\\.\\s*${escapeRegExp(serviceMethod)}\\s*\\(`);
    const methodEnd = findJavaMethodEnd(lines, controllerMethodLine);
    const index = lines.findIndex((line, lineIndex) =>
        lineIndex >= controllerMethodLine && lineIndex <= methodEnd && expression.test(line),
    );
    const fallbackIndex = index >= 0 ? index : lines.findIndex((line) => expression.test(line));
    return fallbackIndex >= 0 ? [{line: fallbackIndex + 1, text: lines[fallbackIndex].trim()}] : [];
}

function findJavaMethodEnd(lines: string[], methodLine: number): number {
    let braceDepth = 0;
    let started = false;
    for (let index = methodLine; index < lines.length; index += 1) {
        for (const character of lines[index]) {
            if (character === "{") {
                started = true;
                braceDepth += 1;
            } else if (character === "}" && started) {
                braceDepth -= 1;
                if (braceDepth === 0) return index;
            }
        }
    }
    return lines.length - 1;
}

function findInterfaceMethodMapping(lines: string[], methodName: string): {
    routes: Array<{path: string; evidence: Array<{line: number; text: string}>}>;
} | null {
    const methodIndex = lines.findIndex((line) =>
        new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`).test(line),
    );
    if (methodIndex < 0) return null;

    let start = methodIndex;
    while (start > 0 && !/[;}]\s*$/.test(lines[start - 1])) start -= 1;
    const mappingLines = lines.slice(start, methodIndex);
    const routes = extractMappingRoutes(mappingLines).map((route) => ({
        path: route.path,
        evidence: [{line: start + route.line, text: route.text}],
    }));
    return {routes};
}

function uniqueTraceCandidates(candidates: EntryTraceCandidate[]) {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = `${candidate.path}:${candidate.routePath}:${candidate.implementationPath}:${candidate.implementationLine}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function collectJavaFiles(directory: string, files: string[] = []): Promise<string[]> {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) {
                await collectJavaFiles(resolve(directory, entry.name), files);
            }
        } else if (entry.isFile() && entry.name.endsWith(".java")) {
            files.push(resolve(directory, entry.name));
        }
    }
    return files;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMappingRoutes(lines: string[]): Array<{line: number; text: string; path: string}> {
    const source = lines.join("\n");
    const routes: Array<{line: number; text: string; path: string}> = [];
    const annotationPattern = /@(Request|Get|Post|Put|Delete|Patch)Mapping\b[\s\S]*?\)/g;
    for (const match of source.matchAll(annotationPattern)) {
        const annotation = match[0];
        const line = source.slice(0, match.index ?? 0).split("\n").length;
        const text = annotation.replace(/\s+/g, " ").trim();
        for (const pathMatch of annotation.matchAll(/["']([^"']+)["']/g)) {
            const path = normalizeInterfacePath(pathMatch[1]);
            if (path) routes.push({line, text, path});
        }
    }
    return routes;
}

function buildRouteCandidates(
    routes: Array<{line: number; text: string; path: string}>,
    start: number,
): Array<{path: string; evidence: Array<{line: number; text: string}>}> {
    const candidates: Array<{path: string; evidence: Array<{line: number; text: string}>}> = [];
    let path = "";
    const evidence: Array<{line: number; text: string}> = [];
    for (let index = start; index < routes.length; index += 1) {
        path = path ? `${path}/${routes[index].path}` : routes[index].path;
        evidence.push({line: routes[index].line, text: routes[index].text});
        candidates.push({path, evidence: [...evidence]});
    }
    return candidates;
}

function normalizeInterfacePath(path: string): string {
    const value = path.trim();
    return value.startsWith("/") ? value.slice(1) : value;
}

function uniqueEvidence(values: Array<{line: number; text: string}>) {
    const seen = new Set<string>();
    return values.filter((value) => {
        const key = `${value.line}:${value.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function unique(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

async function walkAndSearch(
    root: string,
    directory: string,
    query: string,
    filePattern: string | undefined,
    maxResults: number,
    matches: Array<{path: string; line: number; text: string}>,
): Promise<void> {
    if (matches.length >= maxResults) return;
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) {
                await walkAndSearch(root, resolve(directory, entry.name), query, filePattern, maxResults, matches);
            }
            continue;
        }
        if (!entry.isFile() || !isSearchableFile(entry.name, filePattern)) continue;

        const filePath = resolve(directory, entry.name);
        const fileInfo = await stat(filePath);
        if (fileInfo.size > MAX_FILE_SIZE) continue;
        const content = await readFile(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
            if (matches.length < maxResults && line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
                matches.push({
                    path: relative(root, filePath),
                    line: index + 1,
                    text: line.trim().slice(0, 600),
                });
            }
        });
    }
}

async function readShopointFile(codeBasePath: string | undefined, args: ReadCodeFileArgs) {
    const root = await realpath(resolveCodeRoot(codeBasePath, args.root));
    const filePath = await resolveExistingWithinRoot(root, args.path);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("指定路径不是文件。");
    if (fileInfo.size > MAX_FILE_SIZE) throw new Error("文件过大，拒绝读取。");

    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
    const startLine = clamp(args.startLine ?? 1, 1, lines.length || 1);
    const endLine = clamp(args.endLine ?? startLine + 199, startLine, Math.min(lines.length, startLine + 199));
    return {
        root: args.root,
        path: args.path,
        startLine,
        endLine,
        content: lines
            .slice(startLine - 1, endLine)
            .map((line, index) => `${startLine + index}: ${line}`)
            .join("\n"),
    };
}

function resolveCodeRoot(codeBasePath: string | undefined, rootKey: string): string {
    if (!codeBasePath) {
        throw new Error("未配置 CODE_BASE_PATH（兼容旧配置 CODE_BASE_URL），无法访问本地代码库。");
    }
    const roots: Record<string, string> = {
        controller: "openapis-web/src/main/java/com/shopoint/openapis/syb/controller",
        syb: "openapis-web/src/main/java/com/shopoint/openapis/syb",
        "organization-common": "organization-common/src/main/java/com/shopoint",
        organization: "organization/src/main/java/com/shopoint",
        "activity-common": "activity-common/src/main/java/com/shopoint",
        activity: "activity/src/main/java/com/shopoint",
        "order-common": "order-common/src/main/java/com/shopoint",
        order: "order/src/main/java/com/shopoint",
        "basic-common": "basic-common/src/main/java/com/shopoint",
        basic: "basic/src/main/java/com/shopoint",
        "goods-common": "goods-common/src/main/java/com/shopoint",
        goods: "goods/src/main/java/com/shopoint",
        "third-party-common": "third-party-common/src/main/java/com/shopoint",
        "third-party": "third-party/src/main/java/com/shopoint",
    };
    const relativeRoot = roots[rootKey];
    if (!relativeRoot) throw new Error(`不支持的代码库根目录：${rootKey}。`);
    return resolveWithinRoot(resolve(codeBasePath), relativeRoot);
}

function resolveWithinRoot(root: string, requestedPath: string): string {
    if (isAbsolute(requestedPath)) throw new Error("文件路径必须是相对于代码库根目录的路径。");
    const candidate = resolve(root, requestedPath);
    const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
    if (candidate !== root && !candidate.startsWith(rootWithSeparator)) {
        throw new Error("文件路径超出允许的代码库范围。");
    }
    return candidate;
}

async function resolveExistingWithinRoot(root: string, requestedPath: string): Promise<string> {
    const candidate = resolveWithinRoot(root, requestedPath);
    const resolvedCandidate = await realpath(candidate);
    const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
    if (resolvedCandidate !== root && !resolvedCandidate.startsWith(rootWithSeparator)) {
        throw new Error("文件路径超出允许的代码库范围。");
    }
    return resolvedCandidate;
}

function isSearchableFile(fileName: string, filePattern: string | undefined): boolean {
    if (filePattern && !globMatches(fileName, filePattern)) return false;
    return TEXT_EXTENSIONS.has(fileName.slice(fileName.lastIndexOf(".")).toLowerCase());
}

function globMatches(value: string, pattern: string): boolean {
    const expression = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${expression}$`, "i").test(value);
}

function stripHtml(html: string): string {
    return decodeHtmlEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, "\n")
            .replace(/<style[\s\S]*?<\/style>/gi, "\n")
            .replace(/<!--[\s\S]*?-->/g, "\n")
            .replace(/<\/?(p|div|li|tr|br|h[1-6]|pre|section|table)[^>]*>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s*\n+/g, "\n")
            .trim(),
    );
}

function decodeHtmlEntities(value: string): string {
    const namedEntities: Record<string, string> = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": "\"",
        "&#39;": "'",
    };
    return value
        .replace(/&(nbsp|amp|lt|gt|quot);|&#39;/gi, (entity) => namedEntities[entity.toLowerCase()] ?? entity)
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[内容已截断]`;
}

function clamp(value: number, min: number, max: number): number {
    return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : min;
}
