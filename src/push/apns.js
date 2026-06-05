// APNs（iOS 套壳推送）—— 纯 Web Crypto 实现，Workers（生产 fetch 走 HTTP/2）+ Node 18+ 通用。
// 用 .p8 Auth Key 签 ES256 JWT，POST 到 api.push.apple.com（HTTP/2）。
//
// 环境变量：
//   APNS_KEY_P8     —— .p8 文件全文（含 -----BEGIN PRIVATE KEY----- ... 多行；CF secret 可直接粘贴）
//   APNS_KEY_ID     —— Auth Key 的 Key ID（10 位）
//   APNS_TEAM_ID    —— Apple 开发者 Team ID（10 位）
//   APNS_BUNDLE_ID  —— App 的 Bundle ID（如 app.nuojiji），作为 apns-topic
//   APNS_PRODUCTION —— '1' 用生产环境 api.push.apple.com；否则用 sandbox（开发证书/TestFlight 调试）
//
// 订阅 entry：{ channel:'apns', token:'<device hex token>' }

const enc = new TextEncoder();

function b64urlFromBytes(bytes) {
    let bin = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromStr(str) {
    return b64urlFromBytes(enc.encode(str));
}

function getApnsCfg(env) {
    const g = (k) => env?.[k] || (typeof process !== 'undefined' ? process.env?.[k] : undefined);
    const p8 = g('APNS_KEY_P8');
    const keyId = g('APNS_KEY_ID');
    const teamId = g('APNS_TEAM_ID');
    const bundleId = g('APNS_BUNDLE_ID');
    const production = String(g('APNS_PRODUCTION') || '') === '1';
    if (!p8 || !keyId || !teamId || !bundleId) return null;
    return { p8, keyId, teamId, bundleId, production };
}

// 把 .p8（PKCS#8 PEM）导入成 ECDSA P-256 签名密钥
async function importP8(p8) {
    const body = p8
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s+/g, '');
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
        'pkcs8', der,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
    );
}

// 缓存 JWT（APNs token 有效期建议 < 1h，复用避免每条都签）
let _jwtCache = { token: null, iat: 0, keyId: null };

async function getApnsJwt(cfg) {
    const now = Math.floor(Date.now() / 1000);
    if (_jwtCache.token && _jwtCache.keyId === cfg.keyId && (now - _jwtCache.iat) < 2400) {
        return _jwtCache.token;
    }
    const header = b64urlFromStr(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
    const payload = b64urlFromStr(JSON.stringify({ iss: cfg.teamId, iat: now }));
    const signingInput = `${header}.${payload}`;
    const key = await importP8(cfg.p8);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
    const jwt = `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
    _jwtCache = { token: jwt, iat: now, keyId: cfg.keyId };
    return jwt;
}

/**
 * 发一条 APNs 推送。
 * @param subscription { channel:'apns', token:'<hex device token>' }
 * @param payload { title, body, charId, userId, kind }
 * 返回 { ok, gone, reason }。gone:true 表示 token 失效（400 BadDeviceToken / 410 Unregistered）。
 */
export async function sendApns(env, subscription, payload) {
    const cfg = getApnsCfg(env);
    if (!cfg) return { ok: false, gone: false, reason: 'apns-not-configured' };
    const token = subscription?.token || subscription?.sub?.token;
    if (!token) return { ok: false, gone: true, reason: 'no-device-token' };

    try {
        const jwt = await getApnsJwt(cfg);
        const host = cfg.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
        const apsBody = JSON.stringify({
            aps: {
                alert: { title: payload.title || '糯叽机', body: payload.body || '有新消息' },
                sound: 'default',
            },
            // 自定义字段供 app 点击时定位会话
            charId: payload.charId, userId: payload.userId, kind: payload.kind || 'relay-outbox',
        });
        const res = await fetch(`${host}/3/device/${token}`, {
            method: 'POST',
            headers: {
                'authorization': `bearer ${jwt}`,
                'apns-topic': cfg.bundleId,
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'content-type': 'application/json',
            },
            body: apsBody,
        });
        if (res.status === 200) return { ok: true, gone: false };
        const txt = await res.text().catch(() => '');
        // BadDeviceToken / Unregistered / DeviceTokenNotForTopic → 订阅失效，删除
        const gone = res.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/i.test(txt);
        return { ok: false, gone, reason: `APNs HTTP ${res.status}: ${txt.slice(0, 200)}` };
    } catch (e) {
        return { ok: false, gone: false, reason: e?.message || String(e) };
    }
}
