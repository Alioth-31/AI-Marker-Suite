'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, parseTask, authorized } = require('../agent-bridge/server');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
const request = { messages: [{ role: 'user', content: [
    { type: 'text', text: '请按评分标准评阅。满分 10 分。' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }
] }] };

test('pairing token is required', () => {
    assert.equal(authorized('Bearer secret', 'secret'), true);
    assert.equal(authorized('Bearer wrong', 'secret'), false);
    assert.equal(authorized('', 'secret'), false);
});
test('grading requires an inline image', () => {
    assert.throws(() => parseTask({ messages: [{ content: 'text only' }] }), /图片/);
    const parsed = parseTask(request);
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.images[0].ext, '.png');
});
test('external image URLs cannot be fetched', () => {
    const body = JSON.parse(JSON.stringify(request));
    body.messages[0].content[1].image_url.url = 'https://example.com/test.png';
    assert.throws(() => parseTask(body), /内联/);
});
test('authenticated HTTP requests return OpenAI-compatible grading', async () => {
    const server = createServer({ token: 'test-token', status: () => true,
        grade: async () => '【答案复述】\n测试\n【评分依据】\n符合\n【得分】\n8' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    async function call(token) {
        return new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions',
                method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' } }, res => {
                let str = '';
                res.on('data', chunk => { str += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(str) }));
            });
            req.on('error', reject);
            req.end(JSON.stringify(request));
        });
    }
    try {
        assert.equal((await call('Bearer wrong')).status, 401);
        const ok = await call('Bearer test-token');
        assert.equal(ok.status, 200);
        assert.equal(ok.data.choices[0].finish_reason, 'stop');
        assert.match(ok.data.choices[0].message.content, /【得分】/);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
