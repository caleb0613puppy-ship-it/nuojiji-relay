// 推送订阅存储（按 inboxId）。一个 inbox 可有多个订阅（web/apns/fcm 多端）。
// 复用 outboxStore 的同后端：Workers 用同一个 KV，Node 用内存（订阅长期有效，
// 内存方案重启丢失 → 手机下次订阅会重新注册，可接受；持久需求走 sqlite 时一并落库）。
//
// 为简单起见，Phase 1 用独立的轻量实现，共享 createOutboxStore 选出的后端种类判断。

let _nodeSingleton = null;

export async function createSubStore(env) {
    if (env && env.OUTBOX && typeof env.OUTBOX.put === 'function') {
        return new KvSubStore(env.OUTBOX);
    }
    if (!_nodeSingleton) _nodeSingleton = new MemorySubStore();
    return _nodeSingleton;
}

const SUB_TTL_SEC = 60 * 60 * 24 * 60; // 60 天

class KvSubStore {
    constructor(kv) { this.kv = kv; }
    async add(inboxId, subscription) {
        const key = `s:${inboxId}:${subKey(subscription)}`;
        await this.kv.put(key, JSON.stringify(subscription), { expirationTtl: SUB_TTL_SEC });
    }
    async list(inboxId) {
        const out = [];
        let cursor;
        do {
            const res = await this.kv.list({ prefix: `s:${inboxId}:`, cursor });
            for (const k of res.keys) {
                const raw = await this.kv.get(k.name);
                if (raw) out.push(JSON.parse(raw));
            }
            cursor = res.list_complete ? null : res.cursor;
        } while (cursor);
        return out;
    }
    async remove(inboxId, subscription) {
        await this.kv.delete(`s:${inboxId}:${subKey(subscription)}`);
    }
}

class MemorySubStore {
    constructor() { this.byInbox = new Map(); }
    async add(inboxId, subscription) {
        if (!this.byInbox.has(inboxId)) this.byInbox.set(inboxId, new Map());
        this.byInbox.get(inboxId).set(subKey(subscription), subscription);
    }
    async list(inboxId) {
        const m = this.byInbox.get(inboxId);
        return m ? [...m.values()] : [];
    }
    async remove(inboxId, subscription) {
        const m = this.byInbox.get(inboxId);
        if (m) m.delete(subKey(subscription));
    }
}

// 订阅去重键：web 用 endpoint，apns/fcm 用 token
function subKey(subscription) {
    const s = subscription?.sub || subscription;
    return s?.endpoint || subscription?.token || subscription?.channel || 'default';
}
