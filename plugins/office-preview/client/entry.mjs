/**
 * office-preview 客户端视图 —— docx / xlsx / csv 预览。
 *
 * 约定：ESM 默认导出 { mount(container, ctx) → cleanup? }，纯 DOM 零依赖。
 * 解析全在服务端做（index.mjs），这里只负责：工作区文件列表 / 本地上传 /
 * 表格与段落渲染 / 复制文本 / 发给 AI（经 window.__piWebUiHost.compose 塞输入框）。
 */

function apiBase() {
	try {
		let p = location.pathname.replace(/index\.html$/i, "");
		if (!p.endsWith("/")) p += "/";
		return `${p}plugins-api/office-preview`;
	} catch {
		return "/plugins-api/office-preview";
	}
}

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

function sheetToText(sheet) {
	return sheet.rows.map((r) => r.join("\t")).join("\n");
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="ofp">
	<style>
		.ofp { max-width: 960px; margin: 0 auto; font-size: 13px; display: grid; grid-template-columns: 240px 1fr; gap: 12px; }
		.ofp .side { border: 1px solid var(--border, #333); border-radius: 8px; padding: 8px; align-self: start; max-height: 70vh; overflow: auto; }
		.ofp .side h3 { margin: 4px 4px 8px; font-size: 12px; opacity: .65; }
		.ofp .file { display: block; width: 100%; text-align: left; background: none; border: 0; color: inherit;
			padding: 6px 8px; border-radius: 6px; cursor: pointer; font: inherit; word-break: break-all; }
		.ofp .file:hover { background: var(--bg-elev, #1a1d26); }
		.ofp .file.active { background: var(--bg-elev, #1a1d26); outline: 1px solid var(--accent, #7c5cff); }
		.ofp .main { border: 1px solid var(--border, #333); border-radius: 8px; padding: 12px 14px; min-width: 0; }
		.ofp .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; align-items: center; }
		.ofp button.act { background: var(--accent, #7c5cff); color: #fff; border: 0; border-radius: 6px;
			padding: 6px 12px; cursor: pointer; font: inherit; }
		.ofp button.ghost { background: transparent; color: inherit; border: 1px solid var(--border, #333);
			border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit; }
		.ofp .doc p { margin: 0 0 8px; line-height: 1.7; white-space: pre-wrap; }
		.ofp table.sheet { border-collapse: collapse; width: 100%; font-size: 12px; margin: 0 0 16px; }
		.ofp table.sheet td, .ofp table.sheet th { border: 1px solid var(--border, #333); padding: 4px 8px;
			max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ofp table.sheet tr:first-child td { font-weight: bold; background: var(--bg-elev, #16161d); }
		.ofp .sheet-name { margin: 10px 0 6px; font-weight: bold; }
		.ofp .meta { opacity: .6; font-size: 12px; margin-bottom: 8px; }
		.ofp .empty { opacity: .55; padding: 32px 0; text-align: center; }
		@media (max-width: 720px) { .ofp { grid-template-columns: 1fr; } .ofp .side { max-height: 220px; } }
	</style>
	<div class="side">
		<h3>工作区文档 <button class="ghost" data-act="refresh" style="float:right;padding:2px 8px">↻</button></h3>
		<div data-list><div class="empty">加载中…</div></div>
		<h3 style="margin-top:12px">本地文件</h3>
		<input type="file" data-file accept=".docx,.xlsx,.xlsm,.csv" style="width:100%" />
	</div>
	<div class="main">
		<div class="toolbar" data-toolbar style="display:none">
			<b data-title style="margin-right:auto"></b>
			<button class="ghost" data-act="copy">复制文本</button>
			<button class="act" data-act="ask">发给 AI</button>
		</div>
		<div data-meta class="meta"></div>
		<div data-body><div class="empty">← 左边选一个工作区文档，或从本地上传一个 .docx / .xlsx / .csv 预览。<br/>解析只读文件，不会修改原文件。</div></div>
	</div>
</div>`;

		const root = container.querySelector(".ofp");
		const listEl = root.querySelector("[data-list]");
		const bodyEl = root.querySelector("[data-body]");
		const metaEl = root.querySelector("[data-meta]");
		const toolbarEl = root.querySelector("[data-toolbar]");
		const titleEl = root.querySelector("[data-title]");
		const fileInput = root.querySelector("[data-file]");
		let current = null; // { filename, kind, text?, sheets?, paragraphs? }
		let currentName = "";

		async function api(path, opts) {
			const r = await fetch(`${apiBase()}${path}`, opts);
			const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
			if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
			return j;
		}

		async function loadList() {
			listEl.innerHTML = `<div class="empty">加载中…</div>`;
			try {
				const j = await api("/list");
				if (!j.files.length) {
					listEl.innerHTML = `<div class="empty">工作区没有 .docx / .xlsx / .csv</div>`;
					return;
				}
				listEl.innerHTML = "";
				for (const f of j.files) {
					const b = document.createElement("button");
					b.className = "file" + (f === currentName ? " active" : "");
					b.textContent = f;
					b.title = f;
					b.onclick = () => openWorkspace(f);
					listEl.appendChild(b);
				}
			} catch (err) {
				listEl.innerHTML = `<div class="empty">列表加载失败：${esc(err.message)}</div>`;
			}
		}

		function markActive() {
			listEl.querySelectorAll(".file").forEach((b) => {
				b.classList.toggle("active", b.textContent === currentName);
			});
		}

		function render(parsed, displayName) {
			current = parsed;
			currentName = displayName;
			markActive();
			titleEl.textContent = displayName;
			toolbarEl.style.display = "";
			if (parsed.kind === "docx") {
				const n = parsed.paragraphs.length;
				metaEl.textContent = `Word 文档 · ${n} 段 · ${parsed.textLength} 字${parsed.truncated ? "（已截断，只看前一部分）" : ""}`;
				bodyEl.innerHTML = `<div class="doc">${parsed.paragraphs.map((p) => `<p>${esc(p) || "&nbsp;"}</p>`).join("")}</div>`;
			} else {
				const total = parsed.sheets.map((s) => `${s.name}（${s.nRows}×${s.nCols}）`).join("、");
				const trunc = parsed.sheets.some((s) => s.truncated) ? "（只看前 200 行 × 20 列）" : "";
				metaEl.textContent = `表格 · ${total}${trunc}`;
				bodyEl.innerHTML = parsed.sheets
					.map(
						(s) => `
					<div class="sheet-name">${esc(s.name)} <span class="meta">${s.nRows} 行 × ${s.nCols} 列</span></div>
					<div style="overflow:auto"><table class="sheet">${s.rows.map((r) => `<tr>${r.map((c) => `<td title="${esc(c)}">${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td>（空表）</td></tr>`}</table></div>
				`,
					)
					.join("");
			}
		}

		function fail(err) {
			toolbarEl.style.display = "none";
			metaEl.textContent = "";
			bodyEl.innerHTML = `<div class="empty">解析失败：${esc(err.message)}</div>`;
		}

		async function openWorkspace(path) {
			bodyEl.innerHTML = `<div class="empty">解析中…</div>`;
			try {
				const j = await api(`/parse?path=${encodeURIComponent(path)}`);
				render(j, path);
			} catch (err) {
				current = null;
				currentName = "";
				markActive();
				fail(err);
			}
		}

		fileInput.addEventListener("change", async () => {
			const f = fileInput.files?.[0];
			if (!f) return;
			bodyEl.innerHTML = `<div class="empty">解析中…</div>`;
			try {
				const j = await api(`/upload?filename=${encodeURIComponent(f.name)}`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: f,
				});
				render(j, `${f.name}（本地）`);
			} catch (err) {
				current = null;
				fail(err);
			} finally {
				fileInput.value = "";
			}
		});

		function currentText() {
			if (!current) return "";
			if (current.kind === "docx") return current.text;
			return current.sheets.map((s) => `## ${s.name}\n${sheetToText(s)}`).join("\n\n");
		}

		root.addEventListener("click", async (e) => {
			const btn = e.target.closest("[data-act]");
			if (!btn) return;
			const act = btn.dataset.act;
			if (act === "refresh") return void loadList();
			if (!current) return;
			if (act === "copy") {
				try {
					await navigator.clipboard.writeText(currentText());
					btn.textContent = "已复制 ✓";
					setTimeout(() => {
						btn.textContent = "复制文本";
					}, 1500);
				} catch {
					const ta = document.createElement("textarea");
					ta.value = currentText();
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					ta.remove();
				}
			} else if (act === "ask") {
				const host = window.__piWebUiHost;
				const prompt = `请帮我看看这个文档 ${currentName} 的内容：\n\n${currentText().slice(0, 8000)}`;
				if (host?.compose) {
					host.compose({ text: prompt });
					host.setView?.("chat");
				} else if (host?.startChat) {
					host.startChat({ prompt });
				}
			}
		});

		const off = ctx.onData(() => {});
		loadList();

		return () => {
			off();
			root.remove();
		};
	},
};
