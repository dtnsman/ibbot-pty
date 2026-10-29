// build-agent-doc.js
// 由单一数据源 agent.json 生成两份派生文件：
//   1) api.json        —— agent.json 的完整副本（供按 api.json 约定取说明的调用方）
//   2) js/agent-doc.js —— 页面内嵌版本，供 /agent.json、/api.json 路由直接返回（无网络请求、file:// 下也可用）
//
// 用法：node tools/build-agent-doc.js
// 修改 API 说明时只改 agent.json，然后重新运行本脚本。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcPath = path.join(root, 'agent.json');
const apiPath = path.join(root, 'api.json');
const jsPath = path.join(root, 'js', 'agent-doc.js');

const raw = fs.readFileSync(srcPath, 'utf8');
const doc = JSON.parse(raw); // 顺带校验 JSON 合法性

// 1) api.json：与 agent.json 逐字节一致
fs.writeFileSync(apiPath, raw, 'utf8');

// 2) js/agent-doc.js：把同一份对象内嵌进页面脚本
const literal = JSON.stringify(doc, null, 2).replace(/<\//g, '<\\/');
const js = `// agent-doc.js —— 自动生成，请勿手改
// 数据源：agent.json（供 HTTP-API 调用方读取）
// 生成命令：node tools/build-agent-doc.js
// 作用：页面内嵌同一份 API 说明，由 js/pty2-agent.js 的 /agent.json、/api.json 路由返回
(function (root) {
  'use strict';

  var DOC = ${literal};

  root.Pty2AgentDoc = DOC;
  if (typeof module !== 'undefined' && module.exports) module.exports = DOC;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
`;

fs.writeFileSync(jsPath, js, 'utf8');

const endpoints = Array.isArray(doc.endpoints) ? doc.endpoints.length : 0;
console.log('[build-agent-doc] agent.json  ->', path.relative(root, apiPath), '(copy)');
console.log('[build-agent-doc] agent.json  ->', path.relative(root, jsPath), '(embedded)');
console.log('[build-agent-doc] schema =', doc.schema, '| endpoints =', endpoints);
