import { createSignal, onMount, onCleanup, Show, For, createEffect } from "solid-js";
import {
  clearSession,
  createSubmission,
  fetchSubmission,
  fetchSubmissions,
  fetchToolMonitor,
  getUser,
  login,
  setSession,
} from "./api";

const statusLabel = {
  pending: "排队待复核",
  processing: "复核中",
  done: "已完成",
};

const roleLabel = {
  machinist: "操作员",
  auditor: "复核员",
};

function readHash() {
  const raw = (location.hash || "#/").replace(/^#/, "") || "/";
  let m = raw.match(/^\/detail\/(\d+)/);
  if (m) return { name: "detail", id: Number(m[1]), tool: "" };
  m = raw.match(/^\/monitor(?:\/([^/?]+))?/);
  if (m) return { name: "monitor", id: null, tool: m[1] ? decodeURIComponent(m[1]) : "" };
  return { name: "home", id: null, tool: "" };
}

function RejectModal(props) {
  const reject = () => props.reject;
  return (
    <Show when={reject()}>
      {(r) => (
        <div class="modal-mask" onClick={props.onClose}>
          <div class="reject-modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <h2>⛔ 同刀开单被拒收</h2>
            <p class="reject-line">
              刀具 <strong>{r().tool_code}</strong> 仍有未办结编号，全部办结前禁止再开第二张。
            </p>
            <div class="conflict-box">
              <span class="conflict-caption">冲突编号：</span>
              <For each={r().conflict_ids} fallback={<span class="hint">（无编号信息）</span>}>
                {(cid) => <span class="conflict-chip">#{cid}</span>}
              </For>
            </div>
            <p class="reject-detail">{r().message}</p>
            <div class="modal-actions">
              <button type="button" class="danger" onClick={props.onClose}>
                知道了
              </button>
              <button
                type="button"
                onClick={() => props.onGotoMonitor(r().tool_code)}
              >
                进同刀监视台
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

function HomePage(props) {
  const [rows, setRows] = createSignal([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [toolCode, setToolCode] = createSignal("");
  const [offsetUm, setOffsetUm] = createSignal("");

  async function loadRows() {
    try {
      setRows(await fetchSubmissions());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
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
      if (err.status === 409) {
        // 红弹窗点名冲突编号；弹窗不是页面，不占路由
        props.onRejected({
          tool_code: err.tool_code || toolCode(),
          conflict_ids: err.conflict_ids || [],
          message: err.message,
        });
      } else {
        setError(err.message);
      }
    }
  }

  onMount(() => {
    setLoading(true);
    loadRows();
    // 在途未办结时自动刷新，便于看到「办结」
    const timer = setInterval(() => {
      if (rows().some((r) => r.status !== "done")) loadRows();
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <>
      <Show when={props.user.can_write}>
        <section class="card">
          <h2>提交刀补</h2>
          <p class="hint">同一把刀若仍有未办结编号（排队或审中），整笔拒收并点名冲突编号。</p>
          <form onSubmit={handleSubmit} class="form inline">
            <label>
              刀具编号
              <input
                placeholder="如 T02"
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
            <button type="submit">提交待复核</button>
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
        <Show when={error()}>
          <div class="banner error">{error()}</div>
        </Show>
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
                  <td>
                    <span class={`status-badge status-${row.status}`}>
                      {statusLabel[row.status] || row.status}
                    </span>
                  </td>
                  <td class={row.verdict === "合格" ? "pass" : row.verdict === "超差" ? "fail" : ""}>
                    {row.verdict || "—"}
                  </td>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>
                    <button type="button" class="ghost" onClick={() => props.goDetail(row.id)}>
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
    </>
  );
}

function MonitorPage(props) {
  const [query, setQuery] = createSignal(props.tool || "");
  const [data, setData] = createSignal(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  async function load(tool) {
    if (!tool) return;
    try {
      setData(await fetchToolMonitor(tool));
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function submitSearch(e) {
    e.preventDefault();
    const t = query().trim();
    if (t) props.goMonitor(t);
  }

  // 路由带刀号进来（含红弹窗跳转）立即载入
  createEffect(() => {
    const t = props.tool;
    setQuery(t);
    if (t) {
      setLoading(true);
      load(t);
    } else {
      setData(null);
    }
  });

  onMount(() => {
    const timer = setInterval(() => {
      const t = (props.tool || "").trim();
      if (t) load(t);
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <section class="card monitor-card">
      <div class="toolbar">
        <h2>同刀监视台</h2>
        <form onSubmit={submitSearch} class="monitor-search">
          <input
            placeholder="输入刀号，如 T02"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button type="submit">监视这把刀</button>
        </form>
      </div>
      <p class="hint">三块并排：左为痕迹簿（拒收 / 放行逐笔留痕），中为在途（排队或审中），右为历史（已办结）。每 2 秒自动刷新。</p>
      <Show when={error()}>
        <div class="banner error">{error()}</div>
      </Show>
      <Show when={loading() && !data()}>
        <p class="hint">加载中…</p>
      </Show>
      <Show when={data()} fallback={<p class="hint">输入刀号开始监视。</p>}>
        {(d) => (
          <div class="monitor-grid">
            <div class="monitor-col col-watch">
              <h3>
                监视·痕迹簿
                <span class="col-count">{d().traces.length}</span>
              </h3>
              <Show when={!d().traces.length}>
                <p class="hint">该刀暂无开单痕迹</p>
              </Show>
              <For each={d().traces}>
                {(t) => (
                  <div class={`trace-item trace-${t.action}`}>
                    <div class="trace-head">
                      <span class={`trace-badge trace-badge-${t.action}`}>{t.action_label}</span>
                      <span class="trace-time">{new Date(t.created_at).toLocaleString()}</span>
                    </div>
                    <Show when={t.action === "rejected"}>
                      <div class="conflict-box">
                        <span class="conflict-caption">冲突编号：</span>
                        <For each={t.conflict_ids} fallback={<span class="hint">无</span>}>
                          {(cid) => <span class="conflict-chip">#{cid}</span>}
                        </For>
                      </div>
                    </Show>
                    <Show when={t.submission_id}>
                      <p class="trace-sub">开单编号：#{t.submission_id}</p>
                    </Show>
                    <p class="trace-meta">
                      {t.detail}
                      <Show when={t.actor}>（操作人：{t.actor}）</Show>
                    </p>
                  </div>
                )}
              </For>
            </div>

            <div class="monitor-col col-open">
              <h3>
                在途
                <span class="col-count">{d().open.length}</span>
              </h3>
              <Show when={!d().open.length}>
                <p class="hint ok-hint">在途已清空，允许同刀再开</p>
              </Show>
              <For each={d().open}>
                {(row) => (
                  <div class="open-item">
                    <div class="trace-head">
                      <strong>#{row.id}</strong>
                      <span class={`status-badge status-${row.status}`}>
                        {statusLabel[row.status] || row.status}
                      </span>
                    </div>
                    <p class="trace-meta">刀补 {row.offset_um} µm</p>
                    <p class="trace-time">{new Date(row.created_at).toLocaleString()} 进入</p>
                  </div>
                )}
              </For>
            </div>

            <div class="monitor-col col-history">
              <h3>
                历史
                <span class="col-count">{d().history.length}</span>
              </h3>
              <Show when={!d().history.length}>
                <p class="hint">该刀暂无办结记录</p>
              </Show>
              <For each={d().history}>
                {(row) => (
                  <div class="history-item">
                    <div class="trace-head">
                      <strong>#{row.id}</strong>
                      <span class={row.verdict === "合格" ? "pass" : "fail"}>
                        {row.verdict || "—"}
                      </span>
                    </div>
                    <p class="trace-meta">刀补 {row.offset_um} µm</p>
                    <p class="trace-time">
                      {row.reviewed_at ? new Date(row.reviewed_at).toLocaleString() : ""} 办结
                    </p>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

function DetailPage(props) {
  const [detail, setDetail] = createSignal(null);
  const [loading, setLoading] = createSignal(true);

  async function load(id) {
    setLoading(true);
    try {
      setDetail(await fetchSubmission(id));
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    if (props.id) load(props.id);
  });

  return (
    <section class="card">
      <div class="toolbar">
        <h2>刀补详情</h2>
        <button type="button" class="ghost" onClick={props.goHome}>
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
            <p>
              复核时间：
              {d().reviewed_at ? new Date(d().reviewed_at).toLocaleString() : "—"}
            </p>
          </div>
        )}
      </Show>
    </section>
  );
}

function App() {
  const [user, setUser] = createSignal(getUser());
  const [route, setRoute] = createSignal(readHash());
  const [error, setError] = createSignal("");
  const [reject, setReject] = createSignal(null);

  const [loginUser, setLoginUser] = createSignal("machinist");
  const [loginPass, setLoginPass] = createSignal("machine123456");

  function goHome() {
    location.hash = "#/";
  }
  function goDetail(id) {
    location.hash = `#/detail/${id}`;
  }
  function goMonitor(tool) {
    location.hash = tool ? `#/monitor/${encodeURIComponent(tool)}` : "#/monitor";
  }

  onMount(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLogout() {
    clearSession();
    setUser(null);
    setReject(null);
    goHome();
  }

  return (
    <Show
      when={user()}
      fallback={
        <div class="login-page">
          <section class="card login-card">
            <h1>数控刀补复核台</h1>
            <Show when={error()}>
              <div class="banner error">{error()}</div>
            </Show>
            <form onSubmit={handleLogin} class="form">
              <label>
                用户名
                <input
                  value={loginUser()}
                  onInput={(e) => setLoginUser(e.currentTarget.value)}
                />
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
            <p class="hint">操作员 machinist / machine123456；复核员 auditor / audit123456（只读，可看监视台）</p>
          </section>
        </div>
      }
    >
      {(u) => (
        <div class="app-shell">
          <aside class="sidebar">
            <div class="sidebar-brand">数控刀补复核台</div>
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
                  goMonitor(route().name === "monitor" ? route().tool : "");
                }}
              >
                同刀监视台
              </a>
            </nav>
            <div class="sidebar-foot">
              <p class="hint">{u().username}（{roleLabel[u().role] || u().role}）</p>
              <Show when={!u().can_write}>
                <p class="hint readonly-tag">只读账号 · 不能投单</p>
              </Show>
              <button type="button" class="ghost" onClick={handleLogout}>
                退出
              </button>
            </div>
          </aside>

          <main class="content">
            <Show when={route().name === "home"}>
              <HomePage user={u()} goDetail={goDetail} onRejected={setReject} />
            </Show>
            <Show when={route().name === "monitor"}>
              <MonitorPage tool={route().tool} goMonitor={goMonitor} />
            </Show>
            <Show when={route().name === "detail"}>
              <DetailPage id={route().id} goHome={goHome} />
            </Show>
          </main>

          <RejectModal
            reject={reject()}
            onClose={() => setReject(null)}
            onGotoMonitor={(tool) => {
              setReject(null);
              goMonitor(tool);
            }}
          />
        </div>
      )}
    </Show>
  );
}

export default App;
