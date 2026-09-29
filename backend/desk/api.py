from datetime import datetime
from typing import Optional

from django.http import HttpRequest
from ninja import NinjaAPI, Schema
from ninja.errors import HttpError

from desk.auth_utils import bearer_auth, create_access_token, verify_password
from desk.models import OffsetSubmission, ToolTrace, User
from desk.services import ToolInFlightError, open_submission

api = NinjaAPI(title="数控刀补复核台", version="1.1")


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
    created_at: datetime
    reviewed_at: Optional[datetime]


class TraceOut(Schema):
    id: int
    tool_code: str
    action: str
    action_label: str
    submission_id: Optional[int]
    conflict_ids: list[int]
    detail: str
    actor: Optional[str]
    created_at: datetime


class MonitorOut(Schema):
    tool_code: str
    open: list[SubmissionOut]
    history: list[SubmissionOut]
    traces: list[TraceOut]


def _to_out(row: OffsetSubmission) -> SubmissionOut:
    return SubmissionOut(
        id=row.id,
        tool_code=row.tool_code,
        offset_um=row.offset_um,
        status=row.status,
        verdict=row.verdict or "",
        created_at=row.created_at,
        reviewed_at=row.reviewed_at,
    )


def _to_trace_out(row: ToolTrace) -> TraceOut:
    return TraceOut(
        id=row.id,
        tool_code=row.tool_code,
        action=row.action,
        action_label=row.get_action_display(),
        submission_id=row.submission_id,
        conflict_ids=list(row.conflict_ids or []),
        detail=row.detail,
        actor=row.actor.username if row.actor else None,
        created_at=row.created_at,
    )


@api.exception_handler(ToolInFlightError)
def tool_in_flight_handler(request: HttpRequest, exc: ToolInFlightError):
    """同刀在途冲突：409 整笔拒收，并点名冲突编号。"""
    return api.create_response(
        request,
        {
            "detail": str(exc),
            "tool_code": exc.tool_code,
            "conflict_ids": exc.conflict_ids,
        },
        status=409,
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
    rows = OffsetSubmission.objects.all()[:200]
    return [_to_out(r) for r in rows]


@api.get("/submissions/{submission_id}", response=SubmissionOut, auth=bearer_auth)
def get_submission(request: HttpRequest, submission_id: int):
    try:
        row = OffsetSubmission.objects.get(pk=submission_id)
    except OffsetSubmission.DoesNotExist:
        raise HttpError(404, "刀补记录不存在")
    return _to_out(row)


@api.post("/submissions", response=SubmissionOut, auth=bearer_auth)
def create_submission(request: HttpRequest, body: SubmissionIn):
    user: User = request.auth
    if not user.can_write:
        raise HttpError(403, "当前账号只读，不能提交刀补")
    tool_code = body.tool_code.strip()
    if not tool_code:
        raise HttpError(400, "刀具编号不能为空")
    # open_submission 先扫在途：排队或审中命中即抛 ToolInFlightError（409，整笔拒收）。
    row = open_submission(tool_code=tool_code, offset_um=body.offset_um, actor=user)
    return _to_out(row)


@api.get("/monitor", response=MonitorOut, auth=bearer_auth)
def tool_monitor(request: HttpRequest, tool_code: str):
    """同刀监视台：监视（痕迹簿）、在途、历史三块并排，按刀号回看。只读账号可调。"""
    tool_code = tool_code.strip()
    if not tool_code:
        raise HttpError(400, "刀具编号不能为空")
    open_rows = list(
        OffsetSubmission.objects.filter(
            tool_code=tool_code,
            status__in=[
                OffsetSubmission.Status.PENDING,
                OffsetSubmission.Status.PROCESSING,
            ],
        ).order_by("created_at", "id")
    )
    history_rows = list(
        OffsetSubmission.objects.filter(
            tool_code=tool_code,
            status=OffsetSubmission.Status.DONE,
        ).order_by("-reviewed_at", "-created_at")
    )
    trace_rows = list(
        ToolTrace.objects.filter(tool_code=tool_code)
        .select_related("actor")
        .order_by("-created_at", "-id")[:200]
    )
    return {
        "tool_code": tool_code,
        "open": [_to_out(r) for r in open_rows],
        "history": [_to_out(r) for r in history_rows],
        "traces": [_to_trace_out(r) for r in trace_rows],
    }
