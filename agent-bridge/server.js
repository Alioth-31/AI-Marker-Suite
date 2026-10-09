#!/usr/bin/env node
/**
 * AI-Marker-Suite local Agent Bridge.
 *
 * Exposes one OpenAI-compatible endpoint to the existing userscript; delegates
 * grading to an authenticated, locally installed Codex CLI. No cloud API key
 * is needed in the userscript. Images are removed after every request.
 *
 * Node.js 20+. Run: node agent-bridge/server.js
 */
'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.AI_MARKER_AGENT_PORT || 37521);
const MAX_BODY = 24 * 1024 * 1024;
const TIMEOUT_MS = 150000;
const STATE_DIR = path.join(os.homedir(), '.ai-marker-agent');
const TOKEN_PATH = path.join(STATE_DIR, 'pairing-token');

function getToken() {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(TOKEN_PATH)) {
        fs.writeFileSync(TOKEN_PATH, randomBytes(24).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

function authorized(value, token) {
    const given = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, data) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('图片请求超过 24MB 限制'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { reject(Object.assign(new Error('请求 JSON 无效'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}

function imageExtension(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
    if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return '.jpg';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    throw Object.assign(new Error('仅支持 PNG/JPEG/WebP 答卷图片'), { status: 422 });
}

function parseTask(body) {
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
        throw Object.assign(new Error('缺少 messages'), { status: 400 });
    }
    const parts = body.messages.flatMap(message => Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: String(message.content || '') }]);
    const text = parts.filter(x => x.type === 'text').map(x => x.text || '').join('\n');
    const pictures = parts.filter(x => x.type === 'image_url').map(x => x.image_url?.url);
    if (!text.trim() || !pictures.length || pictures.length > 12) {
        throw Object.assign(new Error('任务必须包含评分要求和 1~12 张图片'), { status: 422 });
    }
    const images = pictures.map(url => {
        const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(url || '');
        if (!match) throw Object.assign(new Error('仅接受内联答卷图片，拒绝远程 URL'), { status: 422 });
        const bytes = Buffer.from(match[1], 'base64');
        if (!bytes.length || bytes.length > MAX_BODY) {
            throw Object.assign(new Error('无效或过大的答卷图像'), { status: 422 });
        }
        return { bytes, ext: imageExtension(bytes) };
    });
    return { text, images };
}

const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        answer: { type: 'string', description: '按原任务要求生成的完整评分文本，保留【得分】及各小题分数格式' },
        needs_review: { type: 'boolean', description: '答案模糊、图片缺失或无法可靠评分时为 true' }
    },
    required: ['answer', 'needs_review']
};

function checkCodex() {
    // On Windows, installed Codex typically resolves through a .cmd wrapper.
    const probe = spawnSync('codex', ['--version'], {
        encoding: 'utf8', timeout: 6000, shell: process.platform === 'win32',
        windowsHide: true
    });
    return !probe.error && probe.status === 0;
}

async function invokeCodex(task, options = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-marker-'));
    try {
        const files = [];
        for (let i = 0; i < task.images.length; i++) {
            const name = path.join(dir, 'answer-' + i + task.images[i].ext);
            await fsp.writeFile(name, task.images[i].bytes);
            files.push(name);
        }
        const schemaFile = path.join(dir, 'schema.json');
        const resultFile = path.join(dir, 'result.json');
        await fsp.writeFile(schemaFile, JSON.stringify(RESULT_SCHEMA));
        const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only',
            '--output-schema', schemaFile, '--output-last-message', resultFile];
        for (const file of files) args.push('--image', file);
        args.push('-');

        const prompt = task.text + '\n\n' +
            '你正在执行真实阅卷辅助任务。只依据图片和评分标准回答；不要访问其他文件或使用外部工具。' +
            '请将原任务要求的完整评分文本放入 JSON 的 answer 字段；包含【得分】及全部子题分数。' +
            '如果书写无法识别、图片不完整或无法可靠评分，设置 needs_review=true，不要猜分。';
        const runner = options.runner || spawn;
        await new Promise((resolve, reject) => {
            const child = runner('codex', args, {
                cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
                shell: process.platform === 'win32', windowsHide: true
            });
            let stderr = '';
            let finished = false;
            const timer = setTimeout(() => {
                child.kill();
                fail(Object.assign(new Error('Codex 评分超时'), { status: 504 }));
            }, options.timeout || TIMEOUT_MS);
            function fail(err) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                reject(err);
            }
            child.on('error', err => fail(Object.assign(new Error('无法启动 Codex：' + err.message), { status: 503 })));
            child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1500); });
            child.stdout.resume();
            child.on('close', code => {
                if (finished) return;
                if (code !== 0) return fail(Object.assign(
                    new Error('Codex 未成功完成任务，请检查本地登录与额度。' + (stderr ? ' ' + stderr.slice(-300) : '')),
                    { status: 502 }));
                finished = true;
                clearTimeout(timer);
                resolve();
            });
            child.stdin.on('error', () => {});
            child.stdin.end(prompt);
        });
        const result = JSON.parse(await fsp.readFile(resultFile, 'utf8'));
        if (result.needs_review) throw Object.assign(new Error('Agent 要求人工复核，已停止自动填分'), { status: 422 });
        if (typeof result.answer !== 'string' || !result.answer.includes('【得分】')) {
            throw Object.assign(new Error('Agent 未返回有效的评分格式'), { status: 422 });
        }
        return result.answer;
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

function createServer(options = {}) {
    const token = options.token || getToken();
    const grade = options.grade || invokeCodex;
    const status = options.status || checkCodex;
    return http.createServer(async (req, res) => {
        // Listen on loopback and require an explicit pairing token.
        if (!authorized(req.headers.authorization, token)) {
            return send(res, 401, { error: { message: 'Agent Bridge 配对令牌无效' } });
        }
        if (req.method === 'GET' && req.url === '/health') {
            return send(res, 200, { status: status() ? 'ready' : 'unavailable', connector: 'codex' });
        }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
            return send(res, 404, { error: { message: 'Not found' } });
        }
        try {
            const task = parseTask(await readBody(req));
            const result = await grade(task);
            if (!result || typeof result !== 'string') throw Object.assign(new Error('Agent 返回内容为空'), { status: 422 });
            send(res, 200, {
                id: 'agent-' + randomBytes(8).toString('hex'),
                object: 'chat.completion',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: result } }]
            });
        } catch (err) {
            const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
            send(res, code, { error: { message: err.message || 'Agent Bridge 评分失败' } });
        }
    });
}

if (require.main === module) {
    const token = getToken();
    const server = createServer({ token });
    server.listen(PORT, HOST, () => {
        console.log('AI-Marker Agent Bridge: http://' + HOST + ':' + PORT);
        console.log('连接令牌（仅首次填写到脚本的 Agent 配置）：' + token);
        console.log(checkCodex() ? 'Codex CLI 已检测到' : '未检测到 Codex CLI，请安装并运行 codex login');
    });
}

module.exports = { createServer, parseTask, authorized, imageExtension, invokeCodex };
