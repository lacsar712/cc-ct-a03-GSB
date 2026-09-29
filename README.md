# 数控刀补复核台

操作员提交刀具编号与刀补微米值；后台 worker 用 PostgreSQL 行锁（`select_for_update(skip_locked=True)`）认领待复核记录，按绝对值是否不超过 12 微米给出「合格」或「超差」。

**同刀互斥开单**：同一把刀若仍有未办结单（状态为「排队候审」或「审中」，任一命中即在途），禁止再开第二张。开单前先扫在途，命中即**整笔拒收**并在红弹窗中**点名全部冲突编号**；待全部办结、在途清空后才允许同刀再开。放行与拒收各自写入「痕迹簿」，可按刀号回看。

## 技术栈

| 层 | 选型 |
|----|------|
| 后端 | Django 5 + django-ninja（ASGI / uvicorn） |
| 前端 | SolidJS + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |
| 鉴权 | JWT（python-jose），令牌存浏览器 localStorage |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3196 |
| 接口 | http://localhost:8196 |
| PostgreSQL | localhost:54396（库名 `cncoffset`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| machinist | machine123456 | 可投单（放行/拒收对其生效） |
| auditor | audit123456 | 只读：可看监视、在途、历史、痕迹簿，不能投 |

## 启动

```bash
cd projects/17-cnc-tool-offset-desk
docker compose up --build
```

健康检查：`GET http://localhost:8196/api/health` → `{"status":"ok"}`

环境变量：`PROCESSING_HOLD_SECONDS`（worker，默认 5）控制记录在「审中」区停留秒数，便于观察在途拦截；该状态仍占在途。

## 同刀规则与接口

- `POST /api/submissions`：开单前在同一事务内取 `pg_advisory_xact_lock(hashtext(刀号))` 串行化「扫描 + 插入」，杜绝并发双开。
  - 在途为空 → 201 放行，痕迹簿记一笔 `accepted`。
  - 在途命中 → **409** `{ code:"same_tool_in_flight", tool_code, conflict_ids:[...] }`，不产生任何记录，痕迹簿记一笔 `rejected`，含全部冲突编号。
- `GET /api/monitor?tool_code=T02`：同刀监视台数据，三块并排——
  1. **监视**：`locked_tools` 当前在锁刀号；
  2. **在途**：`in_flight` 排队候审 / 审中；
  3. **历史**：`history` 已办结；
  另含 `traces` 痕迹簿。刀号统一大写归一。
- `GET /api/traces?tool_code=T02`：痕迹簿按刀号回看（放行 / 拒收）。

## 验收

1. machinist 登录后，种子数据应显示刀具 T01 合格（刀补 5 µm）、T09 超差（刀补 20 µm）。
2. 提交一条新刀补后，状态先为「排队候审」，worker 认领后短暂停留在「审中」，随后「已办结」并给出结论。
3. **同刀拒收（乙刀）**：投一张 `T02`（先进候审区），立刻再投同刀 `T02` → 必须被拒收，红色弹窗点名冲突编号（第一张 `#id`），不产生第二张；痕迹簿出现一条「拒收」。
4. **办结后放行**：等第一张 T02 办结后，再投同刀 → 应收下（201）；历史出现旧单，在途清空；痕迹簿补一条「放行」。
5. 从左侧栏进入「同刀监视台」，可见监视 / 在途 / 历史三块并排（红弹窗只是提示，不是台本身）；在途未清时对应刀号出现在监视块。
6. auditor 登录后三块与痕迹簿都能看、可按刀号回看，但没有任何投单入口，直接调 `POST /api/submissions` 返回 403。

## 目录

```text
backend/          Django 工程（config/、desk/、worker.py）
frontend/         SolidJS 单页
docker-compose.yml
PRD.md
```
