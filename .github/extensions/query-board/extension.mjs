import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const headers = [
    "id",
    "domain",
    "target_role",
    "media",
    "query",
    "result_count",
    "found_good",
    "verdict",
    "why",
    "tried_at",
];
const verdicts = ["効いた", "空振り", "未着手"];
const editableFields = ["result_count", "found_good", "verdict", "tried_at"];
const servers = new Map();

let workspacePath;
let csvPath;

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                field += '"';
                i += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field.replace(/\r$/, ""));
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += char;
        }
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    const [csvHeaders, ...dataRows] = rows;
    if (!csvHeaders || csvHeaders.join(",") !== headers.join(",")) {
        throw new Error("data/queries.csv の列が想定と異なります");
    }
    return dataRows.filter((values) => values.some((value) => value !== ""))
        .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvCell(value) {
    const stringValue = String(value ?? "");
    return /[",\r\n]/.test(stringValue)
        ? `"${stringValue.replaceAll('"', '""')}"`
        : stringValue;
}

function toCsv(rows) {
    return `${headers.join(",")}\n${rows
        .map((row) => headers.map((header) => csvCell(row[header])).join(","))
        .join("\n")}\n`;
}

async function loadRows() {
    ensurePaths();
    return parseCsv(await readFile(csvPath, "utf8"));
}

function ensurePaths() {
    if (!workspacePath) {
        const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
        const candidates = [extensionRoot, process.cwd(), session.workspacePath].filter(Boolean);
        workspacePath = candidates.find((candidate) => existsSync(path.join(candidate, "data", "queries.csv")));
        if (!workspacePath) throw new Error("data/queries.csv があるワークスペースを特定できません");
        csvPath = path.join(workspacePath, "data", "queries.csv");
    }
}

function validateRows(rows) {
    const problems = [];
    const ids = new Set();
    rows.forEach((row, index) => {
        const line = index + 2;
        if (!row.id.trim()) problems.push(`${line}行目：id が空です`);
        if (ids.has(row.id.trim())) problems.push(`${line}行目：id が重複しています（${row.id}）`);
        ids.add(row.id.trim());
        if (!row.query.trim()) problems.push(`${line}行目：query が空です`);
        if (!verdicts.includes(row.verdict.trim())) {
            problems.push(`${line}行目：verdict は ${verdicts.join(" / ")} のいずれかにしてください`);
        }
        if (["効いた", "空振り"].includes(row.verdict.trim()) && !row.why.trim()) {
            problems.push(`${line}行目：why が空です。判定の理由は必ず残してください`);
        }
        if (row.verdict.trim() === "未着手" && row.found_good.trim()) {
            problems.push(`${line}行目：未着手なのに found_good が入っています`);
        }
    });
    return problems;
}

function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    let body = "";
    for await (const chunk of req) body += chunk;
    return JSON.parse(body);
}

function renderHtml() {
    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>検索式ボード</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px; background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: var(--text-body-medium, 14px); }
h1 { font-size: 24px; margin: 0 0 16px; }
.toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
button, select, input { font: inherit; color: inherit; background: var(--background-color-default, #fff); border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px; padding: 6px 8px; }
button { cursor: pointer; background: var(--background-color-muted, #f6f8fa); }
button:disabled { cursor: not-allowed; opacity: .5; }
.status { min-height: 22px; color: var(--text-color-muted, #656d76); }
.warning { color: var(--fgColor-danger, #cf222e); font-weight: 600; }
.table-wrap { overflow: auto; border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px; }
table { border-collapse: collapse; min-width: 1100px; width: 100%; }
th, td { border-bottom: 1px solid var(--border-color-default, #d8dee4); padding: 8px; text-align: left; vertical-align: top; }
th { position: sticky; top: 0; background: var(--background-color-muted, #f6f8fa); }
td.query, td.why { min-width: 220px; white-space: pre-wrap; }
td.id { white-space: nowrap; }
tr.todo { background: color-mix(in srgb, var(--background-color-attention, #fff8c5) 35%, transparent); }
td input, td select { width: 100%; box-sizing: border-box; }
.readonly { white-space: nowrap; color: var(--text-color-muted, #656d76); }
</style>
</head>
<body>
<h1>検索式ボード</h1>
<div class="toolbar">
  <label>verdict <select id="filter"><option value="">すべて</option><option>未着手</option><option>効いた</option><option>空振り</option></select></label>
  <label><input id="todo-first" type="checkbox" checked> 未着手を上に</label>
  <button id="reload">再読み込み</button>
  <button id="save" disabled>変更を保存</button>
  <span id="status" class="status"></span>
</div>
<div class="table-wrap"><table><thead><tr>
  <th>id</th><th>media</th><th>query</th><th>verdict</th><th>result_count</th><th>found_good</th><th>why</th><th>tried_at</th>
</tr></thead><tbody id="rows"></tbody></table></div>
<script>
const state = { rows: [], dirty: false };
const editable = ["result_count", "found_good", "verdict", "tried_at"];
const filter = document.querySelector("#filter");
const todoFirst = document.querySelector("#todo-first");
const status = document.querySelector("#status");
const save = document.querySelector("#save");

function setStatus(message, warning = false) {
  status.textContent = message;
  status.className = warning ? "status warning" : "status";
}
function markDirty() {
  state.dirty = true;
  save.disabled = false;
  setStatus("未保存の変更があります");
}
function render() {
  const selected = filter.value;
  const visible = state.rows.filter((row) => !selected || row.verdict === selected);
  if (todoFirst.checked) visible.sort((a, b) => Number(b.verdict === "未着手") - Number(a.verdict === "未着手"));
  document.querySelector("#rows").innerHTML = visible.map((row) => {
    const canEdit = row.verdict === "未着手";
    const control = (field) => {
      if (!canEdit) return '<span class="readonly">' + (row[field] || "-") + "</span>";
      if (field === "verdict") return '<select data-id="' + row.id + '" data-field="verdict"><option>未着手</option><option>効いた</option><option>空振り</option></select>';
      return '<input data-id="' + row.id + '" data-field="' + field + '" value="' + String(row[field] || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;") + '">';
    };
    return '<tr class="' + (canEdit ? "todo" : "") + '">' +
      '<td class="id">' + row.id + "</td><td>" + row.media + '</td><td class="query">' + row.query + "</td>" +
      '<td>' + control("verdict") + "</td><td>" + control("result_count") + "</td><td>" + control("found_good") + "</td>" +
      '<td class="why">' + row.why + "</td><td>" + control("tried_at") + "</td></tr>";
  }).join("");
  visible.filter((row) => row.verdict === "未着手").forEach((row) => {
    const select = document.querySelector('select[data-id="' + row.id + '"]');
    if (select) select.value = row.verdict;
  });
  document.querySelectorAll("[data-field]").forEach((element) => element.addEventListener("change", (event) => {
    const row = state.rows.find((item) => item.id === event.target.dataset.id);
    row[event.target.dataset.field] = event.target.value;
    markDirty();
    render();
  }));
}
async function load() {
  setStatus("読み込み中...");
  const response = await fetch("/api/rows");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "読み込みに失敗しました");
  state.rows = data.rows;
  state.dirty = false;
  save.disabled = true;
  setStatus(state.rows.length + "行を読み込みました");
  render();
}
async function saveRows() {
  save.disabled = true;
  setStatus("保存中...");
  const response = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: state.rows }) });
  const data = await response.json();
  if (!response.ok) {
    save.disabled = false;
    setStatus(data.error || "保存できません", true);
    return;
  }
  state.dirty = false;
  setStatus("保存しました");
  await load();
}
filter.addEventListener("change", render);
todoFirst.addEventListener("change", render);
document.querySelector("#reload").addEventListener("click", () => load().catch((error) => setStatus(error.message, true)));
save.addEventListener("click", () => saveRows().catch((error) => { save.disabled = false; setStatus(error.message, true); }));
load().catch((error) => setStatus(error.message, true));
</script>
</body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(renderHtml());
                return;
            }
            if (req.method === "GET" && req.url === "/api/rows") {
                json(res, 200, { rows: await loadRows() });
                return;
            }
            if (req.method === "POST" && req.url === "/api/save") {
                const body = await readBody(req);
                if (!Array.isArray(body.rows)) {
                    json(res, 400, { error: "rows が配列ではありません" });
                    return;
                }
                const currentRows = await loadRows();
                const incoming = new Map(body.rows.map((row) => [row.id, row]));
                const problems = [];
                const rows = currentRows.map((row) => {
                    const proposed = incoming.get(row.id);
                    if (!proposed) return row;
                    const changedFields = editableFields.filter((field) => String(proposed[field] ?? "") !== row[field]);
                    if (row.verdict !== "未着手" && changedFields.length > 0) {
                        problems.push(`${row.id}：未着手以外の行は編集できません`);
                        return row;
                    }
                    return {
                        ...row,
                        ...Object.fromEntries(editableFields.map((field) => [field, String(proposed[field] ?? "")])),
                    };
                });
                problems.push(...validateRows(rows));
                if (problems.length > 0) {
                    json(res, 422, { error: `保存できません：${problems.join(" / ")}`, problems });
                    return;
                }
                await writeFile(csvPath, toCsv(rows), "utf8");
                json(res, 200, { rows });
                return;
            }
            res.writeHead(404);
            res.end("Not found");
        } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, instanceId };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "query-board",
            displayName: "検索式ボード",
            description: "data/queries.csv をフィルタ、並べ替え、検査付きで編集する表。",
            actions: [
                {
                    name: "read_rows",
                    description: "現在の data/queries.csv の行を返す",
                    handler: async () => ({ rows: await loadRows() }),
                },
                {
                    name: "save_row",
                    description: "id を指定した行を保存する。CIと同じ検査に失敗した場合は保存しない",
                    handler: async ({ input }) => {
                        const rows = await loadRows();
                        const values = input || {};
                        const row = rows.find((item) => item.id === input?.id);
                        if (!row) throw new CanvasError("not_found", `id が見つかりません：${input?.id}`);
                        const changedFields = editableFields.filter((field) =>
                            Object.hasOwn(values, field) && String(values[field] ?? "") !== row[field]);
                        if (row.verdict !== "未着手" && changedFields.length > 0) {
                            throw new CanvasError("not_editable", "未着手以外の行は編集できません");
                        }
                        Object.assign(row, Object.fromEntries(editableFields
                            .filter((field) => Object.hasOwn(values, field))
                            .map((field) => [field, String(values[field] ?? "")])));
                        const problems = validateRows(rows);
                        if (problems.length > 0) throw new CanvasError("validation_failed", problems.join(" / "));
                        await writeFile(csvPath, toCsv(rows), "utf8");
                        return row;
                    },
                },
            ],
            open: async (ctx) => {
                ensurePaths();
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "検索式ボード", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(resolve));
                }
            },
        }),
    ],
});
