from datetime import datetime
from typing import Optional

from django.http import HttpRequest
from ninja import NinjaAPI, Query, Schema
from ninja.errors import HttpError

from desk.auth_utils import bearer_auth, create_access_token, verify_password
from desk.models import OffsetSubmission, TraceLog, User
from desk.services import (
    IN_FLIGHT_STATUSES,
    GateRejected,
    normalize_tool_code,
    submit_through_gate,
)

api = NinjaAPI(title="数控刀补复核台", version="1.0")


class HealthOut(Schema):
    status: str


class LoginIn(Schema):
    username: str
    password: str


class LoginOut(Schema):
    token: str
    username: str
    role: str
    can_write: bool


class SubmissionIn(Schema):
    tool_code: str
    offset_um: int


class SubmissionOut(Schema):
    id: int
    tool_code: str
    offset_um: int
    status: str
    verdict: str
    submitted_by: Optional[str] = None
    created_at: datetime
    reviewed_at: Optional[datetime]


class TraceOut(Schema):
    id: int
    action: str
    tool_code: str
    offset_um: Optional[int]
    conflict_ids: list[int]
    submission_id: Optional[int]
    acted_by: Optional[str]
    detail: str
    created_at: datetime


class MonitorOut(Schema):
    tool_code: Optional[str]
    locked_tools: list[str]
    in_flight: list[SubmissionOut]
    history: list[SubmissionOut]
    traces: list[TraceOut]


class RejectOut(Schema):
    detail: str
    code: str
    tool_code: str
    conflict_ids: list[int]


class MessageOut(Schema):
    detail: str


class MonitorQuery(Schema):
    tool_code: Optional[str] = None


def _to_out(row: OffsetSubmission) -> SubmissionOut:
    return SubmissionOut(
        id=row.id,
        tool_code=row.tool_code,
        offset_um=row.offset_um,
        status=row.status,
        verdict=row.verdict or "",
        submitted_by=row.submitted_by.username if row.submitted_by else None,
        created_at=row.created_at,
        reviewed_at=row.reviewed_at,
    )


def _to_trace_out(row: TraceLog) -> TraceOut:
    return TraceOut(
        id=row.id,
        action=row.action,
        tool_code=row.tool_code,
        offset_um=row.offset_um,
        conflict_ids=list(row.conflict_ids or []),
        submission_id=row.submission_id,
        acted_by=row.acted_by.username if row.acted_by else None,
        detail=row.detail or "",
        created_at=row.created_at,
    )


@api.get("/health", response=HealthOut)
def health(request: HttpRequest):
    return {"status": "ok"}


@api.post("/auth/login", response=LoginOut)
def login(request: HttpRequest, body: LoginIn):
    try:
        user = User.objects.get(username=body.username)
    except User.DoesNotExist:
        raise HttpError(401, "用户名或密码错误")
    if not verify_password(body.password, user.password):
        raise HttpError(401, "用户名或密码错误")
    token = create_access_token(user)
    return {
        "token": token,
        "username": user.username,
        "role": user.role,
        "can_write": user.can_write,
    }


@api.get("/submissions", response=list[SubmissionOut], auth=bearer_auth)
def list_submissions(request: HttpRequest):
    rows = OffsetSubmission.objects.select_related("submitted_by").all()[:200]
    return [_to_out(r) for r in rows]


@api.get("/submissions/{submission_id}", response=SubmissionOut, auth=bearer_auth)
def get_submission(request: HttpRequest, submission_id: int):
    try:
        row = OffsetSubmission.objects.select_related("submitted_by").get(pk=submission_id)
    except OffsetSubmission.DoesNotExist:
        raise HttpError(404, "刀补记录不存在")
    return _to_out(row)


@api.post(
    "/submissions",
    response={201: SubmissionOut, 409: RejectOut, 403: MessageOut, 400: MessageOut},
    auth=bearer_auth,
)
def create_submission(request: HttpRequest, body: SubmissionIn):
    user: User = request.auth
    if not user.can_write:
        return 403, MessageOut(detail="当前账号只读，不能投单")
    raw = (body.tool_code or "").strip()
    if not raw:
        return 400, MessageOut(detail="刀具编号不能为空")
    try:
        row = submit_through_gate(
            user=user,
            tool_code=raw,
            offset_um=body.offset_um,
        )
    except GateRejected as rejected:
        # 整笔拒收：红弹窗据此点名全部冲突编号。
        return 409, RejectOut(
            detail=str(rejected),
            code="same_tool_in_flight",
            tool_code=rejected.tool_code,
            conflict_ids=rejected.conflict_ids,
        )
    except ValueError as exc:
        return 400, MessageOut(detail=str(exc))
    return 201, _to_out(row)


@api.get("/traces", response=list[TraceOut], auth=bearer_auth)
def list_traces(request: HttpRequest, filters: MonitorQuery = Query(...)):
    qs = TraceLog.objects.select_related("acted_by").all()
    tc = normalize_tool_code(filters.tool_code or "")
    if tc:
        qs = qs.filter(tool_code=tc)
    return [_to_trace_out(r) for r in qs[:200]]


@api.get("/monitor", response=MonitorOut, auth=bearer_auth)
def monitor(request: HttpRequest, filters: MonitorQuery = Query(...)):
    """同刀监视台：在途 / 历史 / 痕迹三块。只读账号也能看，不能投。"""
    tc = normalize_tool_code(filters.tool_code or "")

    in_flight_qs = OffsetSubmission.objects.filter(status__in=IN_FLIGHT_STATUSES)
    history_qs = OffsetSubmission.objects.filter(status=OffsetSubmission.Status.DONE)
    trace_qs = TraceLog.objects.all()
    if tc:
        in_flight_qs = in_flight_qs.filter(tool_code=tc)
        history_qs = history_qs.filter(tool_code=tc)
        trace_qs = trace_qs.filter(tool_code=tc)

    in_flight = list(in_flight_qs.select_related("submitted_by").order_by("created_at", "id"))
    history = list(
        history_qs.select_related("submitted_by").order_by("-created_at")[:100]
    )
    traces = list(trace_qs.select_related("acted_by")[:100])
    locked_tools = sorted({r.tool_code for r in in_flight})

    return MonitorOut(
        tool_code=tc or None,
        locked_tools=locked_tools,
        in_flight=[_to_out(r) for r in in_flight],
        history=[_to_out(r) for r in history],
        traces=[_to_trace_out(r) for r in traces],
    )
