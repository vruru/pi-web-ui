/**
 * feature-board 客户端入口
 */

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[c],
	);
}

function timeAgo(dateStr) {
	if (!dateStr) return "";
	const date = new Date(dateStr.endsWith("Z") ? dateStr : dateStr + "Z");
	const now = new Date();
	const diffSec = Math.floor((now - date) / 1000);
	if (diffSec < 60) return "刚刚";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin} 分钟前`;
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) return `${diffHour} 小时前`;
	const diffDay = Math.floor(diffHour / 24);
	if (diffDay < 30) return `${diffDay} 天前`;
	return date.toLocaleDateString();
}

function getVoterId() {
	let id = localStorage.getItem("pi_feature_board_voter_id");
	if (!id) {
		id = "voter_" + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
		localStorage.setItem("pi_feature_board_voter_id", id);
	}
	return id;
}

const STATUS_MAP = {
	open: {
		label: "建议中",
		color: "var(--amber, #f59e0b)",
		bg: "color-mix(in srgb, var(--amber, #f59e0b) 15%, transparent)",
	},
	planned: {
		label: "已规划",
		color: "var(--blue, #3b82f6)",
		bg: "color-mix(in srgb, var(--blue, #3b82f6) 15%, transparent)",
	},
	in_progress: {
		label: "进行中",
		color: "var(--accent, #7c5cff)",
		bg: "color-mix(in srgb, var(--accent, #7c5cff) 15%, transparent)",
	},
	completed: {
		label: "已完成",
		color: "var(--green, #10b981)",
		bg: "color-mix(in srgb, var(--green, #10b981) 15%, transparent)",
	},
	closed: {
		label: "已关闭",
		color: "var(--text-dim, #666)",
		bg: "color-mix(in srgb, var(--text-dim, #666) 15%, transparent)",
	},
};

// 顶栏「需求墙」按钮接管（模块顶层注册 —— 写在 mount 里太晚，宿主按需加载
// bundle 后 1.5s 内轮询派发，顶层同步注册才能接住；mount 只负责视图内容）
(function registerBoardAction() {
	function whenBridge(fn, tries = 40) {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge === "object") {
			fn(bridge);
			return;
		}
		if (tries <= 0) return;
		setTimeout(() => whenBridge(fn, tries - 1), 250);
	}
	whenBridge((bridge) => {
		try {
			bridge.onUiAction?.("feature-board:open", () => {
				try {
					bridge.openModal?.("feature-board:board");
				} catch {
					/* 弹窗打开失败：静默忽略 */
				}
			});
		} catch {
			/* 宿主桥未就绪：顶栏按钮点不动，用户刷新即恢复 */
		}
	});
})();

export default {
	mount(container, ctx) {
		let state = {
			items: [],
			loading: true,
			error: null,
			sort: "hot", // 'hot' | 'new'
			status: "all",
			showModal: false,
			submitting: false,
			votingIds: new Set(),
		};

		const voterId = getVoterId();

		function getApiUrl() {
			const custom = localStorage.getItem("pi_feature_board_api_url");
			if (custom && custom.trim()) return custom.trim().replace(/\/+$/, "");
			if (ctx?.settings?.apiUrl && ctx.settings.apiUrl.trim()) {
				return ctx.settings.apiUrl.trim().replace(/\/+$/, "");
			}
			return "https://feature-board-api.xing-shuyin.workers.dev"; // 部署的 Worker 地址
		}

		container.innerHTML = `
      <div class="fb-wrapper">
        <header class="fb-header">
          <div class="fb-title-group">
            <span class="fb-icon">💡</span>
            <div>
              <h2 class="fb-title">需求与功能投票墙</h2>
              <p class="fb-subtitle">提出你的好点子，为你心仪的功能投票，共同完善产品</p>
            </div>
          </div>
          <div class="fb-header-actions">
            <button class="fb-btn fb-btn-primary" id="fb-btn-new">
              <span class="fb-plus">+</span> 提新需求
            </button>
          </div>
        </header>

        <!-- 筛选与控制栏 -->
        <div class="fb-toolbar">
          <div class="fb-filters">
            <button class="fb-tag active" data-status="all">全部</button>
            <button class="fb-tag" data-status="open">建议中</button>
            <button class="fb-tag" data-status="planned">已规划</button>
            <button class="fb-tag" data-status="in_progress">进行中</button>
            <button class="fb-tag" data-status="completed">已完成</button>
          </div>
          <div class="fb-sort">
            <button class="fb-sort-btn active" data-sort="hot">🔥 最热</button>
            <button class="fb-sort-btn" data-sort="new">🕒 最新</button>
            <button class="fb-icon-btn" id="fb-btn-refresh" title="刷新列表">🔄</button>
          </div>
        </div>

        <!-- 列表主区域 -->
        <main class="fb-main" id="fb-list-container">
          <div class="fb-loading">正在加载需求列表...</div>
        </main>

        <!-- 提交弹窗 -->
        <div class="fb-modal-overlay" id="fb-modal" style="display: none;">
          <div class="fb-modal-box">
            <div class="fb-modal-head">
              <h3>💡 提交新需求 / 建议</h3>
              <button class="fb-modal-close" id="fb-modal-close">×</button>
            </div>
            <form class="fb-form" id="fb-form">
              <div class="fb-field">
                <label>需求标题 <span class="required">*</span></label>
                <input type="text" id="fb-input-title" placeholder="简明扼要地描述你的建议 (例如：希望支持一键生成流程图)" maxlength="150" required />
              </div>
              <div class="fb-field">
                <label>详细说明 / 使用场景</label>
                <textarea id="fb-input-desc" rows="4" placeholder="补充背景、具体使用场景或期望的交互方式..." maxlength="2000"></textarea>
              </div>
              <div class="fb-field">
                <label>你的昵称 (可选)</label>
                <input type="text" id="fb-input-author" placeholder="匿名用户" maxlength="30" />
              </div>
              <div class="fb-form-foot">
                <button type="button" class="fb-btn fb-btn-ghost" id="fb-btn-cancel">取消</button>
                <button type="submit" class="fb-btn fb-btn-primary" id="fb-btn-submit">发布建议</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;

		// 动态样式插入
		const styleEl = document.createElement("style");
		styleEl.textContent = `
      .fb-wrapper {
        display: flex;
        flex-direction: column;
        height: 100%;
        max-width: 960px;
        margin: 0 auto;
        padding: 20px 24px;
        box-sizing: border-box;
        color: var(--text, #e6e6ef);
        font-family: inherit;
        overflow-y: auto;
      }
      .fb-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        gap: 16px;
      }
      .fb-title-group {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .fb-icon {
        font-size: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--accent, #7c5cff) 15%, transparent);
      }
      .fb-title {
        margin: 0 0 4px 0;
        font-size: 20px;
        font-weight: 600;
      }
      .fb-subtitle {
        margin: 0;
        font-size: 13px;
        opacity: 0.7;
      }
      .fb-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid transparent;
        transition: all 0.15s ease;
      }
      .fb-btn-primary {
        background: var(--accent, #7c5cff);
        color: #fff;
      }
      .fb-btn-primary:hover {
        filter: brightness(1.1);
      }
      .fb-btn-ghost {
        background: transparent;
        border-color: var(--border, #333);
        color: var(--text, #e6e6ef);
      }
      .fb-btn-ghost:hover {
        background: var(--bg-elev2, #20202b);
      }
      .fb-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 0;
        border-bottom: 1px solid var(--border, #333);
        margin-bottom: 16px;
        gap: 12px;
        flex-wrap: wrap;
      }
      .fb-filters, .fb-sort {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .fb-tag, .fb-sort-btn {
        all: unset;
        cursor: pointer;
        padding: 5px 12px;
        border-radius: 6px;
        font-size: 12px;
        opacity: 0.7;
        transition: all 0.15s ease;
      }
      .fb-tag:hover, .fb-sort-btn:hover {
        opacity: 1;
        background: var(--bg-elev2, #20202b);
      }
      .fb-tag.active, .fb-sort-btn.active {
        opacity: 1;
        font-weight: 600;
        background: color-mix(in srgb, var(--accent, #7c5cff) 20%, transparent);
        color: var(--accent, #7c5cff);
      }
      .fb-icon-btn {
        all: unset;
        cursor: pointer;
        padding: 5px 8px;
        border-radius: 6px;
        opacity: 0.7;
      }
      .fb-icon-btn:hover {
        opacity: 1;
        background: var(--bg-elev2, #20202b);
      }
      .fb-main {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding-bottom: 30px;
      }
      .fb-card {
        display: flex;
        align-items: flex-start;
        gap: 16px;
        padding: 16px;
        border-radius: 10px;
        background: var(--bg-elev, #16161d);
        border: 1px solid var(--border, #282833);
        transition: transform 0.1s ease, border-color 0.15s ease;
      }
      .fb-card:hover {
        border-color: color-mix(in srgb, var(--accent, #7c5cff) 40%, var(--border, #282833));
      }
      .fb-vote-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-width: 54px;
        padding: 8px 6px;
        border-radius: 8px;
        border: 1px solid var(--border, #333);
        background: var(--bg, #101016);
        cursor: pointer;
        transition: all 0.15s ease;
        user-select: none;
      }
      .fb-vote-box:hover {
        border-color: var(--accent, #7c5cff);
        transform: translateY(-1px);
      }
      .fb-vote-box.voted {
        background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent);
        border-color: var(--accent, #7c5cff);
        color: var(--accent, #7c5cff);
      }
      .fb-vote-icon {
        font-size: 16px;
        line-height: 1;
        margin-bottom: 4px;
      }
      .fb-vote-count {
        font-size: 13px;
        font-weight: 600;
      }
      .fb-card-content {
        flex: 1;
        min-width: 0;
      }
      .fb-card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .fb-card-title {
        font-size: 15px;
        font-weight: 600;
        margin: 0;
        line-height: 1.4;
      }
      .fb-badge {
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 500;
        white-space: nowrap;
      }
      .fb-card-desc {
        font-size: 13px;
        line-height: 1.6;
        opacity: 0.8;
        margin: 0 0 10px 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .fb-card-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 12px;
        opacity: 0.55;
      }
      .fb-empty, .fb-loading, .fb-error {
        padding: 40px 20px;
        text-align: center;
        opacity: 0.6;
        font-size: 14px;
      }
      .fb-error {
        color: var(--red, #ef4444);
        opacity: 1;
      }

      /* 弹窗 */
      .fb-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 16px;
      }
      .fb-modal-box {
        width: 100%;
        max-width: 520px;
        background: var(--bg-elev, #16161d);
        border: 1px solid var(--border, #333);
        border-radius: 12px;
        padding: 20px 24px;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
      }
      .fb-modal-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }
      .fb-modal-head h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
      }
      .fb-modal-close {
        all: unset;
        cursor: pointer;
        font-size: 20px;
        padding: 2px 8px;
        border-radius: 4px;
        opacity: 0.6;
      }
      .fb-modal-close:hover {
        opacity: 1;
        background: var(--bg-elev2, #20202b);
      }
      .fb-form {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .fb-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .fb-field label {
        font-size: 12px;
        font-weight: 500;
        opacity: 0.85;
      }
      .fb-field .required {
        color: var(--red, #ef4444);
      }
      .fb-field input, .fb-field textarea {
        box-sizing: border-box;
        width: 100%;
        padding: 9px 12px;
        background: var(--bg, #101016);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        color: inherit;
        font-family: inherit;
        font-size: 13px;
        outline: none;
        transition: border-color 0.15s ease;
      }
      .fb-field input:focus, .fb-field textarea:focus {
        border-color: var(--accent, #7c5cff);
      }
      .fb-form-foot {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 8px;
      }
    `;
		container.appendChild(styleEl);

		// DOM 元素引用
		const listContainer = container.querySelector("#fb-list-container");
		const modal = container.querySelector("#fb-modal");
		const btnNew = container.querySelector("#fb-btn-new");
		const btnCloseModal = container.querySelector("#fb-modal-close");
		const btnCancel = container.querySelector("#fb-btn-cancel");
		const btnRefresh = container.querySelector("#fb-btn-refresh");
		const form = container.querySelector("#fb-form");
		const inputTitle = container.querySelector("#fb-input-title");
		const inputDesc = container.querySelector("#fb-input-desc");
		const inputAuthor = container.querySelector("#fb-input-author");

		// 默认恢复已保存的昵称
		const savedAuthor = localStorage.getItem("pi_feature_board_author");
		if (savedAuthor) inputAuthor.value = savedAuthor;

		// 获取并渲染数据
		async function loadFeatures() {
			state.loading = true;
			render();

			try {
				const apiUrl = getApiUrl();
				const url = new URL(`${apiUrl}/api/features`);
				url.searchParams.set("sort", state.sort);
				if (state.status !== "all") {
					url.searchParams.set("status", state.status);
				}

				const res = await fetch(url.toString(), {
					headers: {
						"X-Voter-Id": voterId,
					},
				});

				if (!res.ok) {
					throw new Error(`HTTP ${res.status}: ${res.statusText}`);
				}

				const data = await res.json();
				state.items = data.data || [];
				state.error = null;
			} catch (err) {
				state.error = `获取需求失败: ${err.message}`;
			} finally {
				state.loading = false;
				render();
			}
		}

		// 投票处理 (Toggle)
		async function handleVote(featureId) {
			if (state.votingIds.has(featureId)) return;
			state.votingIds.add(featureId);
			render();

			try {
				const apiUrl = getApiUrl();
				const res = await fetch(`${apiUrl}/api/features/${featureId}/vote`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Voter-Id": voterId,
					},
				});

				if (!res.ok) throw new Error("投票请求失败");
				const resData = await res.json();

				// 局部更新状态
				const item = state.items.find((x) => x.id === featureId);
				if (item) {
					item.votes_count = resData.votes_count;
					item.has_voted = resData.action === "voted" ? 1 : 0;
				}
			} catch (err) {
				alert("操作失败：" + err.message);
			} finally {
				state.votingIds.delete(featureId);
				render();
			}
		}

		// 提交需求
		async function handleSubmit(e) {
			e.preventDefault();
			const title = inputTitle.value.trim();
			const desc = inputDesc.value.trim();
			const author = inputAuthor.value.trim() || "匿名用户";

			if (!title) return;

			state.submitting = true;
			const btnSubmit = form.querySelector("#fb-btn-submit");
			btnSubmit.disabled = true;
			btnSubmit.textContent = "提交中...";

			try {
				const apiUrl = getApiUrl();
				const res = await fetch(`${apiUrl}/api/features`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Voter-Id": voterId,
					},
					body: JSON.stringify({
						title,
						description: desc,
						author,
					}),
				});

				if (!res.ok) {
					const errBody = await res.json().catch(() => ({}));
					throw new Error(errBody.error || "提交失败");
				}

				// 保存昵称
				if (author && author !== "匿名用户") {
					localStorage.setItem("pi_feature_board_author", author);
				}

				// 关闭弹窗并重置表单
				inputTitle.value = "";
				inputDesc.value = "";
				modal.style.display = "none";

				// 重新拉取列表
				await loadFeatures();
			} catch (err) {
				alert("提交失败：" + err.message);
			} finally {
				state.submitting = false;
				btnSubmit.disabled = false;
				btnSubmit.textContent = "发布建议";
			}
		}

		// 渲染列表函数
		function render() {
			if (state.loading) {
				listContainer.innerHTML = `<div class="fb-loading">正在加载最新需求...</div>`;
				return;
			}

			if (state.error) {
				listContainer.innerHTML = `
          <div class="fb-error">
            <p>${esc(state.error)}</p>
            <button class="fb-btn fb-btn-ghost" id="fb-retry" style="margin-top: 10px;">重试</button>
          </div>
        `;
				listContainer.querySelector("#fb-retry")?.addEventListener("click", loadFeatures);
				return;
			}

			if (!state.items.length) {
				listContainer.innerHTML = `
          <div class="fb-empty">
            <p>暂无相关需求建议</p>
            <button class="fb-btn fb-btn-primary" id="fb-empty-new">+ 提第一个建议</button>
          </div>
        `;
				listContainer.querySelector("#fb-empty-new")?.addEventListener("click", () => {
					modal.style.display = "flex";
				});
				return;
			}

			listContainer.innerHTML = state.items
				.map((item) => {
					const st = STATUS_MAP[item.status] || STATUS_MAP.open;
					const isVoted = item.has_voted === 1;
					const isVoting = state.votingIds.has(item.id);

					return `
            <div class="fb-card" data-id="${esc(item.id)}">
              <div class="fb-vote-box ${isVoted ? "voted" : ""}" data-id="${esc(item.id)}" title="${isVoted ? "点击取消投票" : "点赞支持"}">
                <span class="fb-vote-icon">${isVoting ? "⏳" : isVoted ? "👍" : "▲"}</span>
                <span class="fb-vote-count">${esc(item.votes_count || 0)}</span>
              </div>
              <div class="fb-card-content">
                <div class="fb-card-head">
                  <h3 class="fb-card-title">${esc(item.title)}</h3>
                  <span class="fb-badge" style="color: ${st.color}; background: ${st.bg};">${esc(st.label)}</span>
                </div>
                ${item.description ? `<p class="fb-card-desc">${esc(item.description)}</p>` : ""}
                <div class="fb-card-meta">
                  <span>👤 ${esc(item.author || "匿名")}</span>
                  <span>🕒 ${timeAgo(item.created_at)}</span>
                </div>
              </div>
            </div>
          `;
				})
				.join("");

			// 绑定投票点击事件
			listContainer.querySelectorAll(".fb-vote-box").forEach((el) => {
				el.addEventListener("click", (e) => {
					const id = parseInt(el.getAttribute("data-id"), 10);
					if (id) handleVote(id);
				});
			});
		}

		// 事件绑定
		btnNew.addEventListener("click", () => {
			modal.style.display = "flex";
			inputTitle.focus();
		});

		btnCloseModal.addEventListener("click", () => {
			modal.style.display = "none";
		});

		btnCancel.addEventListener("click", () => {
			modal.style.display = "none";
		});

		modal.addEventListener("click", (e) => {
			if (e.target === modal) modal.style.display = "none";
		});

		btnRefresh.addEventListener("click", loadFeatures);
		form.addEventListener("submit", handleSubmit);

		// 状态过滤事件
		container.querySelectorAll(".fb-tag").forEach((tag) => {
			tag.addEventListener("click", () => {
				container.querySelectorAll(".fb-tag").forEach((t) => t.classList.remove("active"));
				tag.classList.add("active");
				state.status = tag.getAttribute("data-status");
				loadFeatures();
			});
		});

		// 排序切换事件
		container.querySelectorAll(".fb-sort-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				container.querySelectorAll(".fb-sort-btn").forEach((b) => b.classList.remove("active"));
				btn.classList.add("active");
				state.sort = btn.getAttribute("data-sort");
				loadFeatures();
			});
		});

		// 首次加载
		loadFeatures();
	},

	cleanup() {
		// 销毁回调
	},
};
