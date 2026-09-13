import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createShopointTools,
    extractDocumentEndpoints,
    selectUniqueProductionEndpoint,
} from "./tools.js";

function getTool(name: string) {
    const tool = createShopointTools(undefined).tools.find((candidate) => candidate.name === name);
    if (!tool?.handler) throw new Error(`tool handler not found: ${name}`);
    return tool.handler;
}

test("extracts interface and response facts from the user input", async () => {
    const text = [
        "<current_datetime>2026-09-13T13:35:54.777+08:00</current_datetime>",
        "访问一码付的3.1统一扫码接口时，返回“商户对接参数未配置”。",
        'body: {"retcode": "FAIL", "retmsg": "商户对接参数未配置"}',
        "method: /apiweb/unitorder/scanqrpay",
        "retcode: FAIL",
        "retmsge: 商户对接参数未配置",
    ].join("\n");
    const result = await getTool("extract_shopoint_facts")({text}) as Record<string, unknown>;

    assert.equal(result.expectedInterfacePath, "/apiweb/unitorder/scanqrpay");
    assert.deepEqual(result.errorMessages, ["商户对接参数未配置"]);
    assert.deepEqual(result.responseFields, ["body", "retcode", "retmsg", "method", "retmsge"]);
    assert.deepEqual(result.documentKeywords, ["3.1统一扫码"]);
    assert.equal(result.requestPayloadProvided, false);
    assert.deepEqual(result.searchQueries, [
        "/apiweb/unitorder/scanqrpay",
        "unitorder",
        "scanqrpay",
        "商户对接参数未配置",
        "FAIL",
    ]);
});

test("does not treat documentation or source file URLs as the reported interface path", async () => {
    const text = [
        "官方文档：https://prodoc.allinpay.com/doc/1923/",
        "检查文件：/Users/md07/code/HelloPrompt/src/server/features/shopoint/service.ts",
        "报文地址：`/apiweb/unitorder/scanqrpay`",
    ].join("\n");
    const result = await getTool("extract_shopoint_facts")({text}) as Record<string, unknown>;

    assert.equal(result.expectedInterfacePath, "/apiweb/unitorder/scanqrpay");
});

test("uses the official endpoint URL to derive the controller route path", () => {
    const endpoints = extractDocumentEndpoints(
        [
            '<meta name="description" content="接口地址：https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay">',
            "<p>接口地址：https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay</p>",
            "<p>测试地址：https://dms-api-test.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay</p>",
        ].join("\n"),
        "https://prodoc.allinpay.com/doc/1923/",
    );

    assert.deepEqual(endpoints, [
        {
            url: "https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
            path: "/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
            routePath: "/szyx/apiweb/unitorder/scanqrpay",
            kind: "production",
            sourceUrl: "https://prodoc.allinpay.com/doc/1923/",
        },
        {
            url: "https://dms-api-test.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
            path: "/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
            routePath: "/szyx/apiweb/unitorder/scanqrpay",
            kind: "test",
            sourceUrl: "https://prodoc.allinpay.com/doc/1923/",
        },
    ]);
});

test("selects one production endpoint from the matched child document", () => {
    const endpoint = selectUniqueProductionEndpoint([{
        url: "https://prodoc.allinpay.com/doc/1923/",
        endpoints: extractDocumentEndpoints(
            [
                "<p>接口地址：https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay</p>",
                "<p>测试地址：https://dms-api-test.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay</p>",
            ].join("\n"),
            "https://prodoc.allinpay.com/doc/1923/",
        ),
    }]);

    assert.deepEqual(endpoint, {
        url: "https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
        path: "/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
        routePath: "/szyx/apiweb/unitorder/scanqrpay",
        kind: "production",
        sourceUrl: "https://prodoc.allinpay.com/doc/1923/",
    });
});

test("rejects ambiguous production endpoints", () => {
    const endpoint = selectUniqueProductionEndpoint([
        {
            url: "https://prodoc.allinpay.com/doc/1923/",
            endpoints: [{
                url: "https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
                path: "/shopoint-openapis-web/szyx/apiweb/unitorder/scanqrpay",
                routePath: "/szyx/apiweb/unitorder/scanqrpay",
                kind: "production",
                sourceUrl: "https://prodoc.allinpay.com/doc/1923/",
            }],
        },
        {
            url: "https://prodoc.allinpay.com/doc/2028/",
            endpoints: [{
                url: "https://dms-api.shopoint.cn/shopoint-openapis-web/szyx/apiweb/other/scan",
                path: "/shopoint-openapis-web/szyx/apiweb/other/scan",
                routePath: "/szyx/apiweb/other/scan",
                kind: "production",
                sourceUrl: "https://prodoc.allinpay.com/doc/2028/",
            }],
        },
    ]);

    assert.equal(endpoint, null);
});

test("extracts request payload fields without treating the response body as a request", async () => {
    const text = [
        "请求报文为：",
        '{"merchantId":"m001","amount":"100"}',
        "响应报文为：",
        '{"retcode":"FAIL"}',
    ].join("\n");
    const result = await getTool("extract_shopoint_facts")({text}) as Record<string, unknown>;

    assert.equal(result.requestPayloadProvided, true);
    assert.equal(result.requestPayload, '{"merchantId":"m001","amount":"100"}');
    assert.deepEqual(result.requestFields, ["merchantId", "amount"]);
});

test("verifies a composed controller mapping instead of trusting the file name", async () => {
    const codeBasePath = await mkdtemp(join(tmpdir(), "helloprompt-shopoint-"));
    const root = join(codeBasePath, "openapis-web/src/main/java/com/shopoint/openapis/syb/controller");
    const path = "UnitOrderController.java";
    try {
        await mkdir(root, {recursive: true});
        await writeFile(join(root, path), [
            '@RequestMapping("/apiweb/unitorder")',
            "public class UnitOrderController {",
            '    @PostMapping("/scanqrpay")',
            "    public void scanQrPay() {}",
            "}",
        ].join("\n"));

        const tool = createShopointTools(codeBasePath).tools.find((candidate) => candidate.name === "verify_shopoint_entry");
        if (!tool?.handler) throw new Error("verify_shopoint_entry handler not found");
        const matched = await tool.handler({
            root: "controller",
            path,
            expectedPath: "/apiweb/unitorder/scanqrpay",
        }) as Record<string, unknown>;
        const matchedWithoutLeadingSlash = await tool.handler({
            root: "controller",
            path,
            expectedPath: "apiweb/unitorder/scanqrpay",
        }) as Record<string, unknown>;
        const mismatched = await tool.handler({
            root: "controller",
            path,
            expectedPath: "/apiweb/other/scanqrpay",
        }) as Record<string, unknown>;
        const mismatchedCase = await tool.handler({
            root: "controller",
            path,
            expectedPath: "/apiweb/UnitOrder/scanqrpay",
        }) as Record<string, unknown>;

        assert.equal(matched.matched, true);
        assert.equal(matched.detectedPath, "apiweb/unitorder/scanqrpay");
        assert.equal(matchedWithoutLeadingSlash.matched, true);
        assert.equal(mismatched.matched, false);
        assert.equal(mismatchedCase.matched, false);
    } finally {
        await rm(codeBasePath, {recursive: true, force: true});
    }
});

test("returns error-message search locations for the client to display", async () => {
    const codeBasePath = await mkdtemp(join(tmpdir(), "helloprompt-shopoint-"));
    const root = join(codeBasePath, "openapis-web/src/main/java/com/shopoint/openapis/syb/controller");
    try {
        await mkdir(root, {recursive: true});
        await writeFile(join(root, "UnitOrderController.java"), [
            '@RequestMapping("/szyx/apiweb/unitorder")',
            "public class UnitOrderController {",
            '    throw new BusinessException("商户对接参数未配置");',
            "}",
        ].join("\n"));

        const tool = createShopointTools(codeBasePath).tools.find((candidate) => candidate.name === "search_shopoint_code");
        if (!tool?.handler) throw new Error("search_shopoint_code handler not found");
        const result = await tool.handler({
            root: "controller",
            query: "商户对接参数未配置",
        }) as Record<string, unknown>;

        assert.equal(result.root, "controller");
        assert.equal(result.query, "商户对接参数未配置");
        assert.deepEqual(result.matches, [{
            path: "UnitOrderController.java",
            line: 3,
            text: 'throw new BusinessException("商户对接参数未配置");',
        }]);
    } finally {
        await rm(codeBasePath, {recursive: true, force: true});
    }
});

test("traces a service InterfaceType branch back to the matching controller route", async () => {
    const codeBasePath = await mkdtemp(join(tmpdir(), "helloprompt-shopoint-"));
    const sybRoot = join(codeBasePath, "openapis-web/src/main/java/com/shopoint/openapis/syb");
    const controllerRoot = join(sybRoot, "controller");
    try {
        await mkdir(join(controllerRoot, "impl"), {recursive: true});
        await mkdir(join(sybRoot, "service/impl"), {recursive: true});
        await writeFile(join(sybRoot, "service/impl/SybServiceImpl.java"), [
            "public class SybServiceImpl {",
            "    public void pay(Integer interfaceType) {",
            "        if (interfaceType == InterfaceType.UNION_PAY.getValue()) {",
            '            response("paytype为空");',
            "        }",
            "    }",
            "}",
        ].join("\n"));
        await writeFile(join(controllerRoot, "ISybController.java"), [
            "public interface ISybController {",
            '    @PostMapping("/apiweb/unitorder/pay")',
            "    void unionPay();",
            "}",
        ].join("\n"));
        await writeFile(join(controllerRoot, "ISzyxController.java"), [
            "public interface ISzyxController {",
            '    @PostMapping("/szyx/apiweb/unitorder/pay")',
            "    void unionPay();",
            "}",
        ].join("\n"));
        await writeFile(join(controllerRoot, "impl/SybControllerImpl.java"), [
            "public class SybControllerImpl implements ISybController {",
            "    public void unionPay() {",
            "        sybService.pay(InterfaceType.UNION_PAY.getValue());",
            "    }",
            "}",
        ].join("\n"));
        await writeFile(join(controllerRoot, "impl/SzyxControllerImpl.java"), [
            "public class SzyxControllerImpl implements ISzyxController {",
            "    private void commonEnter(Integer interfaceType) {",
            "        sybService.pay(interfaceType);",
            "    }",
            "    public void unionPay() {",
            "        commonEnter(InterfaceType.UNION_PAY.getValue());",
            "    }",
            "}",
        ].join("\n"));

        const tool = createShopointTools(codeBasePath).tools.find((candidate) => candidate.name === "trace_shopoint_entry");
        if (!tool?.handler) throw new Error("trace_shopoint_entry handler not found");
        const result = await tool.handler({
            root: "syb",
            path: "service/impl/SybServiceImpl.java",
            line: 4,
            expectedPath: "/szyx/apiweb/unitorder/pay",
        }) as Record<string, unknown>;

        assert.equal(result.matched, true);
        assert.equal(result.detectedPath, "szyx/apiweb/unitorder/pay");
        assert.equal(result.path, "ISzyxController.java");
        assert.equal(result.serviceMethod, "pay");
        assert.equal(result.discriminator, "InterfaceType.UNION_PAY.getValue()");
        const candidates = result.candidates as Array<Record<string, unknown>>;
        assert.deepEqual(candidates.map((candidate) => candidate.routePath), [
            "apiweb/unitorder/pay",
            "szyx/apiweb/unitorder/pay",
        ]);
        assert.deepEqual((candidates[0].evidence as Array<Record<string, unknown>>)[3], {
            line: 3,
            text: "sybService.pay(InterfaceType.UNION_PAY.getValue());",
        });
    } finally {
        await rm(codeBasePath, {recursive: true, force: true});
    }
});
