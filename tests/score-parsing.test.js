const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { console: { log() {}, warn() {} } };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/core/prompt.js', 'utf8'), context);

const config = { subQuestions: [
    { id: 'a', label: '第一小题', maxScore: 6 },
    { id: 'b', label: '第二小题', maxScore: 6 }
] };

test('小题评分缺失时不生成零分', () => {
    const result = context.parseSubQuestionResponse('学生答案：未看清', config);
    assert.equal(result.score, null);
});

test('总分存在而小题缺失时保留待核查状态', () => {
    const result = context.parseSubQuestionResponse('【得分】8\n【答案复述】测试', config);
    assert.equal(result.score, null);
    assert.equal(result.subScores.length, 2);
});
