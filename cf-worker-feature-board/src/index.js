/**
 * Cloudflare Worker: 需求建议与投票系统后端
 * 绑定 D1 数据库变量名: DB
 * CORS 白名单: vars.allowed_origins（wrangler.toml [vars]，逗号分隔）
 */

// CORS 白名单：仅当请求 Origin 在 allowed_origins（env vars，逗号分隔）里才回
// Access-Control-Allow-Origin（值=该 origin）；不带 Origin（同源/服务器端调用）
// 不回任何 CORS 头。白名单为空 = 不支持跨域 —— 插件前端与 API 同源部署时无需 CORS，
// 反射任意 Origin 会把带凭据的浏览器请求敞开给任意网站。
function corsHeaders(request, env) {
	const origin = request.headers.get("Origin");
	if (!origin) return {};
	const allowed = String(env?.allowed_origins ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!allowed.includes(origin)) return {};
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, X-Voter-Id",
		"Access-Control-Max-Age": "86400",
		// origin 反射式白名单必须带 Vary，防止 CDN/浏览器缓存串答
		Vary: "Origin",
	};
}

// limit 容错解析：NaN（非法数字）→ 回落默认 50；负数/0 → 钳到 1；上限保持 100。
// 不设下限的话 limit=0/-1 会拼进 SQL LIMIT（部分引擎报错/行为未定义）。
function parseLimit(raw, fallback = 50) {
	const n = parseInt(raw, 10);
	if (Number.isNaN(n)) return fallback;
	return Math.max(1, Math.min(n, 100));
}

function jsonResponse(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...headers,
		},
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const cors = corsHeaders(request, env);

		// 处理 OPTIONS 预检请求
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: cors });
		}

		const { pathname, searchParams } = url;
		const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
		const voterId = request.headers.get("X-Voter-Id") || searchParams.get("voter_id") || clientIp;

		try {
			// 1. 健康检查
			if (pathname === "/" || pathname === "/api/health") {
				return jsonResponse({ status: "ok", service: "feature-board-api" }, 200, cors);
			}

			// 2. 获取需求列表: GET /api/features
			if (pathname === "/api/features" && request.method === "GET") {
				const sort = searchParams.get("sort") || "hot"; // 'hot' | 'new'
				const status = searchParams.get("status") || "all"; // 'all' | 'open' | 'completed' 等
				const limit = parseLimit(searchParams.get("limit"));

				let whereClause = "";
				const params = [];
				if (status !== "all") {
					whereClause = "WHERE f.status = ?";
					params.push(status);
				}

				const orderBy = sort === "new" ? "f.created_at DESC" : "f.votes_count DESC, f.created_at DESC";

				// 连表查询，带出当前 voter_id 是否已投该条需求
				const sql = `
          SELECT 
            f.id, 
            f.title, 
            f.description, 
            f.author, 
            f.votes_count, 
            f.status, 
            f.created_at,
            CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END AS has_voted
          FROM features f
          LEFT JOIN votes v ON f.id = v.feature_id AND v.voter_id = ?
          ${whereClause}
          ORDER BY ${orderBy}
          LIMIT ?
        `;

				const queryParams = [voterId, ...params, limit];
				const { results } = await env.DB.prepare(sql)
					.bind(...queryParams)
					.all();

				return jsonResponse({ success: true, data: results || [] }, 200, cors);
			}

			// 3. 提交新需求: POST /api/features
			if (pathname === "/api/features" && request.method === "POST") {
				let body;
				try {
					body = await request.json();
				} catch {
					return jsonResponse({ error: "无效的 JSON 格式" }, 400, cors);
				}

				const title = (body.title || "").trim();
				const description = (body.description || "").trim();
				const author = (body.author || "匿名用户").trim() || "匿名用户";

				if (!title) {
					return jsonResponse({ error: "需求标题不能为空" }, 400, cors);
				}
				if (title.length > 150) {
					return jsonResponse({ error: "标题长度不能超过 150 字" }, 400, cors);
				}
				if (description.length > 2000) {
					return jsonResponse({ error: "描述长度不能超过 2000 字" }, 400, cors);
				}

				// 插入需求
				const insertSql = `
          INSERT INTO features (title, description, author, votes_count) 
          VALUES (?, ?, ?, 1)
          RETURNING *;
        `;
				const inserted = await env.DB.prepare(insertSql).bind(title, description, author).first();

				// 提交人默认自动投 1 票
				if (inserted && inserted.id) {
					try {
						await env.DB.prepare("INSERT INTO votes (feature_id, voter_id) VALUES (?, ?)")
							.bind(inserted.id, voterId)
							.run();
					} catch (e) {
						// 忽略重复
					}
				}

				return jsonResponse({ success: true, data: inserted }, 201, cors);
			}

			// 4. 投票/取消投票: POST /api/features/:id/vote
			const voteMatch = pathname.match(/^\/api\/features\/(\d+)\/vote$/);
			if (voteMatch && request.method === "POST") {
				const featureId = parseInt(voteMatch[1], 10);

				// 检查需求是否存在
				const feature = await env.DB.prepare("SELECT id, votes_count FROM features WHERE id = ?")
					.bind(featureId)
					.first();
				if (!feature) {
					return jsonResponse({ error: "需求不存在" }, 404, cors);
				}

				// 检查当前 voter 是否已投
				const existingVote = await env.DB.prepare("SELECT id FROM votes WHERE feature_id = ? AND voter_id = ?")
					.bind(featureId, voterId)
					.first();

				if (existingVote) {
					// 已投票 -> 取消投票 (Toggle: -1)
					await env.DB.batch([
						env.DB.prepare("DELETE FROM votes WHERE id = ?").bind(existingVote.id),
						env.DB.prepare(
							"UPDATE features SET votes_count = MAX(0, votes_count - 1), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
						).bind(featureId),
					]);
					return jsonResponse(
						{ success: true, action: "unvoted", votes_count: Math.max(0, feature.votes_count - 1) },
						200,
						cors,
					);
				} else {
					// 未投票 -> 投票 (+1)
					await env.DB.batch([
						env.DB.prepare("INSERT INTO votes (feature_id, voter_id) VALUES (?, ?)").bind(featureId, voterId),
						env.DB.prepare(
							"UPDATE features SET votes_count = votes_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
						).bind(featureId),
					]);
					return jsonResponse({ success: true, action: "voted", votes_count: feature.votes_count + 1 }, 200, cors);
				}
			}

			return jsonResponse({ error: "接口未找到 (Not Found)" }, 404, cors);
		} catch (err) {
			return jsonResponse({ error: err.message || "内部服务器错误" }, 500, cors);
		}
	},
};
