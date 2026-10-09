// API / Agent 双模式：不改变现有 API Provider 和阅卷平台适配器。
const AgentMode = {
    MODE_KEY: 'ai-marker-execution-mode',
    TOKEN_KEY: 'ai-marker-agent-pairing-token',
    ENDPOINT: 'http://127.0.0.1:37521/v1/chat/completions',
    getMode() {
        return GM_getValue(this.MODE_KEY, 'api') === 'agent' ? 'agent' : 'api';
    },
    setMode(mode) {
        if (mode !== 'api' && mode !== 'agent') throw new Error('未知评分模式');
        GM_setValue(this.MODE_KEY, mode);
    },
    getToken() {
        return GM_getValue(this.TOKEN_KEY, '');
    },
    setToken(token) {
        GM_setValue(this.TOKEN_KEY, String(token || '').trim());
    },
    getCallConfig(apiConfig) {
        if (this.getMode() !== 'agent') return apiConfig;
        return {
            endpoint: this.ENDPOINT,
            apiKey: this.getToken(),
            model: 'connected-agent',
            reasoningEffort: '',
            outputLimitEnabled: false,
            maxOutputTokens: null
        };
    }
};
