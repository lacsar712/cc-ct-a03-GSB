from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from desk.models import OffsetSubmission, ToolTrace, User

OPEN_STATUSES = (
    OffsetSubmission.Status.PENDING,
    OffsetSubmission.Status.PROCESSING,
)


class ToolInFlightError(Exception):
    """同一把刀仍有未办结编号，整笔拒收。"""

    def __init__(self, tool_code: str, conflict_ids: list[int]):
        self.tool_code = tool_code
        self.conflict_ids = conflict_ids
        super().__init__(
            f"刀具 {tool_code} 存在未办结编号 {', '.join(map(str, conflict_ids))}，"
            "全部办结前禁止同刀再开第二张"
        )


def evaluate_verdict(offset_um: int) -> str:
    if abs(offset_um) <= settings.OFFSET_TOLERANCE_UM:
        return OffsetSubmission.Verdict.PASS
    return OffsetSubmission.Verdict.FAIL


def apply_verdict(submission: OffsetSubmission) -> None:
    submission.verdict = evaluate_verdict(submission.offset_um)
    submission.status = OffsetSubmission.Status.DONE
    submission.reviewed_at = timezone.now()
    submission.save(
        update_fields=["verdict", "status", "reviewed_at"],
    )


def open_submissions_for_tool(tool_code: str) -> list[OffsetSubmission]:
    """在途扫描：排队（待复核）或审中（复核中）任一命中即为冲突。"""
    return list(
        OffsetSubmission.objects.filter(
            tool_code=tool_code,
            status__in=OPEN_STATUSES,
        ).order_by("created_at", "id")
    )


def _reject(tool_code: str, conflict_ids: list[int], actor: User) -> None:
    """拒收落痕（在原子块之外，痕迹必须留下），随后整笔拒收。"""
    ToolTrace.objects.create(
        tool_code=tool_code,
        action=ToolTrace.Action.REJECTED,
        conflict_ids=conflict_ids,
        detail="在途未清，禁止同刀再开第二张",
        actor=actor,
    )
    raise ToolInFlightError(tool_code, conflict_ids)


def open_submission(tool_code: str, offset_um: int, actor: User) -> OffsetSubmission:
    """开单：先扫在途，命中则点名冲突编号并整笔拒收（留痕）；否则放行（留痕）。"""
    tool_code = tool_code.strip()

    # 第一关：在途扫描，排队或审中任一命中即拒收。
    conflicts = open_submissions_for_tool(tool_code)
    if conflicts:
        _reject(tool_code, [c.id for c in conflicts], actor)

    # 第二关：并发竞争时由部分唯一索引兜底（同一把刀至多一条在途）。
    try:
        with transaction.atomic():
            submission = OffsetSubmission.objects.create(
                tool_code=tool_code,
                offset_um=offset_um,
                submitted_by=actor,
                status=OffsetSubmission.Status.PENDING,
            )
            ToolTrace.objects.create(
                tool_code=tool_code,
                action=ToolTrace.Action.ACCEPTED,
                submission=submission,
                detail="在途已空，放行开单",
                actor=actor,
            )
    except IntegrityError:
        conflicts = open_submissions_for_tool(tool_code)
        _reject(tool_code, [c.id for c in conflicts], actor)

    return submission
