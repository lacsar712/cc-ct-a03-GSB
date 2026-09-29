import { createSignal, onMount, onCleanup, Show, For, createEffect } from "solid-js";
import {
  clearSession,
  createSubmission,
  fetchMonitor,
  fetchSubmission,
  fetchSubmissions,
  getUser,
  login,
  setSession,
} from "./api";

const statusLabel = {
  pending: "排队候审",
  processing: "审中",
  done: "已办结",
};

const roleLabel = {
  machinist: "操作员",
  auditor: "复核员（只读）",
};

const actionLabel = {
  accepted: "放行",
  rejected: "拒收",
};

function readHash() {
  const raw = (location.hash || "#/").replace(/^#/, "") || "/";
  let m = raw.match(/^\/detail\/(\d+)/);
  if (m) return { name: "detail", id: Number(m[1]) };
  m = raw.match(/^\/monitor/);
  if (m) return { name: "monitor", id: null };
  return { name: "home", id: null };
}

function RejectModal({ info, onClose }) {
  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal reject-modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <h2>⛔ 整笔拒收</h2>
        <p class="modal-line">
          刀具 <strong>{info().tool_code}</strong> 仍有未办结单，在途未清，禁止再开第二张。
        </p>
        <p class="modal-sub">冲突编号（排队候审 / 审中）：</p>
        <div class="conflict-tags">
          <For each={info().conflict_ids}>
            {(cid) => <span class="conflict-tag">#{cid}</span>}
          </For>
        </div>
        <p class="modal-detail">{info().detail}</p>
        <button type="button" class="danger" onClick={onClose}>
          知道了
        </button>
      </div>
    </div>
  );
}

function MonitorPage({ user, onReject, notifyError }) {
  const [toolInput, setToolInput] = createSignal("");
  const [appliedTool, setAppliedTool] = createSignal("");
  const [data, setData] = createSignal(null);
  const [toolCode, setToolCode] = createSignal("T02");
  const [offsetUm, setOffsetUm] = createSignal("");
  const [localError, setLocalError] = createSignal("");

  async function load(silent = false) {
    if (!silent) setLocalError("");
    try {
      setData(await fetchMonitor(appliedTool()));
    } catch (e) {
      if (!silent) notifyError(e.message);
    }
  }

  function applyFilter(e) {
    e.preventDefault();
    setAppliedTool(toolInput().trim().toUpperCase());
  }

  async function handleGateSubmit(e) {
    e.preventDefault();
    setLocalError("");
    try {
      await createSubmission(toolCode(), offsetUm());
      setOffsetUm(""); // 保留刀号：便于立刻再投同刀验证拒收
      await load(true);
    } catch (err) {
      if (err.status === 409 && err.data) {
        onReject(err.data);
      } else {
        setLocalError(err.message);
      }
    }
  }

  const timer = setInterval(() => load(true), 2000);
  onCleanup(() => clearInterval(timer));

  // appliedTool 变化即（重新）拉取；首次也会执行一次。
  createEffect(() => {
    appliedTool();
    load();
  });

  return (
    <section class="monitor">
      <div class="card monitor-head">
        <div>
          <h2>同刀监视台</h2>
          <p class="hint">同一把刀在途未清（排队候审或审中）即禁止再开第二张；全部办结后才放行。</p>
        </div>
        <form class="filter-form" onSubmit={applyFilter}>
          <input
            placeholder="按刀号回看，如 T02（留空看全部）"
            value={toolInput()}
            onInput={(e) => setToolInput(e.currentTarget.value)}
          />
          <button type="submit" class="ghost">
            回看
          </button>
        </form>
      </div>

      <Show when={user().can_write}>
        <div class="card">
          <form onSubmit={handleGateSubmit} class="form inline">
            <label>
              刀具编号
              <input value={toolCode()} onInput={(e) => setToolCode(e.currentTarget.value)} required />
            </label>
            <label>
              刀补（微米）
              <input
                type="number"
                value={offsetUm()}
                onInput={(e) => setOffsetUm(e.currentTarget.value)}
                required
              />
            </label>
            <button type="submit">投单（先扫在途）</button>
          </form>
          <Show when={localError()}>
            <p class="inline-error">{localError()}</p>
          </Show>
        </div>
      </Show>

      <div class="three-cols">
        <div class="card col">
          <h3>① 监视 · 在锁刀号</h3>
          <Show
            when={data()?.locked_tools?.length}
            fallback={<p class="hint">当前无在锁刀号，均可正常开单。</p>}
          >
            <ul class="lock-list">
              <For each={data()?.locked_tools || []}>
                {(tc) => (
                  <li class="lock-chip">
                    <span class="lock-dot" />
                    {tc}
                    <span class="lock-note">
                      在途 {data()?.in_flight.filter((r) => r.tool_code === tc).length || 0} 单
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={data()?.tool_code}>
            <p class="hint filter-tag">仅回看刀号：{data()?.tool_code}</p>
          </Show>
        </div>

        <div class="card col">
          <h3>② 在途（排队候审 / 审中）</h3>
          <Show
            when={data()?.in_flight?.length}
            fallback={<p class="hint">在途已清空。</p>}
          >
            <ul class="row-list">
              <For each={data()?.in_flight || []}>
                {(r) => (
                  <li>
                    <div class="row-line">
                      <strong>#{r.id}</strong> {r.tool_code} · {r.offset_um}µm
                    </div>
                    <span class={r.status === "processing" ? "badge processing" : "badge pending"}>
                      {statusLabel[r.status] || r.status}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        <div class="card col">
          <h3>③ 历史（已办结）</h3>
          <Show when={data()?.history?.length} fallback={<p class="hint">暂无办结记录。</p>}>
            <ul class="row-list compact">
              <For each={data()?.history || []}>
                {(r) => (
                  <li>
                    <div class="row-line">
                      <strong>#{r.id}</strong> {r.tool_code} · {r.offset_um}µm
                    </div>
                    <span class={r.verdict === "合格" ? "pass" : "fail"}>{r.verdict}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>

      <div class="card trace-book">
        <h3>痕迹簿 · 放行 / 拒收（可按刀号回看）</h3>
        <Show when={data()?.traces?.length} fallback={<p class="hint">暂无痕迹。</p>}>
          <ul class="trace-list">
            <For each={data()?.traces || []}>
              {(t) => (
                <li class={t.action === "rejected" ? "trace reject" : "trace accept"}>
                  <span class="trace-action">{actionLabel[t.action] || t.action}</span>
                  <span class="trace-meta">
                    {t.tool_code}
                    <Show when={t.offset_um != null}> · {t.offset_um}µm</Show>
                  </span>
                  <Show when={t.action === "rejected" && t.conflict_ids?.length}>
                    <span class="trace-conflict">
                      冲突编号：
                      <For each={t.conflict_ids}>
                        {(cid, i) => (
                          <>
                            {i() ? "、" : ""}#{cid}
                          </>
                        )}
                      </For>
                    </span>
                  </Show>
                  <span class="trace-time">{new Date(t.created_at).toLocaleTimeString()}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
}

function App() {
  const [user, setUser] = createSignal(getUser());
  const [rows, setRows] = createSignal([]);
  const [detail, setDetail] = createSignal(null);
  const [route, setRoute] = createSignal(readHash());
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [reject, setReject] = createSignal(null);

  const [loginUser, setLoginUser] = createSignal("machinist");
  const [loginPass, setLoginPass] = createSignal("machine123456");

  const [toolCode, setToolCode] = createSignal("");
  const [offsetUm, setOffsetUm] = createSignal("");

  function goHome() {
    location.hash = "#/";
  }
  function goMonitor() {
    location.hash = "#/monitor";
  }
  function goDetail(id) {
    location.hash = `#/detail/${id}`;
  }

  async function loadRows() {
    setLoading(true);
    setError("");
    try {
      setRows(await fetchSubmissions());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id) {
    setLoading(true);
    setError("");
    try {
      setDetail(await fetchSubmission(id));
    } catch (e) {
      setError(e.message);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  createEffect(() => {
    const r = route();
    if (!user()) return;
    if (r.name === "detail" && r.id) loadDetail(r.id);
    if (r.name === "home") loadRows();
  });

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    try {
      const data = await login(loginUser(), loginPass());
      setSession(data.token, {
        username: data.username,
        role: data.role,
        can_write: data.can_write,
      });
      setUser(getUser());
      goHome();
      await loadRows();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLogout() {
    clearSession();
    setUser(null);
    setRows([]);
    setDetail(null);
    setReject(null);
    goHome();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      await createSubmission(toolCode(), offsetUm());
      setToolCode("");
      setOffsetUm("");
      await loadRows();
    } catch (err) {
      if (err.status === 409 && err.data) {
        setReject(err.data); // 红弹窗点名冲突编号
      } else {
        setError(err.message);
      }
    }
  }

  return (
    <div class={user() ? "app-shell" : "page"}>
      <Show when={user()}>
        <aside class="sidebar">
          <div class="sidebar-brand">刀补复核台</div>
          <nav class="sidenav">
            <a
              href="#/"
              class={route().name === "home" ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                goHome();
              }}
            >
              复核总览
            </a>
            <a
              href="#/monitor"
              class={route().name === "monitor" ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                goMonitor();
              }}
            >
              同刀监视台
            </a>
          </nav>
          <div class="sidebar-foot">
            <p>
              {user().username}
              <br />
              <span class="hint">{roleLabel[user().role] || user().role}</span>
            </p>
            <button type="button" class="ghost block" onClick={handleLogout}>
              退出
            </button>
          </div>
        </aside>
      </Show>

      <main class="content">
        <Show when={error()}>
          <div class="banner error">{error()}</div>
        </Show>

        <Show
          when={user()}
          fallback={
            <section class="card">
              <h1 class="login-title">数控刀补复核台</h1>
              <h2>登录</h2>
              <form onSubmit={handleLogin} class="form">
                <label>
                  用户名
                  <input value={loginUser()} onInput={(e) => setLoginUser(e.currentTarget.value)} />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    value={loginPass()}
                    onInput={(e) => setLoginPass(e.currentTarget.value)}
                  />
                </label>
                <button type="submit">进入系统</button>
              </form>
              <p class="hint">操作员 machinist / machine123456；复核员 auditor / audit123456（只读）</p>
            </section>
          }
        >
          <Show when={route().name === "home"}>
            <Show when={user().can_write}>
              <section class="card">
                <h2>提交刀补</h2>
                <form onSubmit={handleSubmit} class="form inline">
                  <label>
                    刀具编号
                    <input
                      placeholder="如 T01"
                      value={toolCode()}
                      onInput={(e) => setToolCode(e.currentTarget.value)}
                      required
                    />
                  </label>
                  <label>
                    刀补（微米）
                    <input
                      type="number"
                      value={offsetUm()}
                      onInput={(e) => setOffsetUm(e.currentTarget.value)}
                      required
                    />
                  </label>
                  <button type="submit">投单（先扫在途）</button>
                </form>
              </section>
            </Show>

            <section class="card">
              <div class="toolbar">
                <h2>复核列表</h2>
                <button type="button" class="ghost" onClick={loadRows} disabled={loading()}>
                  {loading() ? "刷新中…" : "刷新"}
                </button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>编号</th>
                    <th>刀具</th>
                    <th>刀补 µm</th>
                    <th>状态</th>
                    <th>结论</th>
                    <th>提交时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(row) => (
                      <tr>
                        <td>#{row.id}</td>
                        <td>{row.tool_code}</td>
                        <td>{row.offset_um}</td>
                        <td>{statusLabel[row.status] || row.status}</td>
                        <td class={row.verdict === "合格" ? "pass" : row.verdict === "超差" ? "fail" : ""}>
                          {row.verdict || "—"}
                        </td>
                        <td>{new Date(row.created_at).toLocaleString()}</td>
                        <td>
                          <button type="button" class="ghost" onClick={() => goDetail(row.id)}>
                            详情
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={!rows().length && !loading()}>
                <p class="hint">暂无记录</p>
              </Show>
            </section>
          </Show>

          <Show when={route().name === "monitor"}>
            <MonitorPage user={user} onReject={setReject} notifyError={setError} />
          </Show>

          <Show when={route().name === "detail"}>
            <section class="card">
              <div class="toolbar">
                <h2>刀补详情</h2>
                <button type="button" class="ghost" onClick={goHome}>
                  返回总览
                </button>
              </div>
              <Show when={detail()} fallback={<p class="hint">{loading() ? "加载中…" : "未找到记录"}</p>}>
                {(d) => (
                  <div class="detail-grid">
                    <p>编号：#{d().id}</p>
                    <p>刀具：{d().tool_code}</p>
                    <p>刀补 µm：{d().offset_um}</p>
                    <p>状态：{statusLabel[d().status] || d().status}</p>
                    <p class={d().verdict === "合格" ? "pass" : d().verdict === "超差" ? "fail" : ""}>
                      结论：{d().verdict || "—"}
                    </p>
                    <p>提交时间：{new Date(d().created_at).toLocaleString()}</p>
                    <p>复核时间：{d().reviewed_at ? new Date(d().reviewed_at).toLocaleString() : "—"}</p>
                  </div>
                )}
              </Show>
            </section>
          </Show>
        </Show>
      </main>

      <Show when={reject()}>
        <RejectModal info={reject} onClose={() => setReject(null)} />
      </Show>
    </div>
  );
}

export default App;
