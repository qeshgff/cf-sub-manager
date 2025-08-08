/**
 * =================================================================================
 * Cloudflare Worker for Subscription Management API
 *
 * Captures all requests and routes them internally.
 * - Handles subscription generation under /sub/*
 * - Handles admin API calls under /admin/api/*
 *
 * This single file contains all backend logic for easy deployment.
 * =================================================================================
 */

// --- 辅助函数 / Utils ---

/**
 * 从订阅链接获取节点内容. 支持 data: URI.
 */
async function fetchSubscriptionNodes(subUrl) {
    if (subUrl.startsWith('data:')) {
        try {
            const base64Content = subUrl.split(',')[1];
            return atob(base64Content).split('\n');
        } catch (e) {
            console.error('Error decoding data URL:', e);
            return [];
        }
    }

    try {
        const response = await fetch(subUrl, {
            headers: { 'User-Agent': 'Cloudflare-Worker-SUB' },
        });
        if (!response.ok) {
            console.error(`Failed to fetch ${subUrl}: ${response.status}`);
            return [];
        }
        const text = await response.text();
        // 尝试Base64解码, 如果失败则认为是普通文本
        try {
            const decoded = atob(text);
            return decoded.split('\n').filter(line => line.trim() !== '');
        } catch (e) {
            return text.split('\n').filter(line => line.trim() !== '');
        }
    } catch (error) {
        console.error(`Exception while fetching ${subUrl}:`, error);
        return [];
    }
}

/**
 * 检查管理后台的认证
 */
async function checkAuth(request, env) {
    const configStr = await env.KV_NAMESPACE.get('CONFIG');
    const config = configStr ? JSON.parse(configStr) : {};
    const savedPassword = config.password;

    if (!savedPassword) {
        // 如果是首次配置，允许无密码访问 getConfig 和 saveConfig
        const url = new URL(request.url);
        if (url.pathname.endsWith('/getConfig') || url.pathname.endsWith('/saveConfig')) {
           return { success: true };
        }
        return { success: false, message: 'Not configured yet.', status: 403 };
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { success: false, message: 'Authorization header is missing.', status: 401 };
    }

    const token = authHeader.substring(7); // "Bearer ".length
    if (token !== savedPassword) {
        return { success: false, message: 'Invalid token.', status: 401 };
    }

    return { success: true };
}

/**
 * 解析 Xray 客户端配置文件 (JSON) 并提取分享链接
 * 支持 vmess, vless, trojan
 */
function parseXrayConfig(configStr) {
    try {
        const config = JSON.parse(configStr);
        if (!config.outbounds || !Array.isArray(config.outbounds)) return [];

        const nodes = [];
        for (const outbound of config.outbounds) {
            const remark = outbound.remark || 'imported-node';
            if (outbound.protocol === 'vmess' && outbound.settings?.vnext) {
                for (const server of outbound.settings.vnext) {
                    const vmess = {
                        v: "2",
                        ps: server.remark || remark,
                        add: server.address,
                        port: server.port,
                        id: server.users[0].id,
                        aid: server.users[0].alterId,
                        net: outbound.streamSettings?.network || 'tcp',
                        type: 'none',
                        host: outbound.streamSettings?.wsSettings?.headers?.Host || outbound.streamSettings?.httpSettings?.host?.[0] || '',
                        path: outbound.streamSettings?.wsSettings?.path || outbound.streamSettings?.httpSettings?.path || '',
                        tls: outbound.streamSettings?.security === 'tls' ? 'tls' : '',
                    };
                    nodes.push("vmess://" + btoa(JSON.stringify(vmess)));
                }
            } else if (outbound.protocol === 'vless' && outbound.settings?.vnext) {
                for (const server of outbound.settings.vnext) {
                   const params = new URLSearchParams({
                        type: outbound.streamSettings?.network || 'tcp',
                        security: outbound.streamSettings?.security || 'none',
                        path: encodeURIComponent(outbound.streamSettings?.wsSettings?.path || ''),
                        host: outbound.streamSettings?.wsSettings?.headers?.Host || '',
                        // VLESS specific params
                        flow: server.users[0].flow || '',
                        encryption: server.users[0].encryption || 'none',
                   });
                   const url = `vless://${server.users[0].id}@${server.address}:${server.port}?${params.toString()}#${encodeURIComponent(server.remark || remark)}`;
                   nodes.push(url);
                }
            }
        }
        return nodes;
    } catch (e) {
        console.error("Failed to parse Xray config:", e);
        return [];
    }
}


// --- 路由处理器 / Route Handlers ---

/**
 * 处理订阅请求: /sub/:groupId
 */
async function handleSubscription(request, env, groupId) {
    if (!groupId) {
        return new Response('Group ID is required.', { status: 400 });
    }

    const groupDataStr = await env.KV_NAMESPACE.get(`SUBS_GROUP:${groupId}`);
    if (!groupDataStr) {
        return new Response('// Group not found or has no subscriptions.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    try {
        const groupData = JSON.parse(groupDataStr);
        const subLinks = groupData.links || [];

        const allNodesPromises = subLinks.map(link => fetchSubscriptionNodes(link));
        const allNodesArrays = await Promise.all(allNodesPromises);
        
        let allNodes = [].concat(...allNodesArrays).filter(Boolean); // 合并并移除空行

        // 去重
        const uniqueNodes = [...new Set(allNodes)];

        const body = btoa(uniqueNodes.join('\n'));
        const headers = {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        };
        return new Response(body, { status: 200, headers });
    } catch (e) {
        console.error(`Error processing group ${groupId}:`, e);
        return new Response(`// Error processing group: ${e.message}`, { status: 500 });
    }
}

/**
 * 处理管理后台的 API 请求: /admin/api/:action
 */
async function handleAdminApi(request, env, action) {
    // 对所有 admin API 请求执行认证检查
    const authResult = await checkAuth(request, env);
    if (!authResult.success) {
        return new Response(JSON.stringify({ success: false, message: authResult.message }), { status: authResult.status, headers: { 'Content-Type': 'application/json' } });
    }

    let body = {};
    if (request.method === 'POST') {
        try {
            body = await request.json();
        } catch (e) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
    }
    
    // 获取当前配置，主要是为了拿到路径信息
    const configStr = await env.KV_NAMESPACE.get('CONFIG') || '{}';
    const config = JSON.parse(configStr);

    switch (action) {
        case 'login': {
            return new Response(JSON.stringify({ success: true, message: 'Login successful' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        case 'saveConfig': {
            const { password, subPath, adminPath } = body;
            // 首次配置时，旧密码可能为空
            const oldConfig = config;
            if (oldConfig.password && oldConfig.password !== body.oldPassword) {
                 return new Response(JSON.stringify({ success: false, message: '旧密码错误' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
            }
            if (!password || !subPath || !adminPath) {
                 return new Response(JSON.stringify({ success: false, message: '所有字段均为必填项' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }
            const newConfig = { password, subPath, adminPath };
            await env.KV_NAMESPACE.put('CONFIG', JSON.stringify(newConfig));
            return new Response(JSON.stringify({ success: true, message: '配置已保存！请使用新密码和新路径（如果已更改）。' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        case 'getConfig': {
            // 不返回密码
            delete config.password;
            const isConfigured = !!(await env.KV_NAMESPACE.get('CONFIG'));
            return new Response(JSON.stringify({ success: true, data: config, isConfigured }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
          
        case 'getGroups': {
            const list = await env.KV_NAMESPACE.list({ prefix: 'SUBS_GROUP:' });
            const groups = await Promise.all(list.keys.map(async (key) => {
                const value = await env.KV_NAMESPACE.get(key.name);
                try {
                    const data = JSON.parse(value);
                    return {
                        id: key.name.replace('SUBS_GROUP:', ''),
                        name: data.name,
                        linkCount: data.links ? data.links.length : 0,
                    };
                } catch (e) { return null; }
            }));
            return new Response(JSON.stringify({ success: true, data: groups.filter(Boolean) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        case 'getGroupDetails': {
            const { id } = body;
            const groupDataStr = await env.KV_NAMESPACE.get(`SUBS_GROUP:${id}`);
            if (!groupDataStr) return new Response(JSON.stringify({ success: false, message: 'Group not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            return new Response(JSON.stringify({ success: true, data: JSON.parse(groupDataStr) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
          
        case 'saveGroup': {
            const { id, name, links } = body;
            if (!name || !Array.isArray(links)) return new Response(JSON.stringify({ success: false, message: 'Invalid group data' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            const groupId = id || crypto.randomUUID();
            await env.KV_NAMESPACE.put(`SUBS_GROUP:${groupId}`, JSON.stringify({ name, links }));
            return new Response(JSON.stringify({ success: true, message: 'Group saved', id: groupId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        case 'deleteGroup': {
            await env.KV_NAMESPACE.delete(`SUBS_GROUP:${body.id}`);
            return new Response(JSON.stringify({ success: true, message: 'Group deleted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        case 'batchImport': {
            const { groupId, xrayConfig } = body;
            const groupDataStr = await env.KV_NAMESPACE.get(`SUBS_GROUP:${groupId}`);
            if (!groupDataStr) return new Response(JSON.stringify({ success: false, message: 'Group not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            
            const nodes = parseXrayConfig(xrayConfig);
            if (nodes.length === 0) return new Response(JSON.stringify({ success: false, message: '在提供的配置中没有找到有效的节点' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            
            // 使用 data URI 存储导入的节点
            const importedNodesContent = btoa(nodes.join('\n'));
            const dataUrl = `data:text/plain;base64,${importedNodesContent}`;
            
            const groupData = JSON.parse(groupDataStr);
            groupData.links.push(dataUrl); // 追加到现有链接

            await env.KV_NAMESPACE.put(`SUBS_GROUP:${groupId}`, JSON.stringify(groupData));
            return new Response(JSON.stringify({ success: true, message: `成功导入 ${nodes.length} 个节点.` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        default:
            return new Response(JSON.stringify({ success: false, message: 'Unknown API action' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
}


// --- 主入口 / Main Entry ---

export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 从 KV 中动态获取路径配置
    const configStr = await env.KV_NAMESPACE.get('CONFIG');
    const config = configStr ? JSON.parse(configStr) : { subPath: 'sub', adminPath: 'admin' };
    
    const subPath = config.subPath || 'sub';
    const adminPath = config.adminPath || 'admin';

    // 路由分发
    // 1. 订阅请求: /subPath/groupId
    if (pathSegments[0] === subPath && pathSegments.length > 1) {
        const groupId = pathSegments[1];
        return handleSubscription(request, env, groupId);
    }
    
    // 2. 管理 API 请求: /adminPath/api/action
    if (pathSegments[0] === adminPath && pathSegments[1] === 'api' && pathSegments.length > 2) {
        const action = pathSegments[2];
        return handleAdminApi(request, env, action);
    }

    // 对于其他所有请求, Cloudflare Pages 会默认寻找 /static 目录下的文件
    // 如果文件不存在, Pages 会返回 404.
    // 我们在这里返回一个明确的 404, 以防路由配置不当.
    return new Response('Not Found', { status: 404 });
}
