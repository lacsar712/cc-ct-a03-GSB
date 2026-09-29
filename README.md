# 数控刀补复核台

操作员提交刀具编号与刀补微米值；后台 worker 用 PostgreSQL 行锁（`select_for_update(skip_locked=True)`）认领待复核记录，按绝对值是否不超过 12 微米给出「合格」或「超差」。

## 同刀在途拦截

- **一把刀至多一张在途单**：同一刀号只要还有未办结编号——排队「待复核」(`pending`) 或「复核中」(`processing`)——开单前先扫在途，任一条命中就**整笔拒收**，响应 `409` 并**点名冲突编号**；全部办结（`done`）后才允许同刀再开。
- 数据库层有部分唯一索引 `uniq_open_submission_per_tool`（仅约束 pending/processing）兜底并发竞争。
- **痕迹簿**：每次开单尝试都留痕，`accepted`（放行）/ `rejected`（拒收）各一条，拒收记录点名冲突编号，可按刀号回看。
- **同刀监视台**：侧栏进入，按刀号查询，三块并排——「监视·痕迹簿」「在途」「历史」，每 2 秒自动刷新。
- 投单遇在途冲突时弹**红色模态弹窗**点名冲突编号（弹窗不是独立页面），可一键跳转该刀监视台。
- **只读账号**（复核员 auditor）可看 复核总览 / 在途 / 历史 / 痕迹簿，不能投单（接口 `403`）。

## 技术栈

| 层 | 选型 |
|----|------|
| 后端 | Django 5 + django-ninja（ASGI / uvicorn） |
| 前端 | SolidJS + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16（部分唯一索引） |
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
| machinist | machine123456 | 可提交刀补 |
| auditor | audit123456 | 只读列表 |

## 启动

```bash
cd projects/17-cnc-tool-offset-desk
docker compose up --build
```

健康检查：`GET http://localhost:8196/api/health` → `{"status":"ok"}`

## 验收

1. machinist 登录后，种子数据应显示刀具 T01 合格（刀补 5 µm）、T09 超差（刀补 20 µm）。
2. 提交一条新刀补后，状态先为「待复核」，数秒内 worker 处理为「已完成」并给出结论。
3. auditor 登录后只能看列表，没有提交表单。
4. **同刀拦截**：投某刀（如 T02）后进候审区，立刻再投同刀 → 红色弹窗拒收并点名第一张编号（接口 `409 {detail, tool_code, conflict_ids}`）；第一张办结后再投 → 正常收下。
5. **监视台**：侧栏「同刀监视台」按刀号查看，痕迹簿（拒收/放行）、在途、历史三块并排；旧单办结后进历史、在途清空。
6. **只读**：auditor 可看监视台三块，投单返回 `403`。

后端测试（无需 Postgres，SQLite 内存库）：

```bash
cd backend
DJANGO_SETTINGS_MODULE=config.settings_test python manage.py test desk
```

## 接口增量

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/monitor?tool_code=T02` | 同刀监视台：`open`（在途）/ `history`（已办结）/ `traces`（痕迹簿） |
| POST | `/api/submissions` | 同刀在途冲突时返回 `409`，body 含 `conflict_ids` |

## 目录

```text
backend/          Django 工程（config/、desk/、worker.py）
frontend/         SolidJS 单页
docker-compose.yml
PRD.md
```
